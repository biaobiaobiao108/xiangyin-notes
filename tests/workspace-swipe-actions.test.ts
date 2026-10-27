import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MobileNotebookHome } from "../app/workspace/mobile-panels";
import { NoteListPanel } from "../app/workspace/panels";
import {
  shouldKeepSwipeActionsOpenAfterCancel,
  shouldOpenSwipeActions,
} from "../app/workspace/swipe-actions";
import type { Notebook, NoteSummary } from "../shared/types";

function noteSummary(overrides: Partial<NoteSummary> = {}): NoteSummary {
  return {
    id: "note-1",
    title: "",
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
    ...overrides,
  };
}

function renderNoteList(
  overrides: Partial<React.ComponentProps<typeof NoteListPanel>> = {},
): string {
  return renderToStaticMarkup(
    React.createElement(NoteListPanel, {
      notes: [noteSummary()],
      total: 1,
      selectedId: null,
      selectedIds: new Set<string>(),
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
      virtualizationScope: "swipe-actions-test",
      ...overrides,
    }),
  );
}

describe("swipe gesture decisions", () => {
  test("opens after a decisive left drag but does not auto-run an action", () => {
    expect(shouldOpenSwipeActions(-58, 144, 0)).toBe(true);
    expect(shouldOpenSwipeActions(-56, 144, 0)).toBe(false);
    expect(shouldOpenSwipeActions(-12, 144, -0.36)).toBe(true);
  });

  test("a rightward release closes an open action tray", () => {
    expect(shouldOpenSwipeActions(-54, 144, 0.45)).toBe(false);
    expect(shouldOpenSwipeActions(0, 144, 0)).toBe(false);
  });

  test("keeps a decisively revealed tray open if Safari cancels the touch sequence", () => {
    expect(shouldKeepSwipeActionsOpenAfterCancel(-58, 144)).toBe(true);
    expect(shouldKeepSwipeActionsOpenAfterCancel(-56, 144)).toBe(false);
  });
});

describe("note list swipe actions", () => {
  test("exposes restore and permanent delete as named icon-only buttons", () => {
    const html = renderNoteList({
      notes: [noteSummary({ deletedAt: 1_700_000_100 })],
      view: "trash",
      isMobileViewport: true,
    });

    expect(html).toContain('aria-label="恢复笔记：未命名笔记"');
    expect(html).toContain('aria-label="彻底删除笔记：未命名笔记"');
    // 图标按钮不能退回成可见文字按钮。
    expect(html).not.toContain("<span>恢复</span>");
    expect(html).not.toContain("<span>彻底删除</span>");
    expect(html).not.toContain("<span>移入回收站</span>");
  });

  test("names the trash action for notes that are not deleted yet", () => {
    const html = renderNoteList({ isMobileViewport: true });

    expect(html).toContain('aria-label="移入回收站：未命名笔记"');
    expect(html).not.toContain('aria-label="恢复笔记');
  });

  test("does not mark the opened note as active on mobile, but does on desktop", () => {
    expect(renderNoteList({ selectedId: "note-1", isMobileViewport: true })).not.toContain(
      "note-row is-active",
    );
    expect(renderNoteList({ selectedId: "note-1", isMobileViewport: false })).toContain(
      "is-active",
    );
  });

  test("links the swipe tray to the row it belongs to", () => {
    const html = renderNoteList({ isMobileViewport: true });

    expect(html).toContain('aria-controls="note-actions-note-1"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('role="group" aria-label="未命名笔记的操作"');
  });
});

describe("notebook actions on mobile", () => {
  const notebooks: Notebook[] = [
    {
      id: "notebook-1",
      name: "项目笔记",
      color: "blue",
      icon: "folder",
      isSystem: false,
      count: 2,
      updatedAt: 1_700_000_000,
    },
  ];

  test("exposes edit and delete as named icon-only buttons", () => {
    const html = renderToStaticMarkup(
      React.createElement(MobileNotebookHome, {
        view: "all",
        setView: () => {},
        notebooks,
        setNotebookId: () => {},
        onCreateNotebook: () => {},
        onEditNotebook: () => {},
        onDeleteNotebook: () => {},
        onLogout: () => {},
      }),
    );

    expect(html).toContain('aria-label="编辑笔记本：项目笔记"');
    expect(html).toContain('aria-label="删除笔记本：项目笔记"');
    expect(html).not.toContain("<span>编辑</span>");
    expect(html).not.toContain("<span>删除</span>");
  });
});
