/**
 * Place an attachment embed (`![[path]]`) in a note, so saving an image and
 * showing it in a note is one tool call instead of two.
 *
 * Pure text helpers plus one function that applies them to a note through the
 * backend. The note is checked (exists, writable) before the attachment is
 * stored, so a typo in the note path doesn't leave an orphaned file behind.
 */

import { z } from "zod";
import type { VaultBackend } from "./vault-backend.js";
import type { SearchIndex } from "./search.js";
import { isPathWritable } from "./write-scope.js";
import { isValidNotePath } from "./note-path.js";
import { makeDeepLink } from "./deeplink.js";

export const EMBED_POSITIONS = ["append", "prepend", "after"] as const;
export type EmbedPosition = (typeof EMBED_POSITIONS)[number];

export interface EmbedRequest {
    note: string;
    position: EmbedPosition;
    /** Required for position "after": exact text, matching once, that the embed goes after (on a new line). */
    afterText?: string;
    /** Shown as an italic line under the image, and searchable as note text. */
    caption?: string;
    /** Display width in pixels (`![[path|300]]`). */
    width?: number;
}

/** Zod fields shared by the tools that can embed what they save. */
export const embedParameters = {
    embed_in_note: z.string().optional().describe("Also embed the saved file in this note, e.g. 'Daily/2026-11-20.md'. The note must exist."),
    position: z.enum(EMBED_POSITIONS).optional().describe("Where in the note: 'append' (default, end of note), 'prepend' (after frontmatter), or 'after' (after the line containing after_text)."),
    after_text: z.string().optional().describe("For position='after': exact text in the note, matching once; the embed is inserted on its own line after the line that contains it."),
    caption: z.string().max(500).optional().describe("Optional caption, written as an italic line under the image so it shows in Obsidian and is found by search."),
    width: z.coerce.number().int().positive().max(4000).optional().describe("Optional display width in pixels, e.g. 400 → ![[file.png|400]]."),
};

export interface EmbedArgs {
    embed_in_note?: string;
    position?: EmbedPosition;
    after_text?: string;
    caption?: string;
    width?: number;
}

/** Build an EmbedRequest from tool arguments, or an error message. Null request means "don't embed". */
export function parseEmbedArgs(args: EmbedArgs): { request: EmbedRequest | null; error?: string } {
    const { embed_in_note, position, after_text, caption, width } = args;
    if (!embed_in_note) {
        if (position || after_text || caption || width) {
            return { request: null, error: "position, after_text, caption and width only apply together with embed_in_note." };
        }
        return { request: null };
    }
    const pos = position ?? "append";
    if (pos === "after" && !after_text) return { request: null, error: "position='after' needs after_text." };
    if (pos !== "after" && after_text) return { request: null, error: "after_text is only used with position='after'." };
    return { request: { note: embed_in_note, position: pos, afterText: after_text, caption, width } };
}

/** `![[path]]`, `![[path|300]]`, optionally followed by an italic caption line. */
export function buildEmbed(path: string, { caption, width }: Pick<EmbedRequest, "caption" | "width"> = {}): string {
    const target = width ? `${path}|${width}` : path;
    const lines = [`![[${target}]]`];
    const cap = caption?.replace(/\s*\r?\n\s*/g, " ").trim();
    // Escape markdown emphasis markers so the caption can't break out of the italics.
    if (cap) lines.push(`*${cap.replace(/([*_])/g, "\\$1")}*`);
    return lines.join("\n");
}

/** Insert `block` into `note` text. Throws with a user-facing message when the anchor doesn't match exactly once. */
export function insertBlock(note: string, block: string, position: EmbedPosition, afterText?: string): string {
    if (position === "prepend") {
        const fm = note.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
        if (fm) return note.slice(0, fm[0].length) + block + "\n\n" + note.slice(fm[0].length);
        return block + "\n\n" + note;
    }
    if (position === "after") {
        const idx = note.indexOf(afterText!);
        if (idx === -1) throw new Error("after_text not found in the note.");
        if (note.indexOf(afterText!, idx + 1) !== -1) throw new Error("after_text matches more than once. Use a longer, unique string.");
        const lineEnd = note.indexOf("\n", idx + afterText!.length);
        if (lineEnd === -1) return note + "\n\n" + block + "\n";
        return note.slice(0, lineEnd + 1) + "\n" + block + "\n" + note.slice(lineEnd + 1);
    }
    if (note.length === 0) return block + "\n";
    const sep = note.endsWith("\n\n") ? "" : note.endsWith("\n") ? "\n" : "\n\n";
    return note + sep + block + "\n";
}

/** Check the target note before anything is written. Returns an error message or null. */
export async function checkEmbedTarget(vault: VaultBackend, request: EmbedRequest, writeFolders: string[] | null): Promise<string | null> {
    if (!isValidNotePath(request.note)) return `Invalid note path for embed_in_note: '${request.note}' (must be a vault-relative .md path).`;
    if (!isPathWritable(request.note, writeFolders)) {
        return `Write access denied: '${request.note}' is outside the writable folders (${writeFolders!.map((f) => f + "/").join(", ")}).`;
    }
    const existing = await vault.readNote(request.note);
    if (existing === null) return `Note not found for embed_in_note: ${request.note}`;
    if (request.position === "after") {
        try {
            insertBlock(existing, "", "after", request.afterText);
        } catch (err) {
            return (err as Error).message;
        }
    }
    return null;
}

/**
 * Embed `attachmentPath` in the requested note. Re-reads the note, since it may
 * have changed between the check and now (an upload can come minutes later).
 */
export async function embedInNote(
    vault: VaultBackend,
    searchIndex: SearchIndex,
    vaultName: string,
    attachmentPath: string,
    request: EmbedRequest,
): Promise<{ ok: boolean; message: string }> {
    const existing = await vault.readNote(request.note);
    if (existing === null) return { ok: false, message: `File saved, but the note to embed it in no longer exists: ${request.note}` };
    let updated: string;
    try {
        updated = insertBlock(existing, buildEmbed(attachmentPath, request), request.position, request.afterText);
    } catch (err) {
        return { ok: false, message: `File saved, but it was not embedded: ${(err as Error).message}` };
    }
    const ok = await vault.writeNote(request.note, updated);
    if (!ok) return { ok: false, message: `File saved, but editing the note failed: ${request.note}` };
    searchIndex.update(request.note, updated, Date.now());
    return { ok: true, message: `Embedded in ${request.note} (${request.position}).\n[Open note in Obsidian](${makeDeepLink(vaultName, request.note)})` };
}
