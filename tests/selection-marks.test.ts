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

function renderList(selectedIds: Set<string>): string {
  return renderToStaticMarkup(
    React.createElement(NoteListPanel, {
      notes: [noteSummary()],
      total: 1,
      sort: "updated",
      setSort: () => {},
      selectedId: null,
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
      sort: "updated",
      setSort: () => {},
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

describe("selection affordance", () => {
  test("list rows reserve an aria-hidden slot and only fill it when selected", () => {
    const unselected = renderList(new Set<string>());
    expect(unselected).toContain('class="note-selection-slot" aria-hidden="true"');
    expect(unselected).not.toContain("note-selection-mark");

    const selected = renderList(new Set(["note-1"]));
    expect(selected).toContain("note-selection-mark");
    expect(selected).toContain('aria-pressed="true"');
  });

  test("cards expose the same selection mark as list rows", () => {
    expect(renderCards(new Set<string>())).not.toContain("note-selection-mark");
    expect(renderCards(new Set(["note-1"]))).toContain("note-selection-mark");
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
