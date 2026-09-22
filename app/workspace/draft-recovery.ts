import type { NoteDraft } from "./helpers";

export const DRAFT_RECOVERY_KEY_PREFIX = "xiangying_note_draft_recovery:";
const MAX_DRAFT_RECOVERY_BYTES = 4 * 1024 * 1024;
const LOCAL_STORAGE_DRAFT_MAX_BYTES = 128 * 1024;
const DRAFT_DATABASE_NAME = "xiangying-notes-drafts";
const DRAFT_STORE_NAME = "drafts";

let draftDatabasePromise: Promise<IDBDatabase | null> | null = null;

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

function canUseIndexedDb() {
  return typeof window !== "undefined" && typeof indexedDB !== "undefined";
}

function openDraftDatabase() {
  if (!canUseIndexedDb()) return Promise.resolve<IDBDatabase | null>(null);
  if (draftDatabasePromise) return draftDatabasePromise;
  draftDatabasePromise = new Promise((resolve) => {
    try {
      const request = indexedDB.open(DRAFT_DATABASE_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(DRAFT_STORE_NAME)) request.result.createObjectStore(DRAFT_STORE_NAME);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return draftDatabasePromise;
}

async function writeIndexedDraft(noteId: string, serialized: string) {
  const database = await openDraftDatabase();
  if (!database) return false;
  return await new Promise<boolean>((resolve) => {
    try {
      const transaction = database.transaction(DRAFT_STORE_NAME, "readwrite");
      transaction.objectStore(DRAFT_STORE_NAME).put(serialized, noteId);
      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => resolve(false);
      transaction.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

async function readIndexedDraft(noteId: string) {
  const database = await openDraftDatabase();
  if (!database) return null;
  return await new Promise<string | null>((resolve) => {
    try {
      const request = database.transaction(DRAFT_STORE_NAME, "readonly").objectStore(DRAFT_STORE_NAME).get(noteId);
      request.onsuccess = () => resolve(typeof request.result === "string" ? request.result : null);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function deleteIndexedDraft(noteId: string) {
  void openDraftDatabase().then((database) => {
    if (!database) return;
    try { database.transaction(DRAFT_STORE_NAME, "readwrite").objectStore(DRAFT_STORE_NAME).delete(noteId); } catch {}
  });
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
  const byteSize = new TextEncoder().encode(serialized).byteLength;
  if (byteSize > LOCAL_STORAGE_DRAFT_MAX_BYTES && canUseIndexedDb()) {
    void writeIndexedDraft(draft.id, serialized).then((written) => {
      if (written) {
        try { window.localStorage.removeItem(draftRecoveryStorageKey(draft.id)); } catch {}
        return;
      }
      try { window.localStorage.setItem(draftRecoveryStorageKey(draft.id), serialized); } catch {}
    });
    return;
  }
  try {
    window.localStorage.setItem(draftRecoveryStorageKey(draft.id), serialized);
    deleteIndexedDraft(draft.id);
  } catch {
    void writeIndexedDraft(draft.id, serialized);
  }
}

export async function readDraftRecovery(noteId: string) {
  if (typeof window === "undefined") return null;
  try {
    const serialized = window.localStorage.getItem(draftRecoveryStorageKey(noteId));
    if (serialized) {
      const draft = parseDraftRecovery(serialized, noteId);
      if (draft) return draft;
    }
  } catch {}
  const serialized = await readIndexedDraft(noteId);
  return serialized ? parseDraftRecovery(serialized, noteId) : null;
}

export function clearDraftRecovery(noteId: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(draftRecoveryStorageKey(noteId));
  } catch {}
  deleteIndexedDraft(noteId);
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
  void openDraftDatabase().then((database) => {
    if (!database) return;
    try { database.transaction(DRAFT_STORE_NAME, "readwrite").objectStore(DRAFT_STORE_NAME).clear(); } catch {}
  });
}
