import { describe, expect, test } from "bun:test";
import {
  buildMemoCalendarMenuItems,
  buildMemoCardMenuItems,
  buildMemoComposerMenuItems,
  buildMemoFeedMenuItems,
  buildMemoTagMenuItems,
} from "../app/memos/memo-context-menu";
import { createWorkspaceContextMenuHandler } from "../app/workspace/workspace-context-menu";
import type { ContextMenuItem } from "../app/context-menu";
import type { Memo } from "../shared/types";
import { localDateKey, timelineDateLabel } from "../app/memos/memo-date";

function memo(overrides: Partial<Memo> = {}): Memo {
  const now = 1_700_000_000_000;
  return {
    id: "memo-1",
    contentMarkdown: "这是一条测试随记 #工作 #灵感",
    tags: ["工作", "灵感"],
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const labels = (items: ContextMenuItem[]) => items.map((item) => item.label);
const find = (items: ContextMenuItem[], label: string) => {
  const item = items.find((candidate) => candidate.label === label);
  if (!item) throw new Error(`missing menu item: ${label} (have ${labels(items).join(" / ")})`);
  return item;
};

describe("memo card context menu", () => {
  test("offers edit, copy, date filter, tag filters, and delete for a normal memo", () => {
    const calls: string[] = [];
    const target = memo();
    const memoDate = localDateKey(target.createdAt);

    const items = buildMemoCardMenuItems({
      memo: target,
      isEditing: false,
      selectedDate: null,
      activeTag: null,
      actions: {
        startEdit: (m) => {
          calls.push(`edit:${m.id}`);
        },
        copyContent: (content) => {
          calls.push(`copy:${content}`);
        },
        filterDate: (d) => {
          calls.push(`date:${d}`);
        },
        filterTag: (t) => {
          calls.push(`tag:${t}`);
        },
        deleteMemo: (m) => {
          calls.push(`delete:${m.id}`);
        },
      },
    });

    expect(labels(items)).toContain("编辑随记");
    expect(labels(items)).toContain("复制内容");
    expect(labels(items)).toContain(`按此日期筛选 (${timelineDateLabel(memoDate)})`);
    expect(labels(items)).toContain("按 #工作 筛选");
    expect(labels(items)).toContain("按 #灵感 筛选");
    expect(labels(items)).toContain("删除随记");

    find(items, "编辑随记").onSelect();
    expect(calls).toEqual(["edit:memo-1"]);

    find(items, "复制内容").onSelect();
    expect(calls).toContain(`copy:${target.contentMarkdown}`);

    find(items, `按此日期筛选 (${timelineDateLabel(memoDate)})`).onSelect();
    expect(calls).toContain(`date:${memoDate}`);

    find(items, "按 #工作 筛选").onSelect();
    expect(calls).toContain("tag:工作");

    const deleteItem = find(items, "删除随记");
    expect(deleteItem.danger).toBe(true);
    expect(deleteItem.separator).toBe(true);
    expect(deleteItem.disabled).toBe(false);
    deleteItem.onSelect();
    expect(calls).toContain("delete:memo-1");
  });

  test("omits edit action and disables delete when memo is currently being edited", () => {
    const target = memo();
    const items = buildMemoCardMenuItems({
      memo: target,
      isEditing: true,
      selectedDate: null,
      activeTag: null,
      actions: {
        startEdit: () => {},
        copyContent: () => {},
        filterDate: () => {},
        filterTag: () => {},
        deleteMemo: () => {},
      },
    });

    expect(labels(items)).not.toContain("编辑随记");
    expect(find(items, "删除随记").disabled).toBe(true);
  });

  test("swaps date filter to clear when date is already selected", () => {
    const calls: string[] = [];
    const target = memo();
    const memoDate = localDateKey(target.createdAt);

    const items = buildMemoCardMenuItems({
      memo: target,
      isEditing: false,
      selectedDate: memoDate,
      activeTag: null,
      actions: {
        startEdit: () => {},
        copyContent: () => {},
        filterDate: (d) => calls.push(`date:${d}`),
        filterTag: () => {},
        deleteMemo: () => {},
      },
    });

    expect(labels(items)).toContain("清除日期筛选");
    find(items, "清除日期筛选").onSelect();
    expect(calls).toEqual(["date:null"]);
  });

  test("swaps tag filter to clear when tag is already active", () => {
    const calls: string[] = [];
    const target = memo();

    const items = buildMemoCardMenuItems({
      memo: target,
      isEditing: false,
      selectedDate: null,
      activeTag: "工作",
      actions: {
        startEdit: () => {},
        copyContent: () => {},
        filterDate: () => {},
        filterTag: (t) => calls.push(`tag:${t}`),
        deleteMemo: () => {},
      },
    });

    expect(labels(items)).toContain("清除 #工作 标签筛选");
    expect(labels(items)).toContain("按 #灵感 筛选");
    find(items, "清除 #工作 标签筛选").onSelect();
    expect(calls).toEqual(["tag:null"]);
  });

  test("offers copy selected text when text selection exists within card", () => {
    const calls: string[] = [];
    const target = memo();

    const items = buildMemoCardMenuItems({
      memo: target,
      isEditing: false,
      selectedDate: null,
      activeTag: null,
      selectedText: "选中的部分文字",
      actions: {
        startEdit: () => {},
        copyContent: (content) => {
          calls.push(`copy:${content}`);
        },
        filterDate: () => {},
        filterTag: () => {},
        deleteMemo: () => {},
      },
    });

    expect(labels(items)).toContain("复制所选文字");
    expect(labels(items)).toContain("复制随记内容");
    find(items, "复制所选文字").onSelect();
    expect(calls).toEqual(["copy:选中的部分文字"]);
  });

  test("offers open and copy link when right clicking a link within card", () => {
    const calls: string[] = [];
    const target = memo();

    const items = buildMemoCardMenuItems({
      memo: target,
      isEditing: false,
      selectedDate: null,
      activeTag: null,
      linkUrl: "https://example.com/doc",
      actions: {
        startEdit: () => {},
        copyContent: (c) => {
          calls.push(`copy:${c}`);
        },
        filterDate: () => {},
        filterTag: () => {},
        deleteMemo: () => {},
        openLink: (url) => calls.push(`open:${url}`),
      },
    });

    expect(labels(items)).toContain("打开链接");
    expect(labels(items)).toContain("复制链接地址");
    find(items, "打开链接").onSelect();
    expect(calls).toContain("open:https://example.com/doc");
    find(items, "复制链接地址").onSelect();
    expect(calls).toContain("copy:https://example.com/doc");
  });
});

describe("memo feed context menu", () => {
  test("offers new memo and refresh by default", () => {
    const calls: string[] = [];
    const items = buildMemoFeedMenuItems({
      hasQuery: false,
      hasTag: false,
      hasDate: false,
      activeTag: null,
      selectedDate: null,
      actions: {
        newMemo: () => calls.push("newMemo"),
        refresh: () => calls.push("refresh"),
        clearQuery: () => calls.push("clearQuery"),
        clearTag: () => calls.push("clearTag"),
        clearDate: () => calls.push("clearDate"),
        clearAllFilters: () => calls.push("clearAllFilters"),
      },
    });

    expect(labels(items)).toEqual(["新建随记", "刷新随记"]);
    find(items, "新建随记").onSelect();
    find(items, "刷新随记").onSelect();
    expect(calls).toEqual(["newMemo", "refresh"]);
  });

  test("offers clear search when query exists", () => {
    const calls: string[] = [];
    const items = buildMemoFeedMenuItems({
      hasQuery: true,
      hasTag: false,
      hasDate: false,
      activeTag: null,
      selectedDate: null,
      actions: {
        newMemo: () => {},
        refresh: () => {},
        clearQuery: () => calls.push("clearQuery"),
        clearTag: () => {},
        clearDate: () => {},
        clearAllFilters: () => {},
      },
    });

    expect(labels(items)).toContain("清空搜索");
    find(items, "清空搜索").onSelect();
    expect(calls).toEqual(["clearQuery"]);
  });

  test("offers clear all filters when multiple filters are active", () => {
    const calls: string[] = [];
    const items = buildMemoFeedMenuItems({
      hasQuery: true,
      hasTag: true,
      hasDate: true,
      activeTag: "生活",
      selectedDate: "2026-01-01",
      actions: {
        newMemo: () => {},
        refresh: () => {},
        clearQuery: () => calls.push("clearQuery"),
        clearTag: () => calls.push("clearTag"),
        clearDate: () => calls.push("clearDate"),
        clearAllFilters: () => calls.push("clearAllFilters"),
      },
    });

    expect(labels(items)).toContain("清除全部筛选");
    expect(labels(items)).toContain("清空搜索");
    expect(labels(items)).toContain("清除 #生活 标签筛选");
    expect(labels(items)).toContain(`清除 ${timelineDateLabel("2026-01-01")} 日期筛选`);
    find(items, "清除全部筛选").onSelect();
    expect(calls).toEqual(["clearAllFilters"]);
  });
});

describe("memo calendar context menu", () => {
  test("offers filter, new memo on date, and go to today for a specific day", () => {
    const calls: string[] = [];
    const items = buildMemoCalendarMenuItems({
      date: "2026-05-20",
      today: "2026-05-18",
      selectedDate: null,
      actions: {
        selectDate: (d) => calls.push(`select:${d}`),
        newMemoOnDate: (d) => calls.push(`new:${d}`),
        goToToday: () => calls.push("goToToday"),
      },
    });

    expect(labels(items)).toContain(`按此日期筛选 (${timelineDateLabel("2026-05-20")})`);
    expect(labels(items)).toContain(`在${timelineDateLabel("2026-05-20")}新建随记`);
    expect(labels(items)).toContain("回到今天");

    find(items, `在${timelineDateLabel("2026-05-20")}新建随记`).onSelect();
    expect(calls).toContain("new:2026-05-20");
  });

  test("omits go to today when already on today", () => {
    const items = buildMemoCalendarMenuItems({
      date: "2026-05-18",
      today: "2026-05-18",
      selectedDate: null,
      actions: {
        selectDate: () => {},
        newMemoOnDate: () => {},
        goToToday: () => {},
      },
    });

    expect(labels(items)).toContain("在今天新建随记");
    expect(labels(items)).not.toContain("回到今天");
  });

  test("swaps to clear date filter when date is selected", () => {
    const calls: string[] = [];
    const items = buildMemoCalendarMenuItems({
      date: "2026-05-20",
      today: "2026-05-18",
      selectedDate: "2026-05-20",
      actions: {
        selectDate: (d) => calls.push(`select:${d}`),
        newMemoOnDate: () => {},
        goToToday: () => {},
      },
    });

    expect(labels(items)).toContain("清除日期筛选");
    find(items, "清除日期筛选").onSelect();
    expect(calls).toEqual(["select:null"]);
  });

  test("offers go to today and clear date filter on calendar background", () => {
    const calls: string[] = [];
    const items = buildMemoCalendarMenuItems({
      date: null,
      today: "2026-05-18",
      selectedDate: "2026-05-20",
      actions: {
        selectDate: (d) => calls.push(`select:${d}`),
        newMemoOnDate: () => {},
        goToToday: () => calls.push("goToToday"),
      },
    });

    expect(labels(items)).toEqual(["回到今天", "清除日期筛选"]);
    find(items, "回到今天").onSelect();
    expect(calls).toEqual(["goToToday"]);
  });
});

describe("memo tag context menu", () => {
  test("offers filter and copy for a specific tag", () => {
    const calls: string[] = [];
    const items = buildMemoTagMenuItems({
      tag: "技术",
      activeTag: null,
      actions: {
        selectTag: (t) => calls.push(`select:${t}`),
        copyTagName: (t) => {
          calls.push(`copy:${t}`);
        },
      },
    });

    expect(labels(items)).toContain("按 #技术 筛选");
    expect(labels(items)).toContain("复制标签名");
    find(items, "按 #技术 筛选").onSelect();
    expect(calls).toContain("select:技术");
    find(items, "复制标签名").onSelect();
    expect(calls).toContain("copy:技术");
  });

  test("offers cancel filter when tag is currently active", () => {
    const calls: string[] = [];
    const items = buildMemoTagMenuItems({
      tag: "技术",
      activeTag: "技术",
      actions: {
        selectTag: (t) => calls.push(`select:${t}`),
        copyTagName: () => {},
      },
    });

    expect(labels(items)).toContain("取消标签筛选");
    find(items, "取消标签筛选").onSelect();
    expect(calls).toEqual(["select:null"]);
  });

  test("offers show all tags when clicking empty area with active tag", () => {
    const calls: string[] = [];
    const items = buildMemoTagMenuItems({
      tag: null,
      activeTag: "技术",
      actions: {
        selectTag: (t) => calls.push(`select:${t}`),
        copyTagName: () => {},
      },
    });

    expect(labels(items)).toContain("显示全部标签");
    find(items, "显示全部标签").onSelect();
    expect(calls).toEqual(["select:null"]);
  });
});

describe("memo composer context menu", () => {
  test("offers basic editing items and respects selection & undo states", () => {
    const calls: string[] = [];
    const items = buildMemoComposerMenuItems({
      canUndo: true,
      canRedo: false,
      hasSelection: true,
      editable: true,
      isEditingMemo: false,
      actions: {
        undo: () => calls.push("undo"),
        redo: () => calls.push("redo"),
        cut: () => {
          calls.push("cut");
        },
        copy: () => {
          calls.push("copy");
        },
        paste: () => {
          calls.push("paste");
        },
        pastePlain: () => {
          calls.push("pastePlain");
        },
        selectAll: () => calls.push("selectAll"),
        toggleBold: () => calls.push("bold"),
        toggleItalic: () => calls.push("italic"),
        clearFormatting: () => calls.push("clearFormat"),
      },
    });

    expect(find(items, "撤销").disabled).toBe(false);
    expect(find(items, "重做").disabled).toBe(true);
    expect(find(items, "剪切").disabled).toBe(false);
    expect(find(items, "复制").disabled).toBe(false);
    expect(find(items, "粘贴").disabled).toBe(false);
    expect(labels(items)).toContain("加粗");
    expect(labels(items)).toContain("斜体");
    expect(labels(items)).toContain("清除文字格式");

    find(items, "加粗").onSelect();
    expect(calls).toContain("bold");
  });

  test("offers save and cancel actions when editing existing memo", () => {
    const calls: string[] = [];
    const items = buildMemoComposerMenuItems({
      canUndo: false,
      canRedo: false,
      hasSelection: false,
      editable: true,
      isEditingMemo: true,
      actions: {
        undo: () => {},
        redo: () => {},
        cut: () => {},
        copy: () => {},
        paste: () => {},
        pastePlain: () => {},
        selectAll: () => {},
        submit: () => calls.push("save"),
        cancel: () => calls.push("cancel"),
      },
    });

    expect(labels(items)).toContain("保存修改");
    expect(labels(items)).toContain("取消编辑");
    find(items, "保存修改").onSelect();
    find(items, "取消编辑").onSelect();
    expect(calls).toEqual(["save", "cancel"]);
  });
});

describe("workspace context menu memo isolation", () => {
  test("workspace context menu handler ignores events originating from memo-page", () => {
    if (typeof globalThis.HTMLInputElement === "undefined") {
      (globalThis as any).HTMLInputElement = class HTMLInputElement {};
    }
    if (typeof globalThis.Element === "undefined") {
      (globalThis as any).Element = class Element {};
    }

    let opened = false;
    const handler = createWorkspaceContextMenuHandler({
      openWorkspaceMenu: () => {
        opened = true;
      },
      searchRef: { current: null },
      changeQuery: () => {},
      openKanbanNote: () => {},
      handleToggleFavoriteKanbanCard: () => {},
      kanbanColumnsRef: { current: {} as any },
      handleMoveKanbanCard: () => {},
      handleRemoveKanbanCard: () => {},
      handleTrashKanbanCard: () => {},
      handleCreateNoteInKanbanColumn: () => {},
      notesRef: { current: [] },
      pendingTrashCount: 0,
      emptyingTrash: false,
      view: "all",
      selectedNoteIds: new Set(),
      clearNoteSelection: () => {},
      viewLayout: "three-column",
      handleOpenCardNote: () => {},
      selectNote: () => {},
      isMobileViewport: false,
      openInSplit: () => {},
      handleToggleCardSelection: () => {},
      handleNoteSwipeAction: () => {},
      restoreSelectedNotes: () => {},
      deleteSelectedNotes: () => {},
      handleToggleFavoriteNote: () => {},
      handleAddExistingNoteToKanban: () => {},
      notebooks: [],
      selectNotebook: () => {},
      createNoteInNotebook: () => {},
      handleEditNotebook: () => {},
      handleDeleteNotebook: () => {},
      sidebarCollapsed: false,
      handleNewInboxNote: () => {},
      handleCreateNotebook: () => {},
      selectView: () => {},
      handleCollapseSidebar: () => {},
      closeOutline: () => {},
      query: "",
      totalNotes: 0,
      handleNewNote: () => {},
      toggleViewLayout: () => {},
      handleClearQuery: () => {},
      emptyTrash: () => {},
    });

    const dummyTarget = Object.assign(Object.create(globalThis.Element.prototype), {
      closest: (selector: string) => (selector.includes(".memo-page") ? ({} as Element) : null),
    });

    handler({
      target: dummyTarget,
      defaultPrevented: false,
      preventDefault() {},
    } as any);

    expect(opened).toBe(false);
  });
});
