/**
 * MCP tools for binary attachments (images, PDFs, audio, video).
 *
 * Large files go through create_attachment_upload: the tool returns a
 * single-use URL and the agent sends the raw bytes there out of band (see
 * uploads.ts). write_attachment takes base64 inline, for small files only,
 * because every byte of a tool argument is a model output token.
 */

import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { makeDeepLink } from "./deeplink.js";
import { AttachmentExistsError, AttachmentMoveIncompleteError, AttachmentTooLargeError, type VaultBackend } from "./vault-backend.js";
import type { SearchIndex } from "./search.js";
import { isPathWritable } from "./write-scope.js";
import { validateAttachmentPath, attachmentExtension } from "./attachment-path.js";
import { UPLOAD_ROUTE_PREFIX, type UploadRegistry } from "./uploads.js";
import { prepareImage, READABLE_IMAGE_EXTENSIONS, DEFAULT_MAX_EDGE, UnsupportedImageError } from "./image-read.js";
import { embedParameters, parseEmbedArgs, checkEmbedTarget, embedInNote, buildEmbed } from "./embed.js";

export const LIST_ATTACHMENTS_DEFAULT_LIMIT = 100;

export const ATTACHMENT_WRITE_TOOLS = ["create_attachment_upload", "write_attachment", "delete_attachment", "move_attachment"] as const;

export interface AttachmentToolOptions {
    vault: VaultBackend;
    searchIndex: SearchIndex;
    vaultName: string;
    readOnly: boolean;
    writeFolders: string[] | null;
    allowedExtensions: ReadonlySet<string>;
    /** Largest file accepted by the upload URL. */
    maxBytes: number;
    /** Largest decoded file accepted inline by write_attachment. */
    base64MaxBytes: number;
    registry: UploadRegistry;
    /** Public base URL of this server, used to build upload URLs. */
    baseUrl: string;
    /** Largest stored file read_attachment loads. Defaults to maxBytes. */
    readMaxBytes?: number;
}

/** Rough output-token cost of sending `bytes` as base64 (~3.3 characters per token). */
export function estimateBase64Tokens(bytes: number): number {
    return Math.ceil((Math.ceil(bytes / 3) * 4) / 3.3);
}

export function formatTokens(n: number): string {
    return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

export function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Decode base64 (optionally a `data:...;base64,` URL) strictly. Buffer.from
 * silently skips invalid characters, which would store a corrupt file.
 */
export function decodeBase64Strict(input: string): Uint8Array {
    let s = input.trim();
    const dataUrl = s.match(/^data:[^,]*;base64,/i);
    if (dataUrl) s = s.slice(dataUrl[0].length);
    s = s.replace(/\s+/g, "");
    if (s.length % 4 === 1 || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(s)) {
        throw new Error("content_base64 is not valid base64");
    }
    return new Uint8Array(Buffer.from(s, "base64"));
}

export function registerAttachmentTools(server: FastMCP, opts: AttachmentToolOptions) {
    const { vault, searchIndex, vaultName, readOnly, writeFolders, allowedExtensions, maxBytes, base64MaxBytes, registry } = opts;
    const readMaxBytes = opts.readMaxBytes ?? maxBytes;
    const readableExts = [...READABLE_IMAGE_EXTENSIONS].filter((e) => allowedExtensions.has(e)).sort();
    const baseUrl = opts.baseUrl.replace(/\/+$/, "");
    const extList = [...allowedExtensions].sort().join(", ");
    const writeScopeNote = writeFolders
        ? ` Writes are only allowed inside: ${writeFolders.map((f) => f + "/").join(", ")}.`
        : "";
    const embedNote = " Pass embed_in_note to place it in a note in the same call (with optional caption, width and position), or add ![[path]] yourself with edit_note.";

    /** Validate against the configured allowlist; returns an error message or null. */
    const checkPath = (path: string): string | null => {
        try {
            validateAttachmentPath(path, allowedExtensions);
            return null;
        } catch (err) {
            return (err as Error).message;
        }
    };
    const checkWritable = (path: string): string | null =>
        checkPath(path) ??
        (isPathWritable(path, writeFolders)
            ? null
            : `Write access denied: '${path}' is outside the writable folders (${writeFolders!.map((f) => f + "/").join(", ")}).`);

    server.addTool({
        name: "get_attachment_metadata",
        description:
            `Get size and timestamps of an attachment (${extList}) and the notes that embed or link it.`,
        parameters: z.object({
            path: z.string().describe("Vault-relative attachment path, e.g. 'Attachments/screenshot.png'"),
        }),
        execute: async ({ path }) => {
            const invalid = checkPath(path);
            if (invalid) return invalid;
            const info = await vault.getAttachmentInfo(path);
            if (!info) return `Attachment not found: ${path}`;
            const lines = [
                `**${path}**`,
                `Size: ${info.size} bytes (${formatBytes(info.size)})`,
                `Created: ${new Date(info.ctime).toISOString()}`,
                `Modified: ${new Date(info.mtime).toISOString()}`,
                `Embed: ![[${path}]]`,
            ];
            const backlinks = searchIndex.getAttachmentReferences(path);
            if (backlinks.length > 0) lines.push(`\nEmbedded or linked in: ${backlinks.join(", ")}`);
            lines.push(`\n[Open in Obsidian](${makeDeepLink(vaultName, path)})`);
            return lines.join("\n");
        },
    });

    server.addTool({
        name: "list_attachments",
        description:
            `List attachments (${extList}) with size, modification time and how many notes embed or link each. ` +
            "Use it to see where the vault keeps attachments and how they are named before adding one, to find an existing file to embed, " +
            "or with unreferenced=true to find files no note uses any more. Returns up to 100 by default.",
        parameters: z.object({
            folder: z.string().optional().describe("Only attachments under this folder, e.g. 'Attachments'."),
            name: z.string().optional().describe("Case-insensitive substring of the path, e.g. 'screenshot'."),
            extension: z.string().optional().describe("Only this file type, e.g. 'png' or 'pdf'."),
            unreferenced: z.boolean().optional().describe("Only attachments that no note embeds or links (by file name, so a name used anywhere counts as referenced)."),
            sort_by: z.enum(["name", "modified", "size"]).optional().describe("'name' (default), 'modified' (newest first) or 'size' (largest first)."),
            limit: z.coerce.number().int().positive().optional().describe(`Max entries, default ${LIST_ATTACHMENTS_DEFAULT_LIMIT}.`),
        }),
        execute: async ({ folder, name, extension, unreferenced, sort_by, limit }) => {
            const refs = searchIndex.attachmentReferenceMap();
            let items = searchIndex
                .listAttachments(folder)
                .filter((a) => allowedExtensions.has(attachmentExtension(a.path)))
                .map((a) => ({ ...a, refs: searchIndex.getAttachmentReferences(a.path, refs) }));
            const total = items.length;
            const filters: string[] = [];
            if (name) {
                const lower = name.toLowerCase();
                items = items.filter((a) => a.path.toLowerCase().includes(lower));
                filters.push(`name="${name}"`);
            }
            if (extension) {
                const ext = extension.toLowerCase().replace(/^\./, "");
                items = items.filter((a) => attachmentExtension(a.path) === ext);
                filters.push(`extension="${ext}"`);
            }
            if (unreferenced) {
                items = items.filter((a) => a.refs.length === 0);
                filters.push("unreferenced");
            }
            if (sort_by === "modified") items.sort((a, b) => b.mtime - a.mtime);
            if (sort_by === "size") items.sort((a, b) => b.size - a.size);

            const scope = folder ? ` in ${folder.replace(/\/+$/, "")}/` : "";
            const building = searchIndex.state === "ready" ? "" : " The index is still being built, so this list may be incomplete.";
            if (items.length === 0) {
                const why = filters.length ? ` match ${filters.join(", ")}` : "";
                return `No attachments${scope}${why}. ${total} attachments${scope} in the index.${building}`;
            }
            const cap = limit ?? LIST_ATTACHMENTS_DEFAULT_LIMIT;
            const shown = items.slice(0, cap);
            const header =
                `${items.length} attachment${items.length === 1 ? "" : "s"}${scope}` +
                (filters.length ? ` matching ${filters.join(", ")} (of ${total})` : "") +
                `, ${formatBytes(items.reduce((n, a) => n + a.size, 0))} in total` +
                (shown.length < items.length ? `, showing the first ${shown.length}` : "") +
                `.${building}`;
            const lines = shown.map((a) => {
                const date = a.mtime ? new Date(a.mtime).toISOString().slice(0, 16) : "";
                const used = a.refs.length === 0 ? "unreferenced" : a.refs.length === 1 ? `in ${a.refs[0]}` : `in ${a.refs.length} notes`;
                return `- ${date} ${formatBytes(a.size)} [${a.path}](${makeDeepLink(vaultName, a.path)}) — ${used}`;
            });
            return [header, ...lines].join("\n");
        },
    });

    /**
     * Find the attachment a path or bare embed name refers to. Obsidian
     * resolves `![[image 5.jpg]]` by file name anywhere in the vault, so a name
     * without a folder is looked up in the index when it isn't at the root.
     */
    const resolveAttachment = async (path: string): Promise<{ path: string } | { error: string }> => {
        const invalid = checkPath(path);
        if (invalid) return { error: invalid };
        if (await vault.getAttachmentInfo(path)) return { path };
        if (!path.includes("/")) {
            const lower = path.toLowerCase();
            const matches = searchIndex
                .listAttachments()
                .map((a) => a.path)
                .filter((p) => (p.split("/").pop() ?? "").toLowerCase() === lower);
            if (matches.length === 1) return { path: matches[0] };
            if (matches.length > 1) {
                return { error: `'${path}' matches ${matches.length} attachments; pass the full path: ${matches.slice(0, 20).join(", ")}` };
            }
        }
        const building = searchIndex.state === "ready" ? "" : " (the index is still being built; try again shortly)";
        return { error: `Attachment not found: ${path}${building}` };
    };

    if (readableExts.length > 0) server.addTool({
        name: "read_attachment",
        description:
            `Look at an image attachment (${readableExts.join(", ")}): returns the image itself so you can see it, plus its size and the notes that embed it. ` +
            "Accepts a full vault path or the bare file name used in an embed, e.g. 'image 5.jpg' from ![[image 5.jpg]]. " +
            `Large photos are scaled down to max_edge pixels on the long side (default ${DEFAULT_MAX_EDGE}) before they are sent.`,
        annotations: { readOnlyHint: true },
        parameters: z.object({
            path: z.string().describe("Vault-relative path or bare embed name, e.g. 'Attachments/IMG_7634.jpeg' or 'IMG_7634.jpeg'"),
            max_edge: z.coerce.number().int().min(200).max(4096).optional().describe(`Longest side in pixels after scaling, default ${DEFAULT_MAX_EDGE}. Raise it for small text on slides; lower it to save context.`),
        }),
        execute: async ({ path, max_edge }) => {
            const found = await resolveAttachment(path);
            if ("error" in found) return found.error;
            const resolved = found.path;
            const ext = attachmentExtension(resolved);
            if (!READABLE_IMAGE_EXTENSIONS.has(ext)) {
                return `read_attachment returns images only (${readableExts.join(", ")}); ${resolved} is .${ext}. Use get_attachment_metadata for its details.`;
            }
            let bytes: Uint8Array | null;
            try {
                bytes = await vault.readAttachment(resolved, { maxBytes: readMaxBytes });
            } catch (err) {
                if (err instanceof AttachmentTooLargeError) {
                    return `Attachment is ${Number.isFinite(err.size) ? formatBytes(err.size) : "of unknown size"}, over the ${formatBytes(readMaxBytes)} read limit (ATTACHMENT_READ_MAX_BYTES).`;
                }
                throw err;
            }
            if (!bytes) return `Attachment not found: ${resolved}`;
            let image;
            try {
                image = await prepareImage(resolved, bytes, max_edge ?? DEFAULT_MAX_EDGE);
            } catch (err) {
                if (err instanceof UnsupportedImageError) return `${resolved}: ${err.message}`;
                return `Could not decode ${resolved} as an image: ${(err as Error).message}`;
            }
            const refs = searchIndex.getAttachmentReferences(resolved);
            const dims = image.width && image.height ? `${image.width}×${image.height} px` : "";
            const lines = [
                `**${resolved}**${resolved !== path ? ` (resolved from '${path}')` : ""}`,
                `Stored: ${formatBytes(image.originalBytes)}; sent: ${[dims, image.mimeType, formatBytes(image.data.byteLength)].filter(Boolean).join(", ")}${image.resized ? " (scaled down)" : ""}`,
                refs.length > 0 ? `Embedded or linked in: ${refs.join(", ")}` : "Not embedded in any note.",
                `[Open in Obsidian](${makeDeepLink(vaultName, resolved)})`,
            ];
            return {
                content: [
                    { type: "text" as const, text: lines.join("\n") },
                    { type: "image" as const, data: image.data.toString("base64"), mimeType: image.mimeType },
                ],
            };
        },
    });

    if (readOnly) return;

    server.addTool({
        name: "create_attachment_upload",
        description:
            `Preferred way to add an image, PDF, audio or video file (${extList}) to the vault, up to ${formatBytes(maxBytes)}. ` +
            "Returns a one-time URL; send the raw file bytes to it with HTTP PUT, e.g. `curl -fsS -X PUT --data-binary @file.png '<url>'` (no other auth needed). " +
            "Use this whenever you can run a command or make an HTTP request (shell, code execution, a script): it takes milliseconds at any size, " +
            `while write_attachment spends output tokens on every byte. The URL works once and expires after ${Math.round(registry.ttlMs / 60000)} minutes.` +
            embedNote + writeScopeNote,
        parameters: z.object({
            path: z.string().describe("Vault-relative destination path, e.g. 'Attachments/screenshot.png'. The extension decides how Obsidian shows the file."),
            size: z.coerce.number().int().positive().optional().describe("Exact file size in bytes, if known. The upload is rejected when it differs, which catches truncated uploads."),
            overwrite: z.boolean().optional().describe("Replace an existing file at path. Default false."),
            ...embedParameters,
        }),
        execute: async ({ path, size, overwrite, ...embedArgs }) => {
            const denied = checkWritable(path);
            if (denied) return denied;
            const { request: embed, error: embedError } = parseEmbedArgs(embedArgs);
            if (embedError) return embedError;
            if (embed) {
                const bad = await checkEmbedTarget(vault, embed, writeFolders);
                if (bad) return bad;
            }
            if (size !== undefined && size > maxBytes) {
                return `File is ${formatBytes(size)}, over the upload limit of ${formatBytes(maxBytes)}.`;
            }
            if (!overwrite && (await vault.getAttachmentInfo(path))) {
                return `Attachment already exists: ${path}. Pass overwrite=true to replace it, or choose another path.`;
            }
            let handle;
            try {
                handle = registry.create({ path, overwrite: !!overwrite, expectedSize: size, maxBytes, embed: embed ?? undefined });
            } catch (err) {
                return (err as Error).message;
            }
            const url = `${baseUrl}${UPLOAD_ROUTE_PREFIX}${handle.token}`;
            return [
                `Upload URL for ${path} (single use, expires ${new Date(handle.expiresAt).toISOString()}, max ${formatBytes(size ?? maxBytes)}):`,
                url,
                "",
                "Send the raw bytes with PUT, for example:",
                `curl -fsS -X PUT --data-binary @/path/to/local/file '${url}'`,
                "",
                embed
                    ? `A 201 response with JSON {"path", "size", "embed", "embedded_in"} means the file is saved and embedded in ${embed.note} (${embed.position}). If "embed_error" is set instead, the file is saved but the note was not changed.`
                    : `A 201 response with JSON {"path", "size", "embed"} means the file is saved. Then embed it in a note with: ![[${path}]], or pass embed_in_note next time.`,
            ].join("\n");
        },
    });

    // base64 inflates by 4/3; allow a little slack for whitespace and a data: prefix.
    const base64MaxChars = Math.ceil(base64MaxBytes / 3) * 4 + 1024;
    server.addTool({
        name: "write_attachment",
        description:
            `Fallback for clients that cannot make HTTP requests: save a tiny attachment (${extList}) from base64, up to ${formatBytes(base64MaxBytes)}. ` +
            `A file at that limit is about ${formatTokens(estimateBase64Tokens(base64MaxBytes))} output tokens, minutes of generation, and one wrong character corrupts it. ` +
            "If you can run curl or any HTTP client, or the file exists on a disk you can read, use create_attachment_upload instead." +
            embedNote + writeScopeNote,
        parameters: z.object({
            path: z.string().describe("Vault-relative destination path, e.g. 'Attachments/diagram.png'"),
            content_base64: z.string().max(base64MaxChars).describe("File content as base64 (a data: URL is accepted too)"),
            overwrite: z.boolean().optional().describe("Replace an existing file at path. Default false."),
            ...embedParameters,
        }),
        execute: async ({ path, content_base64, overwrite, ...embedArgs }) => {
            const denied = checkWritable(path);
            if (denied) return denied;
            const { request: embed, error: embedError } = parseEmbedArgs(embedArgs);
            if (embedError) return embedError;
            if (embed) {
                const bad = await checkEmbedTarget(vault, embed, writeFolders);
                if (bad) return bad;
            }
            let data: Uint8Array;
            try {
                data = decodeBase64Strict(content_base64);
            } catch (err) {
                return (err as Error).message;
            }
            if (data.byteLength === 0) return "content_base64 is empty.";
            if (data.byteLength > base64MaxBytes) {
                return `File is ${formatBytes(data.byteLength)}, over the inline limit of ${formatBytes(base64MaxBytes)}. Use create_attachment_upload instead.`;
            }
            let ok: boolean;
            try {
                ok = await vault.writeAttachment(path, data, { overwrite: !!overwrite });
            } catch (err) {
                if (err instanceof AttachmentExistsError) {
                    return `Attachment already exists: ${path}. Pass overwrite=true to replace it, or choose another path.`;
                }
                throw err;
            }
            if (!ok) return `Failed to write attachment: ${path}`;
            searchIndex.updateAttachment(path, data.byteLength, Date.now());
            const saved = `Attachment saved: ${path} (${formatBytes(data.byteLength)})\nEmbed: ${buildEmbed(path, embed ?? {})}\n[Open in Obsidian](${makeDeepLink(vaultName, path)})`;
            if (!embed) return saved;
            const placed = await embedInNote(vault, searchIndex, vaultName, path, embed);
            return `${saved}\n${placed.message}`;
        },
    });

    server.addTool({
        name: "delete_attachment",
        description: "Delete an attachment from the vault. Notes that embed it are not changed." + writeScopeNote,
        parameters: z.object({
            path: z.string().describe("Vault-relative attachment path to delete"),
        }),
        execute: async ({ path }) => {
            const denied = checkWritable(path);
            if (denied) return denied;
            if (!(await vault.getAttachmentInfo(path))) return `Attachment not found: ${path}`;
            const ok = await vault.deleteAttachment(path);
            if (!ok) return `Failed to delete: ${path}`;
            searchIndex.removeAttachment(path);
            const backlinks = searchIndex.getAttachmentReferences(path);
            return backlinks.length > 0
                ? `Deleted: ${path}\nThese notes still embed or link it: ${backlinks.join(", ")}`
                : `Deleted: ${path}`;
        },
    });

    server.addTool({
        name: "move_attachment",
        description:
            "Move or rename an attachment. Embeds in notes are not updated; edit them afterwards if needed." + writeScopeNote,
        parameters: z.object({
            from: z.string().describe("Current path, e.g. 'Attachments/old.png'"),
            to: z.string().describe("New path, e.g. 'Attachments/2026/new.png'"),
            overwrite: z.boolean().optional().describe("Replace an existing file at the destination. Default false."),
        }),
        execute: async ({ from, to, overwrite }) => {
            const denied = checkWritable(from) ?? checkWritable(to);
            if (denied) return denied;
            const source = await vault.getAttachmentInfo(from);
            if (!source) return `Attachment not found: ${from}`;
            let ok: boolean;
            try {
                ok = await vault.moveAttachment(from, to, { overwrite: !!overwrite, maxBytes });
            } catch (err) {
                if (err instanceof AttachmentExistsError) {
                    return `Attachment already exists: ${to}. Pass overwrite=true to replace it.`;
                }
                if (err instanceof AttachmentTooLargeError) {
                    const size = Number.isFinite(err.size) ? `${formatBytes(err.size)}, over` : "of unknown size, so it may be over";
                    return `Attachment is ${size} the ${formatBytes(maxBytes)} limit for moving it here. Move it in Obsidian instead.`;
                }
                if (err instanceof AttachmentMoveIncompleteError) {
                    searchIndex.updateAttachment(to, source.size, Date.now());
                    return `Copied ${from} to ${to}, but could not delete ${from}. Both exist now; delete it with delete_attachment if needed.`;
                }
                throw err;
            }
            if (!ok) return `Failed to move: ${from} → ${to}`;
            searchIndex.removeAttachment(from);
            searchIndex.updateAttachment(to, source.size, Date.now());
            const backlinks = searchIndex.getAttachmentReferences(from);
            const note = backlinks.length > 0 ? `\nThese notes still embed the old path: ${backlinks.join(", ")}` : "";
            return `Moved: ${from} → ${to}\nEmbed: ![[${to}]]${note}\n[Open in Obsidian](${makeDeepLink(vaultName, to)})`;
        },
    });
}
