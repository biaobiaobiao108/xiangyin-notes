import { describe, expect, test } from "bun:test";
import type { KanbanCard } from "../shared/types";
import { kanbanCardOffsets, kanbanTotalHeight } from "../app/workspace/use-virtual-kanban-column";

function card(id: string): KanbanCard {
  return {
    noteId: id,
    userId: "user",
    status: "inbox",
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0,
    note: {
      id,
      title: id,
      preview: "",
      thumbnail: null,
      notebookId: "inbox",
      notebookName: "收件箱",
      isFavorite: false,
      deletedAt: null,
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      tags: [],
    },
  };
}

describe("Kanban virtual column geometry", () => {
  test("lays out measured cards with the normal card gap", () => {
    const cards = [card("a"), card("b"), card("c")];
    const heights = new Map([
      ["a", 120],
      ["b", 180],
    ]);
    expect(kanbanCardOffsets(cards, heights)).toEqual([0, 130, 320]);
    expect(kanbanTotalHeight(cards, [0, 130, 320], heights)).toBe(456);
  });

  test("keeps an empty column at zero height", () => {
    expect(kanbanCardOffsets([], new Map())).toEqual([]);
    expect(kanbanTotalHeight([], [], new Map())).toBe(0);
  });
});
