import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { api } from "../app/api";
import { latestSelectedNoteSnapshot, refreshSelectedNote, type SelectedNoteSyncOptions } from "../app/workspace/selected-note-sync";
import type { Note } from "../shared/types";

const original: Note = {
  id: "note-1", title: "测试笔记", contentMarkdown: "原正文", preview: "原正文",
  tags: [], thumbnail: null, notebookId: "work", notebookName: "工作",
  isFavorite: false, deletedAt: null, version: 1, createdAt: 1, updatedAt: 1,
};

let options: SelectedNoteSyncOptions;
let get: ReturnType<typeof spyOn<typeof api, "getNote">>;
let resolveResponse: (value: { note: Note }) => void;
let pendingWork: boolean;

beforeEach(() => {
  pendingWork = false;
  const response = new Promise<{ note: Note }>((resolve) => { resolveResponse = resolve; });
  get = spyOn(api, "getNote").mockImplementation(() => response);
  options = {
    selectedRef: { current: { ...original } },
    activeNoteIdRef: { current: original.id },
    noteAbortRef: { current: null },
    noteLoadRequestRef: { current: 0 },
    hasPendingWork: () => pendingWork,
    onUpdated: mock(() => {}),
    onConflict: mock(() => {}),
    onUnauthorized: mock(() => {}),
    onNotFound: mock(() => {}),
    onError: mock(() => {}),
  };
});

afterEach(() => get.mockRestore());

describe("selected note remote synchronization", () => {
  test("ignores a late snapshot after newer local saves have completed", async () => {
    const syncing = refreshSelectedNote(original.id, options);
    const saved = { ...original, version: 3, contentMarkdown: "已保存的新正文" };
    options.selectedRef.current = saved;
    resolveResponse({ note: { ...original, version: 2, contentMarkdown: "较早服务器快照" } });
    await syncing;

    expect(options.selectedRef.current).toBe(saved);
    expect(options.onUpdated).not.toHaveBeenCalled();
    expect(options.onConflict).not.toHaveBeenCalled();
    expect(options.noteAbortRef.current).toBeNull();
  });

  test("does not reload an already-saved version over newer unsaved typing", async () => {
    const syncing = refreshSelectedNote(original.id, options);
    const draft = { ...original, version: 2, contentMarkdown: "保存后继续输入的草稿" };
    options.selectedRef.current = draft;
    pendingWork = true;
    resolveResponse({ note: { ...original, version: 2, contentMarkdown: "已保存正文" } });
    await syncing;

    expect(options.selectedRef.current).toBe(draft);
    expect(options.onUpdated).not.toHaveBeenCalled();
    expect(options.onConflict).not.toHaveBeenCalled();
  });

  test("applies a genuinely newer remote version when there is no local draft", async () => {
    const syncing = refreshSelectedNote(original.id, options);
    const remote = { ...original, version: 2, contentMarkdown: "远端新正文" };
    resolveResponse({ note: remote });
    await syncing;

    expect(options.selectedRef.current).toBe(remote);
    expect(options.onUpdated).toHaveBeenCalledWith(remote);
  });

  test("preserves a pending draft when the remote version has advanced", async () => {
    const syncing = refreshSelectedNote(original.id, options);
    const draft = { ...original, contentMarkdown: "尚未保存的草稿" };
    options.selectedRef.current = draft;
    pendingWork = true;
    resolveResponse({ note: { ...original, version: 2 } });
    await syncing;

    expect(options.selectedRef.current).toBe(draft);
    expect(options.onConflict).toHaveBeenCalledTimes(1);
    expect(options.onUpdated).not.toHaveBeenCalled();
  });

  test("ignores a successful response after selection changes", async () => {
    const syncing = refreshSelectedNote(original.id, options);
    const other = { ...original, id: "note-2" };
    options.activeNoteIdRef.current = other.id;
    options.selectedRef.current = other;
    options.noteLoadRequestRef.current += 1;
    resolveResponse({ note: { ...original, version: 2 } });
    await syncing;

    expect(options.selectedRef.current).toBe(other);
    expect(options.onUpdated).not.toHaveBeenCalled();
    expect(options.onConflict).not.toHaveBeenCalled();
  });
});


describe("selected note load snapshot selection", () => {
  test("keeps a completed save when the earlier GET arrives after switching back", async () => {
    const loading = (async () => {
      const response = await api.getNote(original.id);
      return latestSelectedNoteSnapshot(response.note, options.selectedRef.current);
    })();
    const saved = { ...original, version: 2, contentMarkdown: "切换期间已保存的正文" };
    options.selectedRef.current = saved;
    resolveResponse({ note: original });

    expect(await loading).toBe(saved);
  });

  test("checks again when a save completes during asynchronous draft recovery", async () => {
    let finishRecovery!: () => void;
    const recovery = new Promise<void>((resolve) => { finishRecovery = resolve; });
    let startedRecovery!: () => void;
    const recoveryStarted = new Promise<void>((resolve) => { startedRecovery = resolve; });
    const loading = (async () => {
      const response = await api.getNote(original.id);
      let snapshot = latestSelectedNoteSnapshot(response.note, options.selectedRef.current);
      startedRecovery();
      await recovery;
      snapshot = latestSelectedNoteSnapshot(snapshot, options.selectedRef.current);
      return snapshot;
    })();
    resolveResponse({ note: original });
    await recoveryStarted;
    const saved = { ...original, version: 2, contentMarkdown: "读取恢复副本期间已保存的正文" };
    options.selectedRef.current = saved;
    finishRecovery();

    expect(await loading).toBe(saved);
  });

  test("only keeps a local snapshot for the same note at an equal or newer version", () => {
    const remote = { ...original, version: 2 };
    expect(latestSelectedNoteSnapshot(remote, original)).toBe(remote);
    expect(latestSelectedNoteSnapshot(remote, { ...remote, id: "another-note", version: 3 })).toBe(remote);
    expect(latestSelectedNoteSnapshot(remote, null)).toBe(remote);
    const local = { ...remote, contentMarkdown: "同版本的本地状态" };
    expect(latestSelectedNoteSnapshot(remote, local)).toBe(local);
  });
});
