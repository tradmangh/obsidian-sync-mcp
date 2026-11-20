import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { buildEmbed, insertBlock, parseEmbedArgs, embedInNote } from "./embed.js";
import { registerAttachmentTools } from "./attachment-tools.js";
import { UploadRegistry, mountAttachmentUpload, UPLOAD_ROUTE_PREFIX } from "./uploads.js";
import { memoryAttachments } from "./attachment-test-fixtures.js";
import { SUPPORTED_ATTACHMENT_EXTENSIONS } from "./attachment-path.js";
import { SearchIndex } from "./search.js";

describe("buildEmbed", () => {
    it("builds plain, sized and captioned embeds", () => {
        assert.equal(buildEmbed("A/x.png"), "![[A/x.png]]");
        assert.equal(buildEmbed("A/x.png", { width: 300 }), "![[A/x.png|300]]");
        assert.equal(buildEmbed("x.png", { caption: "Folie:\n Produktivität *AT*" }), "![[x.png]]\n*Folie: Produktivität \\*AT\\**");
    });
});

describe("insertBlock", () => {
    const note = "---\ntags: [a]\n---\n# Title\nline one\nline two";
    it("appends with a blank line", () => {
        assert.equal(insertBlock("text", "B", "append"), "text\n\nB\n");
        assert.equal(insertBlock("text\n", "B", "append"), "text\n\nB\n");
        assert.equal(insertBlock("", "B", "append"), "B\n");
    });
    it("prepends after frontmatter", () => {
        assert.equal(insertBlock(note, "B", "prepend"), "---\ntags: [a]\n---\nB\n\n# Title\nline one\nline two");
        assert.equal(insertBlock("x", "B", "prepend"), "B\n\nx");
    });
    it("inserts after the line containing a unique anchor", () => {
        assert.equal(insertBlock(note, "B", "after", "line one"), "---\ntags: [a]\n---\n# Title\nline one\n\nB\nline two");
        assert.equal(insertBlock(note, "B", "after", "two"), note + "\n\nB\n");
        assert.throws(() => insertBlock(note, "B", "after", "nope"), /not found/);
        assert.throws(() => insertBlock(note, "B", "after", "line"), /more than once/);
    });
});

describe("parseEmbedArgs", () => {
    it("validates combinations", () => {
        assert.deepEqual(parseEmbedArgs({}), { request: null });
        assert.match(parseEmbedArgs({ caption: "x" }).error!, /only apply together with embed_in_note/);
        assert.match(parseEmbedArgs({ embed_in_note: "a.md", position: "after" }).error!, /needs after_text/);
        assert.match(parseEmbedArgs({ embed_in_note: "a.md", after_text: "x" }).error!, /only used with position='after'/);
        assert.equal(parseEmbedArgs({ embed_in_note: "a.md" }).request!.position, "append");
    });
});

function toolSetup(writeFolders: string[] | null = null) {
    const { vault, files, notes } = memoryAttachments();
    const tools: any[] = [];
    const searchIndex = new SearchIndex();
    searchIndex.state = "ready";
    const registry = new UploadRegistry();
    registerAttachmentTools({ addTool: (t: any) => tools.push(t) } as any, {
        vault, searchIndex, vaultName: "V", readOnly: false, writeFolders,
        allowedExtensions: new Set(SUPPORTED_ATTACHMENT_EXTENSIONS),
        maxBytes: 1000, base64MaxBytes: 100, registry, baseUrl: "https://mcp.example.com",
    });
    const call = (name: string, args: any) => {
        const tool = tools.find((t) => t.name === name);
        return tool.execute(tool.parameters.parse(args));
    };
    return { call, files, notes, vault, searchIndex, registry };
}

const b64 = Buffer.from([1, 2, 3]).toString("base64");

describe("write_attachment with embed_in_note", () => {
    it("saves the file and embeds it after the anchor line, with caption", async () => {
        const { call, files, notes, searchIndex } = toolSetup();
        notes.set("Notes/talk.md", "# Talk\nSlides:\nend");
        const out = await call("write_attachment", {
            path: "Attachments/s1.png", content_base64: b64,
            embed_in_note: "Notes/talk.md", position: "after", after_text: "Slides:", caption: "Agenda", width: 400,
        });
        assert.ok(files.has("Attachments/s1.png"));
        assert.equal(notes.get("Notes/talk.md"), "# Talk\nSlides:\n\n![[Attachments/s1.png|400]]\n*Agenda*\nend");
        assert.match(out, /Embedded in Notes\/talk\.md \(after\)/);
        assert.deepEqual(searchIndex.getAttachmentReferences("Attachments/s1.png"), ["Notes/talk.md"]);
    });

    it("checks the note before writing, so a bad target leaves no orphan file", async () => {
        const { call, files, notes } = toolSetup(["Inbox"]);
        assert.match(await call("write_attachment", { path: "Inbox/a.png", content_base64: b64, embed_in_note: "Missing.md" }), /outside the writable folders/);
        notes.set("Inbox/n.md", "x");
        assert.match(await call("write_attachment", { path: "Inbox/a.png", content_base64: b64, embed_in_note: "Inbox/nope.md" }), /Note not found/);
        assert.match(await call("write_attachment", { path: "Inbox/a.png", content_base64: b64, embed_in_note: "Inbox/n.md", position: "after", after_text: "zzz" }), /not found/);
        assert.equal(files.size, 0);
    });
});

describe("create_attachment_upload with embed_in_note", () => {
    it("embeds once the PUT succeeds and reports it in the response", async () => {
        const { call, notes, vault, searchIndex, registry } = toolSetup();
        notes.set("Daily/d.md", "today");
        const msg: string = await call("create_attachment_upload", { path: "Att/p.jpg", embed_in_note: "Daily/d.md", caption: "Whiteboard" });
        assert.match(msg, /embedded in Daily\/d\.md/);
        const token = msg.match(/upload\/([A-Za-z0-9_-]{43})/)![1];
        const app = new Hono();
        mountAttachmentUpload(app, { registry, vault, onEmbed: (p, e) => embedInNote(vault, searchIndex, "V", p, e) });
        const res = await app.request(`${UPLOAD_ROUTE_PREFIX}${token}`, { method: "PUT", body: new Uint8Array([1, 2]), duplex: "half" } as RequestInit);
        assert.equal(res.status, 201);
        const body = await res.json();
        assert.equal(body.embedded_in, "Daily/d.md");
        assert.equal(notes.get("Daily/d.md"), "today\n\n![[Att/p.jpg]]\n*Whiteboard*\n");
    });

    it("still returns 201 with embed_error when the note vanished before the upload", async () => {
        const { call, notes, vault, searchIndex, registry, files } = toolSetup();
        notes.set("n.md", "x");
        const msg: string = await call("create_attachment_upload", { path: "p.png", embed_in_note: "n.md" });
        notes.delete("n.md");
        const token = msg.match(/upload\/([A-Za-z0-9_-]{43})/)![1];
        const app = new Hono();
        mountAttachmentUpload(app, { registry, vault, onEmbed: (p, e) => embedInNote(vault, searchIndex, "V", p, e) });
        const res = await app.request(`${UPLOAD_ROUTE_PREFIX}${token}`, { method: "PUT", body: new Uint8Array([1]), duplex: "half" } as RequestInit);
        assert.equal(res.status, 201);
        assert.match((await res.json()).embed_error, /no longer exists/);
        assert.ok(files.has("p.png"));
    });
});
