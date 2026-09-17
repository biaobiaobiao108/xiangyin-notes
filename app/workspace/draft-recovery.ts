import type { NoteDraft } from "./helpers";

export const DRAFT_RECOVERY_KEY_PREFIX = "xiangying_note_draft_recovery:";
const MAX_DRAFT_RECOVERY_BYTES = 4 * 1024 * 1024;

export function draftRecoveryStorageKey(noteId: string) {
  return `${DRAFT_RECOVERY_KEY_PREFIX}${noteId}`;
}

export function serializeDraftRecovery(draft: NoteDraft) {
  try {
    const serialized = JSON.stringify(draft);
    if (new TextEncoder().encode(serialized).byteLength > MAX_DRAFT_RECOVERY_BYTES) return null;
    return serialized;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseDraftRecovery(serialized: string, noteId: string): NoteDraft | null {
  try {
    const value: unknown = JSON.parse(serialized);
    if (!isRecord(value)) return null;
    if (value.id !== noteId || typeof value.title !== "string" || value.title.length > 200 || typeof value.contentMarkdown !== "string" || value.contentMarkdown.length > 1_000_000 || typeof value.notebookId !== "string" || typeof value.isFavorite !== "boolean") return null;
    if (typeof value.version !== "number" || !Number.isSafeInteger(value.version) || value.version < 1) return null;
    if (value.deletedAt !== null && (typeof value.deletedAt !== "number" || !Number.isSafeInteger(value.deletedAt))) return null;
    return {
      id: value.id,
      version: value.version,
      title: value.title,
      contentMarkdown: value.contentMarkdown,
      notebookId: value.notebookId,
      isFavorite: value.isFavorite,
      deletedAt: value.deletedAt,
    };
  } catch {
    return null;
  }
}

export function writeDraftRecovery(draft: NoteDraft) {
  if (typeof window === "undefined") return;
  const serialized = serializeDraftRecovery(draft);
  if (!serialized) return;
  try {
    window.localStorage.setItem(draftRecoveryStorageKey(draft.id), serialized);
  } catch {
    // Recovery is best effort when storage is unavailable or full.
  }
}

export function readDraftRecovery(noteId: string) {
  if (typeof window === "undefined") return null;
  try {
    const serialized = window.localStorage.getItem(draftRecoveryStorageKey(noteId));
    return serialized ? parseDraftRecovery(serialized, noteId) : null;
  } catch {
    return null;
  }
}

export function clearDraftRecovery(noteId: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(draftRecoveryStorageKey(noteId));
  } catch {}
}

export function clearAllDraftRecoveries() {
  if (typeof window === "undefined") return;
  try {
    const keys: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(DRAFT_RECOVERY_KEY_PREFIX)) keys.push(key);
    }
    for (const key of keys) window.localStorage.removeItem(key);
  } catch {}
}
