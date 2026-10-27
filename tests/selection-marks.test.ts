import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NoteCardGridPanel } from "../app/workspace/note-card-grid";
import { NoteListPanel } from "../app/workspace/panels";
import type { NoteSummary } from "../shared/types";

function noteSummary(): NoteSummary {
  return {
    id: "note-1",
    title: "笔记一",
    preview: "预览内容",
    tags: [],
    thumbnail: null,
    notebookId: "notebook-1",
    notebookName: "笔记本",
    isFavorite: false,
    deletedAt: null,
    version: 1,
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
  };
}

function renderList(selectedIds: Set<string>, selectedId: string | null = null): string {
  return renderToStaticMarkup(
    React.createElement(NoteListPanel, {
      notes: [noteSummary()],
      total: 1,
      selectedId,
      selectedIds,
      onSelect: () => {},
      onToggleFavoriteNote: () => {},
      onDeleteSelected: () => {},
      onNoteSwipeAction: () => {},
      view: "all",
      query: "",
      currentNotebookName: "笔记本",
      trashBusy: false,
      onClearQuery: () => {},
      onOpenSidebar: () => {},
      transitionToken: 0,
      outlineOpen: false,
      outlineItems: [],
      activeOutlineId: null,
      onScrollToOutlineItem: () => {},
      onCloseOutline: () => {},
      virtualizationScope: "selection-marks-test",
    }),
  );
}

function renderCards(selectedIds: Set<string>): string {
  return renderToStaticMarkup(
    React.createElement(NoteCardGridPanel, {
      notes: [noteSummary()],
      total: 1,
      hasMore: false,
      selectedIds,
      onOpenNote: () => {},
      onToggleSelectNote: () => {},
      onDeleteSelected: () => {},
      view: "all",
      currentNotebookName: "笔记本",
      query: "",
      onClearQuery: () => {},
      notebooks: [
        {
          id: "notebook-1",
          name: "笔记本",
          color: "#5d795f",
          icon: "folder",
          isSystem: false,
          count: 1,
          updatedAt: 1_700_000_000,
        },
      ],
      onToggleFavoriteNote: () => {},
      scrollScope: "selection-marks-test",
      initialScrollTop: 0,
      onScrollPositionChange: () => {},
    }),
  );
}

describe("multi-selection highlight", () => {
  test("list rows use a highlight instead of a checkmark, including on the active note", () => {
    const unselected = renderList(new Set<string>());
    expect(unselected).not.toContain("is-selected");

    const selected = renderList(new Set(["note-1"]), "note-1");
    expect(selected).toContain("is-selected");
    expect(selected).toContain("is-active");
    expect(selected).not.toContain("note-selection-mark");
    expect(selected).toContain('aria-pressed="true"');
  });

  test("cards use a selection highlight instead of a checkmark", () => {
    expect(renderCards(new Set<string>())).not.toContain("is-selected");
    expect(renderCards(new Set(["note-1"]))).toContain("is-selected");
    expect(renderCards(new Set(["note-1"]))).not.toContain("note-selection-mark");
  });

  test("list and card views show notebook names and favorite controls in notebook views", () => {
    const list = renderList(new Set<string>());
    const cards = renderCards(new Set<string>());

    expect(list).toContain('<span class="note-row-notebook">笔记本</span>');
    expect(list).toContain('aria-label="加入收藏"');
    expect(cards).toContain('<span class="notebook-badge-name">笔记本</span>');
    expect(cards).toContain('aria-label="加入收藏"');
  });

  test("cards keep room for the favorite action only outside the trash", () => {
    expect(renderCards(new Set<string>())).toContain("has-favorite-action");
  });
});
