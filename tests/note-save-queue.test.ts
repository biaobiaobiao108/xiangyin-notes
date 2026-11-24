import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { ApiError, api } from "../app/api";
import { useNoteSaveQueue } from "../app/workspace/use-note-save-queue";
import { latestSelectedNoteSnapshot } from "../app/workspace/selected-note-sync";
import { toNoteSummary } from "../app/workspace/helpers";
import type { Note, NoteSummary } from "../shared/types";

const original: Note = {
  id: "note-1",
  title: "测试笔记",
  contentMarkdown: "已保存正文",
  preview: "已保存正文",
  tags: [],
  thumbnail: null,
  notebookId: "work",
  notebookName: "工作",
  isFavorite: false,
  deletedAt: null,
  version: 1,
  createdAt: 1,
  updatedAt: 1,
};

let queue: ReturnType<typeof useNoteSaveQueue>;
let selectedRef: { current: Note | null };
let notesRef: { current: NoteSummary[] };
let splitSelectedRef: { current: Note | null };
let splitNoteIdRef: { current: string | null };
let stored: Note;
let update: ReturnType<typeof spyOn<typeof api, "updateNote">>;
let get: ReturnType<typeof spyOn<typeof api, "getNote">>;
let linkedNoteRefreshes: { sourceId: string; savedVersion: number | undefined }[];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  stored = { ...original };
  selectedRef = { current: { ...original } };
  notesRef = { current: [toNoteSummary(original)] };
  splitSelectedRef = { current: null };
  splitNoteIdRef = { current: null };
  linkedNoteRefreshes = [];
  update = spyOn(api, "updateNote").mockImplementation(async (_id, payload) => {
    if (payload.version !== stored.version) throw new ApiError(409, "VERSION_CONFLICT", "版本冲突");
    stored = { ...stored, ...payload, version: stored.version + 1 };
    return { note: toNoteSummary(stored) };
  });
  get = spyOn(api, "getNote").mockImplementation(async () => ({ note: { ...stored } }));
  // Server rendering supplies real React hooks without a DOM; these tests drive
  // the queue directly and clean up its timers instead of mounting UI effects.
  renderToString(
    createElement(function Harness() {
      queue = useNoteSaveQueue({
        selectedRef,
        notesRef,
        activeNoteIdRef: { current: original.id },
        trashOperationsRef: { current: new Set() },
        flushEditorDraftRef: { current: () => undefined },
        replaceList: (notes) => {
          notesRef.current = notes;
        },
        setSelectedNote: () => {},
        setToast: () => {},
        splitSelectedRef,
        splitNoteIdRef,
        onLinkedNotesRewritten: (sourceId) => {
          linkedNoteRefreshes.push({ sourceId, savedVersion: selectedRef.current?.version });
        },
      });
      return null;
    }),
  );
});

afterEach(() => {
  for (const id of new Set([original.id, ...queue.pendingSavesRef.current.keys()]))
    queue.clearPendingForNote(id);
  update.mockRestore();
  get.mockRestore();
});

describe("favorite operations and the save queue", () => {
  test("keeps the latest draft and stops remote retries when its note was permanently deleted", async () => {
    const missing = new ApiError(404, "NOTE_NOT_FOUND", "笔记不存在");
    update.mockRejectedValueOnce(missing);
    queue.persist({ ...original, contentMarkdown: "第一版草稿" }, ["contentMarkdown"]);
    await expect(queue.runSave(original.id)).rejects.toBe(missing);
    queue.persist({ ...original, contentMarkdown: "更新的草稿" }, ["contentMarkdown"]);
    queue.saveNoteNow();
    await queue.retryFailedSaves();
    await expect(queue.runSave(original.id)).rejects.toBe(missing);
    expect(update).toHaveBeenCalledTimes(1);
    expect(queue.pendingSavesRef.current.get(original.id)?.contentMarkdown).toBe("更新的草稿");
  });

  test("preserves a draft when a remote deletion overtakes its in-flight save response", async () => {
    const response = deferred<{ note: NoteSummary }>();
    update.mockImplementationOnce(() => response.promise);
    const draft = { ...original, contentMarkdown: "尚未转存的草稿" };
    queue.persist(draft, ["contentMarkdown"]);
    const saving = queue.runSave(original.id);
    const missing = new ApiError(404, "NOTE_NOT_FOUND", "笔记不存在");
    queue.markNoteMissing(original.id, missing);
    response.resolve({ note: toNoteSummary({ ...draft, version: 2 }) });
    await expect(saving).rejects.toBe(missing);
    expect(queue.pendingSavesRef.current.get(original.id)?.contentMarkdown).toBe(
      draft.contentMarkdown,
    );
  });

  test("reconciles other notes after a rename response has applied the saved version", async () => {
    update.mockResolvedValueOnce({
      note: toNoteSummary({ ...original, title: "新标题", version: 2 }),
      linkedNotesRewritten: true,
    });
    queue.persist({ ...original, title: "新标题" }, ["title"]);
    await queue.runSave(original.id);
    expect(linkedNoteRefreshes).toEqual([{ sourceId: original.id, savedVersion: 2 }]);
  });
  test("rebases edits made during a rename on the server-rewritten self link", async () => {
    const response = deferred<{ note: Note; previousTitle: string }>();
    let calls = 0;
    update.mockImplementation(async (_id, payload) => {
      calls++;
      if (calls === 1) return response.promise;
      expect(payload.version).toBe(2);
      expect(payload.contentMarkdown).toBe("[[新名]] 和新内容");
      return {
        note: { ...original, title: "新名", contentMarkdown: payload.contentMarkdown!, version: 3 },
      };
    });
    const before = { ...original, title: "新名", contentMarkdown: "[[旧名]]" };
    queue.persist(before, ["title"]);
    const saving = queue.runSave(original.id);
    queue.persist({ ...before, contentMarkdown: "[[旧名]] 和新内容" }, ["contentMarkdown"]);
    response.resolve({
      note: { ...before, contentMarkdown: "[[新名]]", version: 2 },
      previousTitle: "旧名",
    });
    await saving;
    expect(selectedRef.current?.contentMarkdown).toBe("[[新名]] 和新内容");
    expect(calls).toBe(2);
  });
  test("keeps a completed save when an older split load finishes afterwards", async () => {
    splitNoteIdRef.current = original.id;
    selectedRef.current = null;
    const draft = { ...original, contentMarkdown: "分栏加载时保存的正文" };
    queue.persist(draft, ["contentMarkdown"]);
    await queue.runSave(original.id);

    expect(queue.pendingSavesRef.current.has(original.id)).toBe(false);
    const loaded = latestSelectedNoteSnapshot(original, splitSelectedRef.current);
    expect(loaded.contentMarkdown).toBe(draft.contentMarkdown);
    expect(loaded.version).toBe(2);
  });

  test("does not replace the split snapshot after its target changes", async () => {
    splitNoteIdRef.current = "another-note";
    splitSelectedRef.current = { ...original, id: "another-note" };
    queue.persist({ ...original, contentMarkdown: "后台保存" }, ["contentMarkdown"]);
    await queue.runSave(original.id);
    expect(splitSelectedRef.current.id).toBe("another-note");
  });

  test("returns the persisted version after flushing a pending draft", async () => {
    queue.persist({ ...original, contentMarkdown: "删除前保存的正文" }, ["contentMarkdown"]);

    await expect(queue.runSave(original.id)).resolves.toBe(2);
    await expect(queue.runSave(original.id)).resolves.toBeUndefined();
  });

  test("confirms a save whose response was lost before sending newer edits", async () => {
    update.mockImplementationOnce(async (_id, payload) => {
      stored = { ...stored, ...payload, version: 2 };
      throw new TypeError("网络连接中断");
    });
    const first = { ...original, contentMarkdown: "已提交的版本" };
    queue.persist(first, ["contentMarkdown"]);
    await expect(queue.runSave(original.id)).rejects.toThrow("网络连接中断");

    const next = { ...first, contentMarkdown: "断线后继续编辑" };
    queue.persist(next, ["contentMarkdown"]);
    update.mockRejectedValueOnce(
      new ApiError(409, "VERSION_CONFLICT", "版本冲突", { error: { current: stored } }),
    );
    await queue.retryFailedSaves();

    expect(update.mock.calls.map(([, payload]) => payload)).toEqual([
      { version: 1, contentMarkdown: first.contentMarkdown },
      { version: 1, contentMarkdown: first.contentMarkdown },
      { version: 2, contentMarkdown: next.contentMarkdown },
    ]);
    expect(selectedRef.current).toMatchObject({
      version: 3,
      contentMarkdown: next.contentMarkdown,
    });
    expect(queue.hasUnsavedWork()).toBe(false);
  });

  test("preserves the latest draft when the server changed after a response was lost", async () => {
    update.mockRejectedValueOnce(new TypeError("网络连接中断"));
    const draft = { ...original, contentMarkdown: "本地编辑" };
    queue.persist(draft, ["contentMarkdown"]);
    await expect(queue.runSave(original.id)).rejects.toThrow("网络连接中断");

    const current = { ...draft, version: 2, contentMarkdown: "远端编辑" };
    update.mockRejectedValueOnce(
      new ApiError(409, "VERSION_CONFLICT", "版本冲突", { error: { current } }),
    );
    await queue.retryFailedSaves();

    expect(queue.pendingSavesRef.current.get(original.id)?.contentMarkdown).toBe(
      draft.contentMarkdown,
    );
    expect(queue.failedSavesRef.current.get(original.id)).toMatchObject({
      code: "VERSION_CONFLICT",
    });
  });

  test("saves an unsaved body together with a card favorite", async () => {
    const draft = { ...original, contentMarkdown: "未保存的正文" };
    selectedRef.current = draft;
    queue.persist(draft, ["contentMarkdown"]);

    await queue.saveFavorite(original.id, true);

    expect(stored.contentMarkdown).toBe(draft.contentMarkdown);
    expect(stored.isFavorite).toBe(true);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]?.[1]).toEqual({
      version: 1,
      contentMarkdown: draft.contentMarkdown,
      isFavorite: true,
    });
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

    await expect(queue.saveFavorite(original.id, true)).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
    });

    expect(stored.contentMarkdown).toBe("远端正文");
    expect(queue.pendingSavesRef.current.get(original.id)?.contentMarkdown).toBe("本地草稿");
    expect(queue.hasUnsavedWork()).toBe(true);
  });
});

describe("notebook draft flushing", () => {
  test("saves all drafts in a notebook without dropping drafts from other notebooks", async () => {
    queue.persist({ ...original, contentMarkdown: "删除笔记本前的编辑" }, ["contentMarkdown"]);
    queue.persist({ ...original, id: "note-2", notebookId: "other", contentMarkdown: "其他草稿" }, [
      "contentMarkdown",
    ]);

    await queue.flushNotebookSaves("work");

    expect(stored.contentMarkdown).toBe("删除笔记本前的编辑");
    expect(queue.pendingSavesRef.current.has(original.id)).toBe(false);
    expect(queue.pendingSavesRef.current.get("note-2")?.contentMarkdown).toBe("其他草稿");
    expect(update).toHaveBeenCalledTimes(1);
  });

  test("rejects notebook deletion preparation if a draft could not be saved", async () => {
    queue.persist({ ...original, contentMarkdown: "不能丢失的草稿" }, ["contentMarkdown"]);
    update.mockRejectedValueOnce(new Error("offline"));

    await expect(queue.flushNotebookSaves("work")).rejects.toThrow("offline");
    expect(queue.pendingSavesRef.current.get(original.id)?.contentMarkdown).toBe("不能丢失的草稿");
  });
});

describe("split editor save queue integration", () => {
  test("updates splitSelectedRef and setSplitSelectedNote when split note is saved", async () => {
    let splitQueue!: ReturnType<typeof useNoteSaveQueue>;
    const splitNote: Note = { ...original, id: "split-1", title: "分屏笔记", version: 1 };
    const splitSelectedRef = { current: { ...splitNote } };
    let splitSelectedUpdated: Note | null = null;
    let splitSaveState = "idle";

    renderToString(
      createElement(function SplitHarness() {
        splitQueue = useNoteSaveQueue({
          selectedRef,
          notesRef,
          activeNoteIdRef: { current: original.id },
          trashOperationsRef: { current: new Set() },
          flushEditorDraftRef: { current: () => undefined },
          replaceList: (notes) => {
            notesRef.current = notes;
          },
          setSelectedNote: () => {},
          setToast: () => {},
          splitSelectedRef,
          splitNoteIdRef: { current: splitNote.id },
          setSplitSelectedNote: (note) => {
            splitSelectedUpdated = note;
          },
          setSplitSaveState: (state) => {
            splitSaveState = state;
          },
        });
        return null;
      }),
    );

    let splitStored = { ...splitNote };
    update.mockImplementationOnce(async (_id, payload) => {
      splitStored = { ...splitStored, ...payload, version: splitStored.version + 1 };
      return { note: toNoteSummary(splitStored) };
    });

    splitQueue.persist({ ...splitNote, contentMarkdown: "分屏编辑后的正文" }, ["contentMarkdown"]);
    expect(splitSaveState).toBe("saving");
    await splitQueue.runSave("split-1");
    expect(splitSaveState).toBe("saved");
    expect(splitSelectedRef.current.contentMarkdown).toBe("分屏编辑后的正文");
    expect((splitSelectedUpdated as Note | null)?.contentMarkdown).toBe("分屏编辑后的正文");
    splitQueue.clearPendingForNote("split-1");
  });
});

describe("moving notes between notebooks", () => {
  test("updates both open editors and the list with the confirmed notebook and version", async () => {
    splitNoteIdRef.current = original.id;
    splitSelectedRef.current = { ...original };
    expect(await queue.moveNoteToNotebook(original.id, "inbox")).toBe(true);

    for (const note of [selectedRef.current, splitSelectedRef.current, notesRef.current[0]]) {
      expect(note?.notebookId).toBe("inbox");
      expect(note?.version).toBe(2);
    }
    expect(selectedRef.current?.contentMarkdown).toBe(original.contentMarkdown);
    expect(await queue.moveNoteToNotebook(original.id, "inbox")).toBe(false);
    expect(update).toHaveBeenCalledTimes(1);
  });

  test("saves edits made during a move using the confirmed version", async () => {
    const started = deferred<void>();
    const response = deferred<{ note: NoteSummary }>();
    update.mockImplementationOnce(async () => {
      started.resolve();
      return response.promise;
    });

    const moving = queue.moveNoteToNotebook(original.id, "inbox");
    await started.promise;
    const draft = { ...original, title: "编辑中的标题", contentMarkdown: "移动时输入的正文" };
    queue.persist(draft, ["title", "contentMarkdown"]);
    const saving = queue.runSave(original.id);
    stored = { ...original, notebookId: "inbox", notebookName: "收件箱", version: 2 };
    response.resolve({ note: toNoteSummary(stored) });

    await moving;
    await saving;
    expect(stored).toMatchObject({
      notebookId: "inbox",
      title: draft.title,
      contentMarkdown: draft.contentMarkdown,
      version: 3,
    });
  });

  test("leaves local notebook and version intact if the move is rejected", async () => {
    stored.version += 1;
    await expect(queue.moveNoteToNotebook(original.id, "inbox")).rejects.toThrow("版本冲突");
    expect(selectedRef.current).toEqual(original);
    expect(notesRef.current).toEqual([toNoteSummary(original)]);
    expect(queue.pendingSavesRef.current.size).toBe(0);
  });
});
