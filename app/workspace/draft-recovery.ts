import type { NoteDraft } from "./helpers";
import type { Note } from "../../shared/types";
import { createUuid } from "../uuid";

export const DRAFT_RECOVERY_KEY_PREFIX = "xiangying_note_draft_recovery:";
// 正文上限是 1,000,000 个 UTF-16 code units，按最坏情况转成 UTF-8 后仍要留出
// JSON 转义余量，否则接近上限的长笔记会静默失去本地恢复副本。
const MAX_DRAFT_RECOVERY_BYTES = 8 * 1024 * 1024;
const LOCAL_STORAGE_DRAFT_MAX_BYTES = 128 * 1024;
const DRAFT_DATABASE_NAME = "xiangying-notes-drafts";
const DRAFT_STORE_NAME = "drafts";
const RECOVERY_UPDATED_AT_FIELD = "__xiangyingRecoveryUpdatedAt";
// A duplicated tab can inherit sessionStorage. Use a distinct ID for each
// loaded document and discover earlier copies when reopening a note.
const recoverySessionId = createUuid();
const recoveredKeys = new Map<string, string>();

const oversizedDraftWarnings = new Set<string>();

function warnOversizedDraft(noteId: string) {
  if (oversizedDraftWarnings.has(noteId)) return;
  if (oversizedDraftWarnings.size >= 50) oversizedDraftWarnings.clear();
  oversizedDraftWarnings.add(noteId);
  console.warn(
    `[draft] 笔记 ${noteId} 的草稿超过 ${MAX_DRAFT_RECOVERY_BYTES / 1024 / 1024} MiB，未写入本地恢复副本；请确认保存状态。`,
  );
}

let draftDatabasePromise: Promise<IDBDatabase | null> | null = null;
// Keep only short fingerprints for the last value seen in each store. Recovery
// contents can be large, so completed drafts are never retained in memory.
const knownRecoveries = new Map<string, { local?: string; indexed?: string }>();
const MAX_KNOWN_RECOVERIES = 256;
const pendingOperations = new Map<string, { token: symbol; fingerprint?: string }>();
type RecoveryRead = { invalidated: boolean };
const pendingRecoveryReads = new Map<string, Set<RecoveryRead>>();

function fingerprint(serialized: string) {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < serialized.length; index += 1) {
    const code = serialized.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ (code + index), 0x85ebca6b);
  }
  return `${serialized.length}:${(first >>> 0).toString(16)}:${(second >>> 0).toString(16)}`;
}

function rememberRecovery(key: string, store: "local" | "indexed", serialized: string | null) {
  const known = knownRecoveries.get(key) ?? {};
  if (serialized === null) delete known[store];
  else known[store] = fingerprint(serialized);
  if (known.local === undefined && known.indexed === undefined) knownRecoveries.delete(key);
  else {
    knownRecoveries.delete(key);
    knownRecoveries.set(key, known);
    while (knownRecoveries.size > MAX_KNOWN_RECOVERIES) {
      const oldestKey = knownRecoveries.keys().next().value;
      if (oldestKey === undefined) break;
      knownRecoveries.delete(oldestKey);
    }
  }
}

function invalidateRecoveryReads(key: string) {
  for (const read of pendingRecoveryReads.get(key) ?? []) read.invalidated = true;
}

function beginRecoveryRead(key: string) {
  const read: RecoveryRead = { invalidated: false };
  const reads = pendingRecoveryReads.get(key) ?? new Set<RecoveryRead>();
  reads.add(read);
  pendingRecoveryReads.set(key, reads);
  return {
    isCurrent: () => !read.invalidated,
    finish: () => {
      reads.delete(read);
      if (reads.size === 0) pendingRecoveryReads.delete(key);
    },
  };
}

function beginDraftOperation(key: string, serialized?: string) {
  const token = Symbol();
  const pendingFingerprint = serialized ? fingerprint(serialized) : undefined;
  const previousFingerprint = pendingOperations.get(key)?.fingerprint;
  pendingOperations.set(key, { token, fingerprint: pendingFingerprint });
  return {
    pendingFingerprints: [previousFingerprint, pendingFingerprint].filter(
      (value): value is string => Boolean(value),
    ),
    isCurrent: () => pendingOperations.get(key)?.token === token,
    finish: () => {
      if (pendingOperations.get(key)?.token === token) pendingOperations.delete(key);
    },
  };
}

function draftRecoveryNoteKey(userId: string, noteId: string) {
  return `${DRAFT_RECOVERY_KEY_PREFIX}${userId}:${noteId}`;
}

export function draftRecoveryStorageKey(userId: string, noteId: string) {
  return `${draftRecoveryNoteKey(userId, noteId)}:${recoverySessionId}`;
}

export function noteMatchesDraft(note: Note, draft: NoteDraft) {
  return (
    note.id === draft.id &&
    note.version >= draft.version &&
    note.title === (draft.title.trim() ? draft.title : "") &&
    note.contentMarkdown === draft.contentMarkdown &&
    note.notebookId === draft.notebookId &&
    note.isFavorite === draft.isFavorite &&
    Boolean(note.deletedAt) === Boolean(draft.deletedAt)
  );
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

function serializeStoredDraftRecovery(draft: NoteDraft) {
  try {
    const serialized = JSON.stringify({
      ...draft,
      [RECOVERY_UPDATED_AT_FIELD]: Date.now() * 1000 + Math.floor(Math.random() * 1000),
    });
    if (new TextEncoder().encode(serialized).byteLength > MAX_DRAFT_RECOVERY_BYTES) return null;
    return serialized;
  } catch {
    return null;
  }
}

function readLocalDraft(key: string) {
  try {
    return {
      readable: true,
      serialized: window.localStorage.getItem(key),
    };
  } catch {
    return { readable: false, serialized: null };
  }
}

function readLocalRecoveries(
  noteKey: string,
  records: Map<string, { local?: string; indexed?: string }>,
) {
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key && (key === noteKey || key.startsWith(`${noteKey}:`))) {
        const serialized = window.localStorage.getItem(key);
        if (serialized !== null) records.set(key, { local: serialized });
      }
    }
  } catch {}
}

function removeLocalDraftIfUnchanged(
  key: string,
  previous: { readable: boolean; serialized: string | null },
) {
  if (!previous.readable || previous.serialized === null) return;
  try {
    if (window.localStorage.getItem(key) !== previous.serialized) return;
    window.localStorage.removeItem(key);
    rememberRecovery(key, "local", null);
  } catch {}
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
        if (!request.result.objectStoreNames.contains(DRAFT_STORE_NAME))
          request.result.createObjectStore(DRAFT_STORE_NAME);
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

async function writeIndexedDraft(key: string, serialized: string, isCurrent: () => boolean) {
  const database = await openDraftDatabase();
  if (!database || !isCurrent()) return false;
  return await new Promise<boolean>((resolve) => {
    try {
      const transaction = database.transaction(DRAFT_STORE_NAME, "readwrite");
      transaction.objectStore(DRAFT_STORE_NAME).put(serialized, key);
      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => resolve(false);
      transaction.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

async function readIndexedDraft(key: string) {
  const database = await openDraftDatabase();
  if (!database) return null;
  return await new Promise<string | null>((resolve) => {
    try {
      const request = database
        .transaction(DRAFT_STORE_NAME, "readonly")
        .objectStore(DRAFT_STORE_NAME)
        .get(key);
      request.onsuccess = () => resolve(typeof request.result === "string" ? request.result : null);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function readIndexedRecoveries(
  noteKey: string,
  records: Map<string, { local?: string; indexed?: string }>,
) {
  const database = await openDraftDatabase();
  if (!database) return;
  await new Promise<void>((resolve) => {
    try {
      const transaction = database.transaction(DRAFT_STORE_NAME, "readonly");
      const request = transaction
        .objectStore(DRAFT_STORE_NAME)
        .openCursor(IDBKeyRange.bound(noteKey, `${noteKey}:\uffff`));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const key = cursor.key;
        if (
          typeof key === "string" &&
          (key === noteKey || key.startsWith(`${noteKey}:`)) &&
          typeof cursor.value === "string"
        ) {
          records.set(key, { ...records.get(key), indexed: cursor.value });
        }
        cursor.continue();
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => resolve();
      transaction.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function deleteIndexedDraft(
  key: string,
  matches: (serialized: string) => boolean,
  isCurrent: () => boolean,
) {
  const database = await openDraftDatabase();
  if (!database || !isCurrent()) return false;
  return await new Promise<boolean>((resolve) => {
    let removed = false;
    try {
      const transaction = database.transaction(DRAFT_STORE_NAME, "readwrite");
      const store = transaction.objectStore(DRAFT_STORE_NAME);
      const request = store.get(key);
      request.onsuccess = () => {
        if (!isCurrent() || typeof request.result !== "string" || !matches(request.result)) return;
        store.delete(key);
        removed = true;
      };
      transaction.oncomplete = () => resolve(removed);
      transaction.onerror = () => resolve(false);
      transaction.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

function parseDraftRecoveryRecord(serialized: string, noteId: string) {
  try {
    const value: unknown = JSON.parse(serialized);
    if (!isRecord(value)) return null;
    if (
      value.id !== noteId ||
      typeof value.title !== "string" ||
      value.title.length > 200 ||
      typeof value.contentMarkdown !== "string" ||
      value.contentMarkdown.length > 1_000_000 ||
      typeof value.notebookId !== "string" ||
      typeof value.isFavorite !== "boolean"
    )
      return null;
    if (
      typeof value.version !== "number" ||
      !Number.isSafeInteger(value.version) ||
      value.version < 1
    )
      return null;
    if (
      value.deletedAt !== null &&
      (typeof value.deletedAt !== "number" || !Number.isSafeInteger(value.deletedAt))
    )
      return null;
    const updatedAt = value[RECOVERY_UPDATED_AT_FIELD];
    return {
      draft: {
        id: value.id,
        version: value.version,
        title: value.title,
        contentMarkdown: value.contentMarkdown,
        notebookId: value.notebookId,
        isFavorite: value.isFavorite,
        deletedAt: value.deletedAt,
      },
      updatedAt: typeof updatedAt === "number" && Number.isSafeInteger(updatedAt) ? updatedAt : 0,
    };
  } catch {
    return null;
  }
}

export function parseDraftRecovery(serialized: string, noteId: string): NoteDraft | null {
  return parseDraftRecoveryRecord(serialized, noteId)?.draft ?? null;
}

export function writeDraftRecovery(userId: string | null, draft: NoteDraft) {
  if (!userId || typeof window === "undefined") return false;
  const key = draftRecoveryStorageKey(userId, draft.id);
  const serialized = serializeStoredDraftRecovery(draft);
  if (!serialized) {
    warnOversizedDraft(draft.id);
    return false;
  }
  invalidateRecoveryReads(draftRecoveryNoteKey(userId, draft.id));
  const operation = beginDraftOperation(key, serialized);
  const localBefore = readLocalDraft(key);
  const serializedFingerprint = fingerprint(serialized);
  const byteSize = new TextEncoder().encode(serialized).byteLength;
  if (byteSize > LOCAL_STORAGE_DRAFT_MAX_BYTES && canUseIndexedDb()) {
    return writeIndexedDraft(key, serialized, operation.isCurrent)
      .then((written) => {
        if (!operation.isCurrent()) return false;
        if (written) {
          rememberRecovery(key, "indexed", serialized);
          removeLocalDraftIfUnchanged(key, localBefore);
          return true;
        }
        try {
          window.localStorage.setItem(key, serialized);
          rememberRecovery(key, "local", serialized);
          return true;
        } catch {
          return false;
        }
      })
      .finally(operation.finish);
  }
  try {
    window.localStorage.setItem(key, serialized);
    rememberRecovery(key, "local", serialized);
    const expected = new Set([
      ...operation.pendingFingerprints,
      serializedFingerprint,
      knownRecoveries.get(key)?.indexed,
    ]);
    void deleteIndexedDraft(key, (value) => expected.has(fingerprint(value)), operation.isCurrent)
      .then((removed) => {
        if (removed && operation.isCurrent()) rememberRecovery(key, "indexed", null);
      })
      .finally(operation.finish);
    return true;
  } catch {
    return writeIndexedDraft(key, serialized, operation.isCurrent)
      .then((written) => {
        if (!written || !operation.isCurrent()) return false;
        rememberRecovery(key, "indexed", serialized);
        removeLocalDraftIfUnchanged(key, localBefore);
        return true;
      })
      .finally(operation.finish);
  }
}

export async function readDraftRecovery(userId: string, noteId: string) {
  return (await readRecovery(userId, noteId))?.draft ?? null;
}

export function readOwnedNoteDraft(userId: string, note: Note) {
  return readRecovery(userId, note.id, note);
}

function newestDraftRecovery(noteId: string, local: string | null, indexed: string | null) {
  const localRecord = local ? parseDraftRecoveryRecord(local, noteId) : null;
  const indexedRecord = indexed ? parseDraftRecoveryRecord(indexed, noteId) : null;
  if (localRecord && indexedRecord)
    return indexedRecord.updatedAt > localRecord.updatedAt ? indexedRecord : localRecord;
  return localRecord ?? indexedRecord;
}

async function readRecovery(userId: string, noteId: string, verifiedNote?: Note) {
  if (typeof window === "undefined") return null;
  const noteKey = draftRecoveryNoteKey(userId, noteId);
  const ownKey = draftRecoveryStorageKey(userId, noteId);
  const operation = beginRecoveryRead(noteKey);
  try {
    const records = new Map<string, { local?: string; indexed?: string }>();
    readLocalRecoveries(noteKey, records);
    await readIndexedRecoveries(noteKey, records);
    if (!operation.isCurrent()) return null;
    let selected: { key: string; draft: NoteDraft; updatedAt: number } | undefined;
    let otherDraft = false;
    for (const [key, { local, indexed }] of records) {
      const candidate = newestDraftRecovery(noteId, local ?? null, indexed ?? null);
      if (!candidate) continue;
      if (verifiedNote && noteMatchesDraft(verifiedNote, candidate.draft)) {
        clearDraftRecord(key, noteId, candidate.draft);
        continue;
      }
      if (selected) otherDraft = true;
      if (
        !selected ||
        key === ownKey ||
        (selected.key !== ownKey && candidate.updatedAt > selected.updatedAt)
      ) {
        selected = { key, ...candidate };
      }
    }
    if (selected) {
      const { local, indexed } = records.get(selected.key)!;
      rememberRecovery(selected.key, "local", local ?? null);
      rememberRecovery(selected.key, "indexed", indexed ?? null);
      if (selected.key !== ownKey) recoveredKeys.set(noteKey, selected.key);
      return { draft: selected.draft, otherDraft };
    }
    if (!verifiedNote) return null;

    // Legacy records have no owner. Only claim one after the server confirms
    // both the note and the server-assigned notebook IDs match.
    const legacyKey = `${DRAFT_RECOVERY_KEY_PREFIX}${noteId}`;
    const legacyLocal = readLocalDraft(legacyKey);
    const legacyIndexed = await readIndexedDraft(noteId);
    if (!operation.isCurrent()) return null;
    const legacy = newestDraftRecovery(noteId, legacyLocal.serialized, legacyIndexed);
    if (!legacy || legacy.draft.notebookId !== verifiedNote.notebookId) return null;
    if (noteMatchesDraft(verifiedNote, legacy.draft)) {
      removeLocalDraftIfUnchanged(legacyKey, legacyLocal);
      if (legacyIndexed)
        void deleteIndexedDraft(
          noteId,
          (serialized) => serialized === legacyIndexed,
          () => true,
        );
      return null;
    }
    if (await writeDraftRecovery(userId, legacy.draft)) {
      removeLocalDraftIfUnchanged(legacyKey, legacyLocal);
      if (legacyIndexed)
        void deleteIndexedDraft(
          noteId,
          (serialized) => serialized === legacyIndexed,
          () => true,
        );
    }
    return { draft: legacy.draft, otherDraft: false };
  } finally {
    operation.finish();
  }
}

export async function readMissingNoteDraft(
  userId: string,
  noteId: string,
  draft?: NoteDraft,
  snapshot?: Note | null,
): Promise<Note | null> {
  const recovered = draft ?? (await readDraftRecovery(userId, noteId));
  if (!recovered) return null;
  return {
    notebookName: "本地草稿",
    preview: "",
    tags: [],
    thumbnail: null,
    createdAt: 0,
    updatedAt: 0,
    ...(snapshot?.id === noteId ? snapshot : null),
    ...recovered,
    deletedAt: null,
  };
}

export function clearDraftRecovery(userId: string | null, noteId: string, savedDraft?: NoteDraft) {
  if (!userId || typeof window === "undefined") return;
  const noteKey = draftRecoveryNoteKey(userId, noteId);
  invalidateRecoveryReads(noteKey);
  const ownKey = draftRecoveryStorageKey(userId, noteId);
  const recoveredKey = recoveredKeys.get(noteKey);
  recoveredKeys.delete(noteKey);
  clearDraftRecord(ownKey, noteId, savedDraft, true);
  if (recoveredKey) clearDraftRecord(recoveredKey, noteId, savedDraft);
}

function clearDraftRecord(
  key: string,
  noteId: string,
  savedDraft?: NoteDraft,
  clearKnownCopies = !savedDraft,
) {
  const known = knownRecoveries.get(key);
  const pendingFingerprints = pendingOperations.get(key)?.fingerprint
    ? [pendingOperations.get(key)!.fingerprint!]
    : [];
  const operation = beginDraftOperation(key);
  // Another tab may have stored the same draft again with a different recovery timestamp.
  const matchesSavedDraft = savedDraft
    ? (serialized: string) => {
        const draft = parseDraftRecovery(serialized, noteId);
        return (
          draft !== null &&
          draft.version === savedDraft.version &&
          draft.title === savedDraft.title &&
          draft.contentMarkdown === savedDraft.contentMarkdown &&
          draft.notebookId === savedDraft.notebookId &&
          draft.isFavorite === savedDraft.isFavorite &&
          draft.deletedAt === savedDraft.deletedAt
        );
      }
    : null;
  const matches = (store: "local" | "indexed", value: string) => {
    if (matchesSavedDraft?.(value)) return true;
    if (!clearKnownCopies) return false;
    const hash = fingerprint(value);
    return hash === known?.[store] || pendingFingerprints.includes(hash);
  };
  if (matchesSavedDraft || (clearKnownCopies && (known?.local || pendingFingerprints.length))) {
    try {
      const serialized = window.localStorage.getItem(key);
      if (serialized && matches("local", serialized)) window.localStorage.removeItem(key);
      // A missing or changed value makes the previous fingerprint stale too.
      rememberRecovery(key, "local", null);
    } catch {}
  }
  if (!matchesSavedDraft && !(clearKnownCopies && (known?.indexed || pendingFingerprints.length))) {
    operation.finish();
    return;
  }
  void deleteIndexedDraft(key, (value) => matches("indexed", value), operation.isCurrent)
    .then((removed) => {
      if (removed && operation.isCurrent()) {
        rememberRecovery(key, "indexed", null);
      }
    })
    .finally(operation.finish);
}

export function clearAllDraftRecoveries() {
  if (typeof window === "undefined") return;
  for (const noteId of pendingRecoveryReads.keys()) invalidateRecoveryReads(noteId);
  pendingOperations.clear();
  knownRecoveries.clear();
  recoveredKeys.clear();
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
    try {
      database.transaction(DRAFT_STORE_NAME, "readwrite").objectStore(DRAFT_STORE_NAME).clear();
    } catch {}
  });
}
