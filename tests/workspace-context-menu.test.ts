import { describe, expect, test } from "bun:test";
import {
  buildNoteContextMenuItems,
  buildWorkspaceMenuItems,
  type NoteContextMenuActions,
} from "../app/workspace/note-context-menu";
import type { ContextMenuItem } from "../app/context-menu";
import type { NoteSummary } from "../shared/types";

function noteSummary(overrides: Partial<NoteSummary> = {}): NoteSummary {
  return {
    id: "note-1",
    title: "笔记一",
    preview: "",
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

function menuActions() {
  const calls: string[] = [];
  const actions: NoteContextMenuActions & { calls: string[] } = {
    calls,
    clearSelection: () => calls.push("clearSelection"),
    openNote: (note) => calls.push(`open:${note.id}`),
    toggleSelection: (noteId) => calls.push(`toggle:${noteId}`),
    swipeAction: (note, action) => calls.push(`swipe:${action}:${note.id}`),
    restoreSelected: () => calls.push("restoreSelected"),
    deleteSelected: () => calls.push("deleteSelected"),
    toggleFavorite: (note) => calls.push(`favorite:${note.id}`),
  };
  return actions;
}

const labels = (items: ContextMenuItem[]) => items.map((item) => item.label);
const find = (items: ContextMenuItem[], label: string) => {
  const item = items.find((candidate) => candidate.label === label);
  if (!item) throw new Error(`missing menu item: ${label} (have ${labels(items).join(" / ")})`);
  return item;
};

describe("note context menu", () => {
  test("offers a selection toggle for note targets shared by list and card views", () => {
    const actions = menuActions();
    const items = buildNoteContextMenuItems({
      note: noteSummary(),
      view: "all",
      selectedIds: new Set<string>(),
      busy: false,
      actions,
    });

    expect(labels(items)).toContain("加入多选");
    find(items, "加入多选").onSelect();
    expect(actions.calls).toEqual(["toggle:note-1"]);
  });

  test("offers open in split when openInSplit action is provided", () => {
    const actions = menuActions();
    const splitCalls: string[] = [];
    const items = buildNoteContextMenuItems({
      note: noteSummary(),
      view: "all",
      selectedIds: new Set<string>(),
      busy: false,
      actions: {
        ...actions,
        openInSplit: (note) => splitCalls.push(`split:${note.id}`),
      },
    });

    expect(labels(items)).toContain("在分屏中打开");
    find(items, "在分屏中打开").onSelect();
    expect(actions.calls).toEqual(["clearSelection"]);
    expect(splitCalls).toEqual(["split:note-1"]);
  });

  test("omits open in split when openInSplit action is undefined (three-column or mobile)", () => {
    const items = buildNoteContextMenuItems({
      note: noteSummary(),
      view: "all",
      selectedIds: new Set<string>(),
      busy: false,
      actions: {
        ...menuActions(),
        openInSplit: undefined,
      },
    });

    expect(labels(items)).not.toContain("在分屏中打开");
  });

  test("turns the toggle into removal once the note is selected", () => {
    const items = buildNoteContextMenuItems({
      note: noteSummary(),
      view: "all",
      selectedIds: new Set(["note-1"]),
      busy: false,
      actions: menuActions(),
    });

    expect(labels(items)).toContain("从多选中移除");
    expect(labels(items)).not.toContain("加入多选");
  });

  test("offers an exit selection action on note context menus while multi-select is active", () => {
    const actions = menuActions();
    const items = buildNoteContextMenuItems({
      note: noteSummary(),
      view: "all",
      selectedIds: new Set(["note-1", "note-2"]),
      busy: false,
      actions,
    });

    const exit = find(items, "退出多选");
    expect(exit.separator).toBe(true);
    exit.onSelect();
    expect(actions.calls).toEqual(["clearSelection"]);
  });

  test("opening a note clears the selection first and never toggles it", () => {
    const actions = menuActions();
    const items = buildNoteContextMenuItems({
      note: noteSummary(),
      view: "all",
      selectedIds: new Set(["note-1", "note-2"]),
      busy: false,
      actions,
    });

    find(items, "打开笔记").onSelect();
    expect(actions.calls).toEqual(["clearSelection", "open:note-1"]);
  });

  test("offers bulk restore only for a selected trashed note in a multi-selection", () => {
    const trashed = noteSummary({ deletedAt: 1_700_000_100 });

    const single = buildNoteContextMenuItems({
      note: trashed,
      view: "trash",
      selectedIds: new Set(["note-1"]),
      busy: false,
      actions: menuActions(),
    });
    expect(labels(single)).toContain("恢复笔记");
    expect(labels(single)).not.toContain("恢复所选 1 篇笔记");

    const actions = menuActions();
    const bulk = buildNoteContextMenuItems({
      note: trashed,
      view: "trash",
      selectedIds: new Set(["note-1", "note-2"]),
      busy: false,
      actions,
    });
    const restore = find(bulk, "恢复所选 2 篇笔记");
    expect(restore.disabled).toBe(false);
    restore.onSelect();
    expect(actions.calls).toEqual(["restoreSelected"]);
  });

  test("keeps bulk trash actions aware of the current view", () => {
    const inTrash = buildNoteContextMenuItems({
      note: noteSummary({ deletedAt: 1_700_000_100 }),
      view: "trash",
      selectedIds: new Set(["note-1", "note-2"]),
      busy: false,
      actions: menuActions(),
    });
    expect(labels(inTrash)).toContain("彻底删除所选 2 篇笔记");

    const inInbox = buildNoteContextMenuItems({
      note: noteSummary(),
      view: "inbox",
      selectedIds: new Set(["note-1", "note-2"]),
      busy: false,
      actions: menuActions(),
    });
    expect(labels(inInbox)).toContain("移入回收站所选 2 篇笔记");
  });

  test("disables destructive actions while the trash is busy", () => {
    const actions = menuActions();
    const items = buildNoteContextMenuItems({
      note: noteSummary({ deletedAt: 1_700_000_100 }),
      view: "trash",
      selectedIds: new Set(["note-1", "note-2"]),
      busy: true,
      actions,
    });

    expect(find(items, "恢复笔记").disabled).toBe(true);
    expect(find(items, "恢复所选 2 篇笔记").disabled).toBe(true);
    expect(find(items, "彻底删除").disabled).toBe(true);
    expect(find(items, "彻底删除所选 2 篇笔记").disabled).toBe(true);
  });

  test("swaps the favorite action for trashed notes", () => {
    const actions = menuActions();
    const favorite = buildNoteContextMenuItems({
      note: noteSummary({ isFavorite: true }),
      view: "all",
      selectedIds: new Set<string>(),
      busy: false,
      actions,
    });
    find(favorite, "取消收藏").onSelect();
    expect(actions.calls).toEqual(["favorite:note-1"]);

    const trashed = buildNoteContextMenuItems({
      note: noteSummary({ deletedAt: 1_700_000_100 }),
      view: "trash",
      selectedIds: new Set<string>(),
      busy: false,
      actions: menuActions(),
    });
    expect(labels(trashed)).not.toContain("收藏笔记");
    expect(labels(trashed)).not.toContain("取消收藏");
  });
});

describe("workspace context menu", () => {
  const actions = () => {
    const calls: string[] = [];
    return {
      calls,
      newNote: () => calls.push("newNote"),
      toggleLayout: () => calls.push("toggleLayout"),
      clearQuery: () => calls.push("clearQuery"),
      clearSelection: () => calls.push("clearSelection"),
      emptyTrash: () => calls.push("emptyTrash"),
    };
  };

  test("offers new note and layout switching outside the trash", () => {
    const handler = actions();
    const items = buildWorkspaceMenuItems({
      view: "all",
      viewLayout: "cards",
      query: "",
      hasSelection: false,
      totalNotes: 3,
      busy: false,
      actions: handler,
    });

    expect(labels(items)).toEqual(["新建笔记", "切换为列表视图"]);
    find(items, "切换为列表视图").onSelect();
    expect(handler.calls).toEqual(["toggleLayout"]);
  });

  test("only enables empty trash when the trash holds notes and nothing is running", () => {
    const build = (totalNotes: number, busy: boolean) =>
      buildWorkspaceMenuItems({
        view: "trash",
        viewLayout: "three-column",
        query: "",
        hasSelection: false,
        totalNotes,
        busy,
        actions: actions(),
      });

    expect(find(build(2, false), "清空回收站").disabled).toBe(false);
    expect(find(build(0, false), "清空回收站").disabled).toBe(true);
    expect(find(build(2, true), "清空回收站").disabled).toBe(true);
    expect(labels(build(2, false))).not.toContain("新建笔记");
  });
});
