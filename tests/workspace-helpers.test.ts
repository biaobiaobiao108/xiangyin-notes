import { describe, expect, test } from "bun:test";
import type { Note, NoteSummary, Notebook } from "../shared/types";
import { getNotebookIconComponent, mergeRemoteSummary, mergeWikiNoteSummary, notebookColorOptions, notebookIconOptions, shouldKeepActiveNoteInList } from "../app/workspace/helpers";

const notebooks: Notebook[] = [
  { id: "inbox", name: "收件箱", color: "#718077", icon: "folder", isSystem: true, count: 1, updatedAt: 1 },
  { id: "work", name: "工作", color: "#d96245", icon: "folder", isSystem: false, count: 1, updatedAt: 1 },
];

const note: Note = {
  id: "note-1",
  title: "测试笔记",
  contentMarkdown: "正文",
  preview: "正文",
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

describe("active note list membership", () => {
  test("never injects an active note into search results", () => {
    expect(shouldKeepActiveNoteInList(note, notebooks, "all", "不存在的关键词")).toBe(false);
  });

  test("only keeps notes that match favorites and trash state", () => {
    expect(shouldKeepActiveNoteInList(note, notebooks, "favorites", "")).toBe(false);
    expect(shouldKeepActiveNoteInList({ ...note, isFavorite: true }, notebooks, "favorites", "")).toBe(true);
    expect(shouldKeepActiveNoteInList(note, notebooks, "trash", "")).toBe(false);
    expect(shouldKeepActiveNoteInList({ ...note, deletedAt: 2 }, notebooks, "trash", "")).toBe(true);
  });

  test("keeps an optimistic move only in its actual destination", () => {
    expect(shouldKeepActiveNoteInList(note, notebooks, "all", "", "work")).toBe(true);
    expect(shouldKeepActiveNoteInList(note, notebooks, "all", "", "inbox")).toBe(false);
    expect(shouldKeepActiveNoteInList({ ...note, notebookId: "inbox" }, notebooks, "inbox", "")).toBe(true);
  });
});

describe("wiki target list membership", () => {
  test("does not insert targets from another notebook or outside favorites and search", () => {
    const rows = [{ ...note, id: "source", notebookId: "inbox" }];
    expect(mergeWikiNoteSummary(rows, note, notebooks, "all", "", "inbox")).toBeNull();
    expect(mergeWikiNoteSummary(rows, note, notebooks, "favorites", "")).toBeNull();
    expect(mergeWikiNoteSummary(rows, note, notebooks, "all", "正文")).toBeNull();
    expect(rows.map((row) => row.id)).toEqual(["source"]);
  });

  test("inserts matching targets once and refreshes existing targets without duplicates", () => {
    const rows = [{ ...note, id: "source" }];
    const merged = mergeWikiNoteSummary(rows, note, notebooks, "all", "", "work")!;
    expect(merged.map((row) => row.id)).toEqual([note.id, "source"]);
    expect(mergeWikiNoteSummary(merged, { ...note, version: 2 }, notebooks, "all", "", "work"))
      .toEqual([{ ...note, version: 2 }, ...rows]);
    expect(mergeWikiNoteSummary(rows, { ...note, isFavorite: true }, notebooks, "favorites", "")?.[0]?.id).toBe(note.id);
  });
});

describe("remote summary merging", () => {
  const summary = (id: string, updatedAt: number, overrides: Partial<NoteSummary> = {}): NoteSummary => ({
    id,
    title: `笔记 ${id}`,
    preview: "",
    tags: [],
    thumbnail: null,
    notebookId: "work",
    notebookName: "工作",
    isFavorite: false,
    deletedAt: null,
    version: 1,
    createdAt: updatedAt,
    updatedAt,
    ...overrides,
  });

  test("patches one row and moves it to the top under the updated sort", () => {
    const rows = [summary("a", 30), summary("b", 20), summary("c", 10)];
    const merged = mergeRemoteSummary(rows, summary("c", 40, { title: "改过" }), "updated");
    expect(merged?.map((row) => row.id)).toEqual(["c", "a", "b"]);
    expect(merged?.[0]?.title).toBe("改过");
    // 原数组不被就地修改。
    expect(rows.map((row) => row.id)).toEqual(["a", "b", "c"]);
  });

  test("keeps the position for created and title sorts", () => {
    const rows = [summary("a", 30), summary("b", 20)];
    expect(mergeRemoteSummary(rows, summary("b", 40), "created")?.map((row) => row.id)).toEqual(["a", "b"]);
    expect(mergeRemoteSummary(rows, summary("b", 40), "title")?.map((row) => row.id)).toEqual(["a", "b"]);
  });

  test("returns null when the note is not in the current list", () => {
    expect(mergeRemoteSummary([summary("a", 1)], summary("missing", 2), "updated")).toBeNull();
  });
});

describe("notebook color options", () => {
  test("offers nine unique preset colors", () => {
    expect(notebookColorOptions).toHaveLength(9);
    expect(new Set(notebookColorOptions).size).toBe(9);
    expect(notebookColorOptions).toEqual(["#d96245", "#718077", "#5b7899", "#9c765f", "#aa6f8e", "#8b7c54", "#4f8a78", "#c18a3d", "#c45b73"]);
  });
});

describe("notebook icon options", () => {
  test("offers 16 unique preset icons arranged in two rows of eight", () => {
    expect(notebookIconOptions).toHaveLength(16);
    expect(new Set(notebookIconOptions.map((opt) => opt.id)).size).toBe(16);
  });

  test("resolves icon components and falls back to folder", () => {
    expect(getNotebookIconComponent("book")).toBeDefined();
    expect(getNotebookIconComponent("unknown-id")).toBe(getNotebookIconComponent("folder"));
  });
});
