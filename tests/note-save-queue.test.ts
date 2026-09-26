import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { ApiError, api } from "../app/api";
import { useNoteSaveQueue } from "../app/workspace/use-note-save-queue";
import { toNoteSummary } from "../app/workspace/helpers";
import type { Note, NoteSummary } from "../shared/types";

const original: Note = {
  id: "note-1", title: "测试笔记", contentMarkdown: "已保存正文", preview: "已保存正文",
  tags: [], thumbnail: null, notebookId: "work", notebookName: "工作",
  isFavorite: false, deletedAt: null, version: 1, createdAt: 1, updatedAt: 1,
};

let queue: ReturnType<typeof useNoteSaveQueue>;
let selectedRef: { current: Note | null };
let notesRef: { current: NoteSummary[] };
let stored: Note;
let update: ReturnType<typeof spyOn<typeof api, "updateNote">>;
let get: ReturnType<typeof spyOn<typeof api, "getNote">>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  stored = { ...original };
  selectedRef = { current: { ...original } };
  notesRef = { current: [toNoteSummary(original)] };
  update = spyOn(api, "updateNote").mockImplementation(async (_id, payload) => {
    if (payload.version !== stored.version) throw new ApiError(409, "VERSION_CONFLICT", "版本冲突");
    stored = { ...stored, ...payload, version: stored.version + 1 };
    return { note: toNoteSummary(stored) };
  });
  get = spyOn(api, "getNote").mockImplementation(async () => ({ note: { ...stored } }));
  // Server rendering supplies real React hooks without a DOM; these tests drive
  // the queue directly and clean up its timers instead of mounting UI effects.
  renderToString(createElement(function Harness() {
    queue = useNoteSaveQueue({
      selectedRef, notesRef, activeNoteIdRef: { current: original.id },
      trashOperationsRef: { current: new Set() },
      replaceList: (notes) => { notesRef.current = notes; },
      setSelectedNote: () => {}, setToast: () => {},
    });
    return null;
  }));
});

afterEach(() => {
  for (const id of new Set([original.id, ...queue.pendingSavesRef.current.keys()])) queue.clearPendingForNote(id);
  update.mockRestore();
  get.mockRestore();
});

describe("favorite operations and the save queue", () => {
  test("saves an unsaved body together with a card favorite", async () => {
    const draft = { ...original, contentMarkdown: "未保存的正文" };
    selectedRef.current = draft;
    queue.persist(draft, ["contentMarkdown"]);

    await queue.saveFavorite(original.id, true);

    expect(stored.contentMarkdown).toBe(draft.contentMarkdown);
    expect(stored.isFavorite).toBe(true);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]?.[1]).toEqual({ version: 1, contentMarkdown: draft.contentMarkdown, isFavorite: true });
    expect(selectedRef.current?.version).toBe(2);
    expect(queue.hasUnsavedWork()).toBe(false);
  });

  test("serializes a favorite behind an in-flight body save and keeps newer edits", async () => {
    const response = deferred<{ note: NoteSummary }>();
    update.mockImplementationOnce(async (_id, payload) => {
      stored = { ...stored, ...payload, version: stored.version + 1 };
      return response.promise;
    });
    const draft = { ...original, contentMarkdown: "第一次编辑" };
    queue.persist(draft, ["contentMarkdown"]);
    const saving = queue.runSave(original.id);
    const favoriting = queue.saveFavorite(original.id, true);
    const next = { ...draft, contentMarkdown: "保存期间的新编辑", isFavorite: true };
    queue.persist(next, ["contentMarkdown"]);
    response.resolve({ note: toNoteSummary(stored) });

    await Promise.all([saving, favoriting]);

    expect(stored.contentMarkdown).toBe(next.contentMarkdown);
    expect(stored.isFavorite).toBe(true);
    expect(update.mock.calls.map((call) => call[1].version)).toEqual([1, 2]);
    expect(queue.hasUnsavedWork()).toBe(false);
  });

  test("uses a draft that arrives while an inactive card note is loading", async () => {
    selectedRef.current = null;
    const response = deferred<{ note: Note }>();
    get.mockImplementationOnce(() => response.promise);
    const favoriting = queue.saveFavorite(original.id, true);
    const draft = { ...original, contentMarkdown: "加载期间的新编辑" };
    queue.persist(draft, ["contentMarkdown"]);
    response.resolve({ note: { ...original } });

    await favoriting;

    expect(stored.contentMarkdown).toBe(draft.contentMarkdown);
    expect(stored.isFavorite).toBe(true);
    expect(get).toHaveBeenCalledTimes(1);
  });

  test("keeps a draft when the favorite save encounters a genuine remote conflict", async () => {
    const draft = { ...original, contentMarkdown: "本地草稿" };
    queue.persist(draft, ["contentMarkdown"]);
    stored = { ...stored, contentMarkdown: "远端正文", version: 2 };

    await expect(queue.saveFavorite(original.id, true)).rejects.toMatchObject({ code: "VERSION_CONFLICT" });

    expect(stored.contentMarkdown).toBe("远端正文");
    expect(queue.pendingSavesRef.current.get(original.id)?.contentMarkdown).toBe("本地草稿");
    expect(queue.hasUnsavedWork()).toBe(true);
  });
});
