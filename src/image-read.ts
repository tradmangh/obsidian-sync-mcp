/**
 * Turn a stored image attachment into something a model can look at.
 *
 * Phone photos are often 3-5 MB and 4000+ px wide. Vision models downscale
 * anything above roughly 1568 px on the long edge anyway, so sending the
 * original only costs transfer time and gateway memory. When sharp is
 * available the image is auto-rotated (EXIF), shrunk to `maxEdge` and
 * re-encoded; without sharp the original bytes are passed through for the
 * formats MCP clients render natively.
 */

import { attachmentExtension } from "./attachment-path.js";

/** Extensions read_attachment returns as an image. */
export const READABLE_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(["avif", "bmp", "gif", "jpeg", "jpg", "png", "webp"]);

/** Formats clients display without conversion, by extension. */
const PASSTHROUGH_MIME: Record<string, string> = {
    gif: "image/gif",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
};

export const DEFAULT_MAX_EDGE = 1568;

export interface PreparedImage {
    data: Buffer;
    mimeType: string;
    width?: number;
    height?: number;
    /** Size of the stored original, in bytes. */
    originalBytes: number;
    resized: boolean;
}

type SharpFn = (input: Uint8Array, options?: { animated?: boolean; failOn?: string }) => any;
let sharpLoader: Promise<SharpFn | null> | undefined;

/** sharp is a native dependency; a missing or broken install degrades to passthrough instead of failing startup. */
export function loadSharp(): Promise<SharpFn | null> {
    sharpLoader ??= import("sharp").then(
        (m: any) => (m.default ?? m) as SharpFn,
        () => null,
    );
    return sharpLoader;
}

/** For tests: pretend sharp is (un)available. */
export function setSharpForTesting(fn: SharpFn | null | undefined): void {
    sharpLoader = fn === undefined ? undefined : Promise.resolve(fn);
}

export class UnsupportedImageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "UnsupportedImageError";
    }
}

export async function prepareImage(path: string, bytes: Uint8Array, maxEdge = DEFAULT_MAX_EDGE): Promise<PreparedImage> {
    const ext = attachmentExtension(path);
    if (!READABLE_IMAGE_EXTENSIONS.has(ext)) {
        throw new UnsupportedImageError(`Not an image this tool can return: .${ext || "(none)"}`);
    }
    const sharp = await loadSharp();
    if (!sharp) {
        const mimeType = PASSTHROUGH_MIME[ext];
        if (!mimeType) throw new UnsupportedImageError(`.${ext} needs conversion, but image processing (sharp) is not available on this server.`);
        return { data: Buffer.from(bytes), mimeType, originalBytes: bytes.byteLength, resized: false };
    }

    // Animated GIFs: keep the original when it is already small, so the animation survives.
    const img = sharp(bytes, { failOn: "none" });
    const meta = await img.metadata();
    const w: number | undefined = meta.width;
    const h: number | undefined = meta.pageHeight ?? meta.height;
    const longEdge = Math.max(w ?? 0, h ?? 0);
    const fits = longEdge > 0 && longEdge <= maxEdge;
    if (fits && PASSTHROUGH_MIME[ext] && (meta.orientation ?? 1) === 1) {
        return { data: Buffer.from(bytes), mimeType: PASSTHROUGH_MIME[ext], width: w, height: h, originalBytes: bytes.byteLength, resized: false };
    }

    let pipeline = img.rotate().resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true });
    // Screenshots and diagrams with transparency stay PNG (lossless, keeps text crisp); photos go to JPEG.
    const keepPng = meta.hasAlpha || ext === "png";
    pipeline = keepPng ? pipeline.png({ compressionLevel: 9, palette: false }) : pipeline.jpeg({ quality: 82, mozjpeg: true });
    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    return {
        data,
        mimeType: keepPng ? "image/png" : "image/jpeg",
        width: info.width,
        height: info.height,
        originalBytes: bytes.byteLength,
        resized: !fits,
    };
}
