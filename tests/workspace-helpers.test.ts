import { describe, expect, test } from "bun:test";
import type { Note, Notebook } from "../shared/types";
import { shouldKeepActiveNoteInList } from "../app/workspace/helpers";

const notebooks: Notebook[] = [
  { id: "inbox", name: "收件箱", color: "#718077", isSystem: true, count: 1, updatedAt: 1 },
  { id: "work", name: "工作", color: "#d96245", isSystem: false, count: 1, updatedAt: 1 },
];

const note: Note = {
  id: "note-1",
  title: "测试笔记",
  contentMarkdown: "正文",
  preview: "正文",
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
  test("never injects an active note into shared or search results", () => {
    expect(shouldKeepActiveNoteInList(note, notebooks, "shared", "")).toBe(false);
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
