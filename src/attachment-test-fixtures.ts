// Shared test fixture for the attachment tests (not a test file itself).
import { AttachmentExistsError, type VaultBackend, type AttachmentInfo, type WriteOptions } from "./vault-backend.js";

/** In-memory attachment store, plus a minimal note store for the embed tests. */
export function memoryAttachments() {
    const files = new Map<string, { data: Uint8Array; ctime: number; mtime: number }>();
    const notes = new Map<string, string>();
    const vault = {
        readNote: async (path: string) => notes.get(path) ?? null,
        writeNote: async (path: string, content: string) => {
            notes.set(path, content);
            return true;
        },
        writeAttachment: async (path: string, data: Uint8Array, { overwrite = false }: WriteOptions = {}) => {
            if (files.has(path) && !overwrite) throw new AttachmentExistsError(path);
            const ctime = files.get(path)?.ctime ?? 1;
            files.set(path, { data, ctime, mtime: 2 });
            return true;
        },
        deleteAttachment: async (path: string) => files.delete(path),
        moveAttachment: async (from: string, to: string, { overwrite = false }: WriteOptions = {}) => {
            const f = files.get(from);
            if (!f) return false;
            if (from === to) return true;
            if (files.has(to) && !overwrite) throw new AttachmentExistsError(to);
            files.set(to, f);
            files.delete(from);
            return true;
        },
        readAttachment: async (path: string) => files.get(path)?.data ?? null,
        getAttachmentInfo: async (path: string): Promise<AttachmentInfo | null> => {
            const f = files.get(path);
            return f ? { path, size: f.data.byteLength, ctime: f.ctime, mtime: f.mtime } : null;
        },
    } as unknown as VaultBackend;
    return { vault, files, notes };
}
