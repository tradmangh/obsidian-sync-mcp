import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { registerAttachmentTools, type AttachmentToolOptions } from "./attachment-tools.js";
import { UploadRegistry } from "./uploads.js";
import { memoryAttachments } from "./attachment-test-fixtures.js";
import { SUPPORTED_ATTACHMENT_EXTENSIONS } from "./attachment-path.js";
import { SearchIndex } from "./search.js";
import { AttachmentTooLargeError } from "./vault-backend.js";
import { prepareImage, setSharpForTesting } from "./image-read.js";

type Tool = { name: string; parameters: any; execute: (args: any) => Promise<any> };

function setup(overrides: Partial<AttachmentToolOptions> = {}) {
    const { vault, files, notes } = memoryAttachments();
    const tools: Tool[] = [];
    const searchIndex = new SearchIndex();
    searchIndex.state = "ready";
    registerAttachmentTools({ addTool: (t: Tool) => tools.push(t) } as any, {
        vault,
        searchIndex,
        vaultName: "V",
        readOnly: false,
        writeFolders: null,
        allowedExtensions: new Set(SUPPORTED_ATTACHMENT_EXTENSIONS),
        maxBytes: 10_000_000,
        base64MaxBytes: 100_000,
        registry: new UploadRegistry(),
        baseUrl: "https://mcp.example.com",
        ...overrides,
    });
    const call = (name: string, args: any) => {
        const tool = tools.find((t) => t.name === name)!;
        return tool.execute(tool.parameters.parse(args));
    };
    const put = (path: string, data: Uint8Array) => {
        files.set(path, { data, ctime: 1, mtime: 2 });
        searchIndex.updateAttachment(path, data.byteLength, 2);
    };
    return { call, put, files, notes, searchIndex, vault };
}

const png = (w: number, h: number) =>
    sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 30, b: 30 } } }).png().toBuffer().then((b) => new Uint8Array(b));
const jpeg = (w: number, h: number) =>
    sharp({ create: { width: w, height: h, channels: 3, background: { r: 10, g: 120, b: 200 } } }).jpeg().toBuffer().then((b) => new Uint8Array(b));

const imagePart = (res: any) => res.content.find((c: any) => c.type === "image");
const textPart = (res: any) => res.content.find((c: any) => c.type === "text").text as string;

describe("read_attachment", () => {
    after(() => setSharpForTesting(undefined));

    it("returns a small image unchanged, with text details", async () => {
        const { call, put, searchIndex } = setup();
        const data = await png(40, 20);
        put("Attachments/shot.png", data);
        searchIndex.update("Notes/a.md", "![[shot.png]]");
        const res = await call("read_attachment", { path: "Attachments/shot.png" });
        const img = imagePart(res);
        assert.equal(img.mimeType, "image/png");
        assert.deepEqual(new Uint8Array(Buffer.from(img.data, "base64")), data);
        const text = textPart(res);
        assert.match(text, /40×20 px/);
        assert.match(text, /Embedded or linked in: Notes\/a\.md/);
        assert.doesNotMatch(text, /scaled down/);
    });

    it("scales a large photo down to max_edge as JPEG", async () => {
        const { call, put } = setup();
        put("IMG_1.jpeg", await jpeg(4032, 3024));
        const res = await call("read_attachment", { path: "IMG_1.jpeg", max_edge: 1000 });
        const meta = await sharp(Buffer.from(imagePart(res).data, "base64")).metadata();
        assert.equal(imagePart(res).mimeType, "image/jpeg");
        assert.equal(meta.width, 1000);
        assert.equal(meta.height, 750);
        assert.match(textPart(res), /scaled down/);
    });

    it("resolves a bare embed name to the one attachment with that file name", async () => {
        const { call, put } = setup();
        put("Images/2026/image 5.jpg", await jpeg(10, 10));
        const res = await call("read_attachment", { path: "image 5.jpg" });
        assert.match(textPart(res), /\*\*Images\/2026\/image 5\.jpg\*\* \(resolved from 'image 5\.jpg'\)/);
    });

    it("asks for the full path when a bare name is ambiguous", async () => {
        const { call, put } = setup();
        put("A/x.png", await png(2, 2));
        put("B/x.png", await png(2, 2));
        assert.match(await call("read_attachment", { path: "x.png" }), /matches 2 attachments; pass the full path: A\/x\.png, B\/x\.png/);
    });

    it("reports missing files and non-image types as text", async () => {
        const { call, put } = setup();
        assert.equal(await call("read_attachment", { path: "nope.png" }), "Attachment not found: nope.png");
        put("doc.pdf", new Uint8Array([1, 2, 3]));
        assert.match(await call("read_attachment", { path: "doc.pdf" }), /returns images only/);
        assert.match(await call("read_attachment", { path: "../etc/passwd.png" }), /Invalid/);
    });

    it("reports a file over the read limit without loading it", async () => {
        const { call, put, vault } = setup({ readMaxBytes: 5 });
        put("big.png", new Uint8Array(10));
        vault.readAttachment = async (path: string, opts?: { maxBytes?: number }) => {
            throw new AttachmentTooLargeError(path, 10, opts!.maxBytes!, "reading");
        };
        assert.match(await call("read_attachment", { path: "big.png" }), /over the 5 B read limit/);
    });

    it("reports a corrupt image as text instead of throwing", async () => {
        const { call, put } = setup();
        put("broken.jpg", new Uint8Array([1, 2, 3, 4]));
        assert.match(await call("read_attachment", { path: "broken.jpg" }), /Could not decode broken\.jpg/);
    });
});

describe("prepareImage without sharp", () => {
    after(() => setSharpForTesting(undefined));

    it("passes natively displayable formats through and refuses ones that need conversion", async () => {
        setSharpForTesting(null);
        const data = new Uint8Array([9, 9, 9]);
        const out = await prepareImage("a.webp", data);
        assert.equal(out.mimeType, "image/webp");
        assert.equal(out.resized, false);
        await assert.rejects(prepareImage("a.bmp", data), /needs conversion/);
    });
});
