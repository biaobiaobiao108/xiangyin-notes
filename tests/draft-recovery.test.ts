import { describe, expect, test } from "bun:test";
import {
  noteMatchesDraft,
  parseDraftRecovery,
  serializeDraftRecovery,
} from "../app/workspace/draft-recovery";
import type { NoteDraft } from "../app/workspace/helpers";
import type { Note } from "../shared/types";

const draft: NoteDraft = {
  id: "note-1",
  version: 3,
  title: "恢复草稿",
  contentMarkdown: "正文",
  notebookId: "inbox-1",
  isFavorite: true,
  deletedAt: null,
};

describe("draft recovery serialization", () => {
  test("round-trips a valid draft and rejects another note id", () => {
    const serialized = serializeDraftRecovery(draft);
    expect(serialized).toBeString();
    expect(parseDraftRecovery(serialized!, draft.id)).toEqual(draft);
    expect(parseDraftRecovery(serialized!, "another-note")).toBeNull();
  });

  test("rejects malformed or oversized drafts", () => {
    expect(parseDraftRecovery("not-json", draft.id)).toBeNull();
    expect(parseDraftRecovery(JSON.stringify({ ...draft, version: 0 }), draft.id)).toBeNull();
    // 1,000,000 个中文字符（约 3 MiB）属于合法正文，必须能写入恢复副本。
    expect(
      serializeDraftRecovery({ ...draft, contentMarkdown: "字".repeat(1_000_000) }),
    ).toBeString();
    expect(
      serializeDraftRecovery({ ...draft, contentMarkdown: "字".repeat(3_000_000) }),
    ).toBeNull();
  });

  test("recognizes a committed draft and preserves differently edited drafts", () => {
    const committed: Note = {
      ...draft,
      version: draft.version + 1,
      notebookName: "收件箱",
      preview: "",
      tags: [],
      thumbnail: null,
      createdAt: 1,
      updatedAt: 2,
    };
    expect(noteMatchesDraft(committed, draft)).toBe(true);
    expect(noteMatchesDraft(committed, { ...draft, contentMarkdown: "后来编辑的正文" })).toBe(
      false,
    );
    expect(noteMatchesDraft(committed, { ...draft, notebookId: "other" })).toBe(false);
    expect(noteMatchesDraft(committed, { ...draft, version: committed.version + 1 })).toBe(false);
  });
});

test("older IndexedDB completions cannot remove, overwrite or restore a newer recovery", async () => {
  const {
    writeDraftRecovery,
    readDraftRecovery,
    readMissingNoteDraft,
    readOwnedNoteDraft,
    DRAFT_RECOVERY_KEY_PREFIX,
    clearDraftRecovery,
    clearAllDraftRecoveries,
    draftRecoveryStorageKey,
  } = await import("../app/workspace/draft-recovery");
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const indexedDbDescriptor = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const keyRangeDescriptor = Object.getOwnPropertyDescriptor(globalThis, "IDBKeyRange");
  const local = new Map<string, string>();
  const indexed = new Map<string, string>();
  const writes: Array<{ transaction: IDBTransaction; key: string; value: string }> = [];
  let finishRead: (() => void) | undefined;
  let holdRead = false;
  let localWritesFail = false;
  const flush = async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  };
  const database = {
    transaction(_store: string, mode: IDBTransactionMode) {
      const transaction = {
        oncomplete: null,
        onerror: null,
        onabort: null,
        objectStore() {
          return {
            put(value: string, key: string) {
              writes.push({ transaction: transaction as unknown as IDBTransaction, key, value });
            },
            delete(key: string) {
              indexed.delete(key);
              queueMicrotask(() =>
                (transaction as unknown as IDBTransaction).oncomplete?.({} as Event),
              );
            },
            clear() {
              indexed.clear();
            },
            get(key: string) {
              const request = { result: indexed.get(key), onsuccess: null as (() => void) | null };
              const finish = () => request.onsuccess?.();
              if (holdRead && mode === "readonly") finishRead = finish;
              else queueMicrotask(finish);
              return request;
            },
            openCursor({ lower, upper }: { lower: string; upper: string }) {
              const entries = [...indexed].filter(([key]) => key >= lower && key <= upper);
              const request = {
                result: null as { key: string; value: string; continue: () => void } | null,
                onsuccess: null as (() => void) | null,
              };
              const next = () => {
                const entry = entries.shift();
                request.result = entry
                  ? { key: entry[0], value: entry[1], continue: () => queueMicrotask(next) }
                  : null;
                request.onsuccess?.();
                if (!entry) (transaction as unknown as IDBTransaction).oncomplete?.({} as Event);
              };
              if (holdRead) finishRead = next;
              else queueMicrotask(next);
              return request;
            },
          };
        },
      };
      return transaction;
    },
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => local.get(key) ?? null,
        setItem: (key: string, value: string) => {
          if (localWritesFail) throw new DOMException("Quota exceeded", "QuotaExceededError");
          local.set(key, value);
        },
        removeItem: (key: string) => local.delete(key),
        get length() {
          return local.size;
        },
        key: (index: number) => [...local.keys()][index] ?? null,
      },
    },
  });
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: {
      open() {
        const request = { result: database, onsuccess: null as (() => void) | null };
        queueMicrotask(() => request.onsuccess?.());
        return request;
      },
    },
  });
  Object.defineProperty(globalThis, "IDBKeyRange", {
    configurable: true,
    value: { bound: (lower: string, upper: string) => ({ lower, upper }) },
  });
  const large = { ...draft, contentMarkdown: "字".repeat(50_000) };
  const completeWrite = (successful: boolean) => {
    const write = writes.shift()!;
    if (successful) {
      indexed.set(write.key, write.value);
      write.transaction.oncomplete?.({} as Event);
    } else {
      write.transaction.onerror?.({} as Event);
    }
  };
  try {
    writeDraftRecovery("owner", large);
    await flush();
    expect(writes).toHaveLength(1);
    writeDraftRecovery("owner", draft);
    // Finish the old transaction before the newer IndexedDB delete runs.
    completeWrite(true);
    await flush();
    expect(await readDraftRecovery("owner", draft.id)).toEqual(draft);
    expect(indexed.has(draftRecoveryStorageKey("owner", draft.id))).toBe(false);

    writeDraftRecovery("owner", large);
    await flush();
    writeDraftRecovery("owner", { ...draft, title: "更新后的草稿" });
    completeWrite(false);
    await flush();
    expect((await readDraftRecovery("owner", draft.id))?.title).toBe("更新后的草稿");

    writeDraftRecovery("owner", large);
    await flush();
    clearDraftRecovery("owner", draft.id);
    completeWrite(false);
    await flush();
    expect(await readDraftRecovery("owner", draft.id)).toBeNull();

    writeDraftRecovery("owner", large);
    await flush();
    clearAllDraftRecoveries();
    writeDraftRecovery("owner", draft);
    completeWrite(true);
    await flush();
    expect(local.has(draftRecoveryStorageKey("owner", draft.id))).toBe(true);
    expect(await readDraftRecovery("owner", draft.id)).toEqual(draft);

    // Supersede a write while the database-open promise is still pending.
    writeDraftRecovery("owner", large);
    writeDraftRecovery("owner", draft);
    await flush();
    expect(writes).toHaveLength(0);
    expect(await readDraftRecovery("owner", draft.id)).toEqual(draft);

    // A quota fallback must replace a stale localStorage copy once IndexedDB
    // has durably accepted the newer draft.
    const quotaDraft = { ...draft, id: "quota-note", title: "较新的草稿" };
    const quotaKey = draftRecoveryStorageKey("owner", quotaDraft.id);
    local.set(quotaKey, JSON.stringify({ ...quotaDraft, title: "旧草稿" }));
    localWritesFail = true;
    writeDraftRecovery("owner", quotaDraft);
    await flush();
    expect(writes).toHaveLength(1);
    completeWrite(true);
    await flush();
    expect(local.has(quotaKey)).toBe(false);
    expect(await readDraftRecovery("owner", quotaDraft.id)).toEqual(quotaDraft);
    localWritesFail = false;

    // Another tab can write after this tab observed an empty slot. Clearing a
    // successful save from this tab must not erase that unobserved recovery.
    const sharedDraft = { ...draft, id: "shared-note", title: "另一标签页未保存的内容" };
    const sharedKey = `${DRAFT_RECOVERY_KEY_PREFIX}owner:${sharedDraft.id}`;
    expect(await readDraftRecovery("owner", sharedDraft.id)).toBeNull();
    local.set(sharedKey, JSON.stringify(sharedDraft));
    clearDraftRecovery("owner", sharedDraft.id);
    await flush();
    expect(local.get(sharedKey)).toBe(JSON.stringify(sharedDraft));
    expect(await readDraftRecovery("owner", sharedDraft.id)).toEqual(sharedDraft);

    const indexedSharedDraft = {
      ...draft,
      id: "indexed-shared-note",
      title: "另一标签页的较大草稿",
    };
    expect(await readDraftRecovery("owner", indexedSharedDraft.id)).toBeNull();
    const indexedSharedKey = `${DRAFT_RECOVERY_KEY_PREFIX}owner:${indexedSharedDraft.id}:another-session`;
    indexed.set(indexedSharedKey, JSON.stringify(indexedSharedDraft));
    clearDraftRecovery("owner", indexedSharedDraft.id);
    await flush();
    expect(indexed.has(indexedSharedKey)).toBe(true);
    expect(await readDraftRecovery("owner", indexedSharedDraft.id)).toEqual(indexedSharedDraft);

    // Saving a recovered draft clears copies of that same draft even if another
    // tab refreshed its timestamp. A different draft from that tab is retained.
    const rewritten = { ...sharedDraft, __xiangyingRecoveryUpdatedAt: 100 };
    const newer = { ...sharedDraft, contentMarkdown: "另一标签页的新正文" };
    local.set(sharedKey, JSON.stringify(rewritten));
    indexed.set(sharedKey, JSON.stringify(newer));
    clearDraftRecovery("owner", sharedDraft.id, sharedDraft);
    await flush();
    expect(local.has(sharedKey)).toBe(false);
    expect(await readDraftRecovery("owner", sharedDraft.id)).toEqual(newer);
    clearDraftRecovery("owner", sharedDraft.id, newer);
    await flush();
    expect(indexed.has(sharedKey)).toBe(false);

    writeDraftRecovery("owner", draft);
    holdRead = true;
    const pendingRead = readDraftRecovery("owner", draft.id);
    await flush();
    expect(finishRead).toBeFunction();
    clearDraftRecovery("owner", draft.id);
    expect(local.has(draftRecoveryStorageKey("owner", draft.id))).toBe(false);

    holdRead = false;
    finishRead!();
    expect(await pendingRead).toBeNull();

    const legacyKey = `${DRAFT_RECOVERY_KEY_PREFIX}${draft.id}`;
    local.set(legacyKey, JSON.stringify(draft));
    expect(await readMissingNoteDraft("other", draft.id)).toBeNull();
    expect(await readMissingNoteDraft("owner", draft.id)).toBeNull();
    const owned: Note = {
      ...draft,
      contentMarkdown: "服务器正文",
      notebookName: "笔记本",
      preview: "",
      tags: [],
      thumbnail: null,
      createdAt: 1,
      updatedAt: 1,
    };
    expect(await readOwnedNoteDraft("other", { ...owned, notebookId: "different" })).toBeNull();
    expect(await readOwnedNoteDraft("owner", owned)).toEqual({ draft, otherDraft: false });
    expect(local.has(legacyKey)).toBe(false);
    expect(await readMissingNoteDraft("other", draft.id)).toBeNull();
    expect((await readMissingNoteDraft("owner", draft.id))?.contentMarkdown).toBe(
      draft.contentMarkdown,
    );

    writeDraftRecovery("other", { ...draft, contentMarkdown: "另一账号的草稿" });
    clearDraftRecovery("owner", draft.id);
    expect(await readDraftRecovery("owner", draft.id)).toBeNull();
    expect((await readDraftRecovery("other", draft.id))?.contentMarkdown).toBe("另一账号的草稿");

    const indexedDraft = { ...draft, id: "large-draft", contentMarkdown: large.contentMarkdown };
    const indexedWrite = writeDraftRecovery("owner", indexedDraft);
    await flush();
    completeWrite(true);
    expect(await indexedWrite).toBe(true);
    expect(await readDraftRecovery("other", indexedDraft.id)).toBeNull();
    expect(await readDraftRecovery("owner", indexedDraft.id)).toEqual(indexedDraft);

    const parallelNote = { ...owned, id: "parallel-note" };
    const remoteTab = { ...draft, id: parallelNote.id, contentMarkdown: "另一标签页独立草稿" };
    const thisTab = { ...remoteTab, contentMarkdown: "本标签页独立草稿" };
    const remoteKey = `${DRAFT_RECOVERY_KEY_PREFIX}owner:${parallelNote.id}:another-session`;
    indexed.set(remoteKey, JSON.stringify(remoteTab));
    writeDraftRecovery("owner", thisTab);
    expect(await readOwnedNoteDraft("owner", parallelNote)).toEqual({
      draft: thisTab,
      otherDraft: true,
    });
    clearDraftRecovery("owner", parallelNote.id, thisTab);
    expect(await readOwnedNoteDraft("owner", { ...parallelNote, ...thisTab })).toEqual({
      draft: remoteTab,
      otherDraft: false,
    });
    clearDraftRecovery("owner", parallelNote.id);
    await flush();
    expect(await readDraftRecovery("owner", parallelNote.id)).toBeNull();
  } finally {
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
    else Reflect.deleteProperty(globalThis, "window");
    if (indexedDbDescriptor) Object.defineProperty(globalThis, "indexedDB", indexedDbDescriptor);
    else Reflect.deleteProperty(globalThis, "indexedDB");
    if (keyRangeDescriptor) Object.defineProperty(globalThis, "IDBKeyRange", keyRangeDescriptor);
    else Reflect.deleteProperty(globalThis, "IDBKeyRange");
  }
});
