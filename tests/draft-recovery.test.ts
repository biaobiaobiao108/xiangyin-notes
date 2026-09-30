import { describe, expect, test } from "bun:test";
import { parseDraftRecovery, serializeDraftRecovery } from "../app/workspace/draft-recovery";
import type { NoteDraft } from "../app/workspace/helpers";

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
    expect(serializeDraftRecovery({ ...draft, contentMarkdown: "字".repeat(2_000_000) })).toBeNull();
  });
});

test("older IndexedDB completions cannot remove, overwrite or restore a newer recovery", async () => {
  const { writeDraftRecovery, readDraftRecovery, clearDraftRecovery, clearAllDraftRecoveries, draftRecoveryStorageKey } = await import("../app/workspace/draft-recovery");
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const indexedDbDescriptor = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const local = new Map<string, string>();
  const indexed = new Map<string, string>();
  const writes: Array<{ transaction: IDBTransaction; key: string; value: string }> = [];
  const flush = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve(); };
  const database = {
    transaction() {
      const transaction = {
        oncomplete: null,
        onerror: null,
        onabort: null,
        objectStore() {
          return {
            put(value: string, key: string) { writes.push({ transaction: transaction as unknown as IDBTransaction, key, value }); },
            delete(key: string) { indexed.delete(key); },
            clear() { indexed.clear(); },
            get(key: string) {
              const request = { result: indexed.get(key), onsuccess: null as (() => void) | null };
              queueMicrotask(() => request.onsuccess?.());
              return request;
            },
          };
        },
      };
      return transaction;
    },
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    localStorage: {
      getItem: (key: string) => local.get(key) ?? null,
      setItem: (key: string, value: string) => local.set(key, value),
      removeItem: (key: string) => local.delete(key),
      get length() { return local.size; },
      key: (index: number) => [...local.keys()][index] ?? null,
    },
  } });
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: {
    open() {
      const request = { result: database, onsuccess: null as (() => void) | null };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  } });
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
  } finally {
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
    else Reflect.deleteProperty(globalThis, "window");
    if (indexedDbDescriptor) Object.defineProperty(globalThis, "indexedDB", indexedDbDescriptor);
    else Reflect.deleteProperty(globalThis, "indexedDB");
  }
});
