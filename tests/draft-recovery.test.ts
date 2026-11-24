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
    clearDraftRecovery,
    clearAllDraftRecoveries,
    draftRecoveryStorageKey,
  } = await import("../app/workspace/draft-recovery");
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const indexedDbDescriptor = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
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
    writeDraftRecovery(large);
    await flush();
    expect(writes).toHaveLength(1);
    writeDraftRecovery(draft);
    // Finish the old transaction before the newer IndexedDB delete runs.
    completeWrite(true);
    await flush();
    expect(await readDraftRecovery(draft.id)).toEqual(draft);
    expect(indexed.has(draft.id)).toBe(false);

    writeDraftRecovery(large);
    await flush();
    writeDraftRecovery({ ...draft, title: "更新后的草稿" });
    completeWrite(false);
    await flush();
    expect((await readDraftRecovery(draft.id))?.title).toBe("更新后的草稿");

    writeDraftRecovery(large);
    await flush();
    clearDraftRecovery(draft.id);
    completeWrite(false);
    await flush();
    expect(await readDraftRecovery(draft.id)).toBeNull();

    writeDraftRecovery(large);
    await flush();
    clearAllDraftRecoveries();
    writeDraftRecovery(draft);
    completeWrite(true);
    await flush();
    expect(local.has(draftRecoveryStorageKey(draft.id))).toBe(true);
    expect(await readDraftRecovery(draft.id)).toEqual(draft);

    // Supersede a write while the database-open promise is still pending.
    writeDraftRecovery(large);
    writeDraftRecovery(draft);
    await flush();
    expect(writes).toHaveLength(0);
    expect(await readDraftRecovery(draft.id)).toEqual(draft);

    // A quota fallback must replace a stale localStorage copy once IndexedDB
    // has durably accepted the newer draft.
    const quotaDraft = { ...draft, id: "quota-note", title: "较新的草稿" };
    const quotaKey = draftRecoveryStorageKey(quotaDraft.id);
    local.set(quotaKey, JSON.stringify({ ...quotaDraft, title: "旧草稿" }));
    localWritesFail = true;
    writeDraftRecovery(quotaDraft);
    await flush();
    expect(writes).toHaveLength(1);
    completeWrite(true);
    await flush();
    expect(local.has(quotaKey)).toBe(false);
    expect(await readDraftRecovery(quotaDraft.id)).toEqual(quotaDraft);
    localWritesFail = false;

    // Another tab can write after this tab observed an empty slot. Clearing a
    // successful save from this tab must not erase that unobserved recovery.
    const sharedDraft = { ...draft, id: "shared-note", title: "另一标签页未保存的内容" };
    const sharedKey = draftRecoveryStorageKey(sharedDraft.id);
    expect(await readDraftRecovery(sharedDraft.id)).toBeNull();
    local.set(sharedKey, JSON.stringify(sharedDraft));
    clearDraftRecovery(sharedDraft.id);
    await flush();
    expect(local.get(sharedKey)).toBe(JSON.stringify(sharedDraft));
    expect(await readDraftRecovery(sharedDraft.id)).toEqual(sharedDraft);

    const indexedSharedDraft = {
      ...draft,
      id: "indexed-shared-note",
      title: "另一标签页的较大草稿",
    };
    expect(await readDraftRecovery(indexedSharedDraft.id)).toBeNull();
    indexed.set(indexedSharedDraft.id, JSON.stringify(indexedSharedDraft));
    clearDraftRecovery(indexedSharedDraft.id);
    await flush();
    expect(indexed.has(indexedSharedDraft.id)).toBe(true);
    expect(await readDraftRecovery(indexedSharedDraft.id)).toEqual(indexedSharedDraft);

    // Saving a recovered draft clears copies of that same draft even if another
    // tab refreshed its timestamp. A different draft from that tab is retained.
    const rewritten = { ...sharedDraft, __xiangyingRecoveryUpdatedAt: 100 };
    const newer = { ...sharedDraft, contentMarkdown: "另一标签页的新正文" };
    local.set(sharedKey, JSON.stringify(rewritten));
    indexed.set(sharedDraft.id, JSON.stringify(newer));
    clearDraftRecovery(sharedDraft.id, sharedDraft);
    await flush();
    expect(local.has(sharedKey)).toBe(false);
    expect(await readDraftRecovery(sharedDraft.id)).toEqual(newer);
    clearDraftRecovery(sharedDraft.id, newer);
    await flush();
    expect(indexed.has(sharedDraft.id)).toBe(false);

    writeDraftRecovery(draft);
    holdRead = true;
    const pendingRead = readDraftRecovery(draft.id);
    await flush();
    expect(finishRead).toBeFunction();
    clearDraftRecovery(draft.id);
    expect(local.has(draftRecoveryStorageKey(draft.id))).toBe(false);
    finishRead!();
    expect(await pendingRead).toBeNull();
  } finally {
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
    else Reflect.deleteProperty(globalThis, "window");
    if (indexedDbDescriptor) Object.defineProperty(globalThis, "indexedDB", indexedDbDescriptor);
    else Reflect.deleteProperty(globalThis, "indexedDB");
  }
});
