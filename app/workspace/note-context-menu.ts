import { ArrowUpRight, LayoutGrid, List, ListChecks, Plus, RotateCcw, Star, Trash2, X } from "lucide-react";
import type { ContextMenuItem } from "../context-menu";
import type { NoteSummary, NoteView } from "../../shared/types";
import type { NoteSwipeAction } from "./swipe-actions";

export type NoteContextMenuActions = {
  clearSelection: () => void;
  /** 打开笔记：列表视图下选中，卡片视图下进入编辑。 */
  openNote: (note: NoteSummary) => void;
  /** 反转该笔记的多选状态（等价于按住修饰键点击）。 */
  toggleSelection: (noteId: string) => void;
  swipeAction: (note: NoteSummary, action: NoteSwipeAction) => void;
  restoreSelected: () => void;
  deleteSelected: () => void;
  toggleFavorite: (note: NoteSummary) => void;
};

export type NoteContextMenuInput = {
  note: NoteSummary;
  view: NoteView;
  selectedIds: ReadonlySet<string>;
  /** 回收站相关操作进行中时禁用破坏性动作。 */
  busy: boolean;
  actions: NoteContextMenuActions;
};

/**
 * 笔记列表与卡片网格共用的右键菜单。抽成纯函数后可以直接断言菜单项、
 * 顺序与禁用态，而不必读取组件源码字符串。
 */
export function buildNoteContextMenuItems({ note, view, selectedIds, busy, actions }: NoteContextMenuInput): ContextMenuItem[] {
  const isSelected = selectedIds.has(note.id);
  const multiSelected = isSelected && selectedIds.size > 1;

  const items: ContextMenuItem[] = [
    {
      label: "打开笔记",
      icon: ArrowUpRight,
      onSelect: () => {
        actions.clearSelection();
        actions.openNote(note);
      },
    },
    {
      label: isSelected ? "从多选中移除" : "加入多选",
      icon: ListChecks,
      onSelect: () => actions.toggleSelection(note.id),
    },
  ];

  if (selectedIds.size) items.push({ label: "退出多选", icon: X, separator: true, onSelect: actions.clearSelection });

  if (note.deletedAt) {
    items.push({ label: "恢复笔记", icon: RotateCcw, disabled: busy, onSelect: () => actions.swipeAction(note, "restore") });
    if (multiSelected) {
      items.push({
        label: `恢复所选 ${selectedIds.size} 篇笔记`,
        icon: RotateCcw,
        disabled: busy,
        onSelect: actions.restoreSelected,
      });
    }
  } else {
    items.push({
      label: note.isFavorite ? "取消收藏" : "收藏笔记",
      icon: Star,
      onSelect: () => actions.toggleFavorite(note),
    });
  }

  items.push({
    label: note.deletedAt ? "彻底删除" : "移入回收站",
    icon: Trash2,
    danger: true,
    separator: true,
    disabled: busy,
    onSelect: () => actions.swipeAction(note, note.deletedAt ? "permanent-delete" : "trash"),
  });

  if (multiSelected) {
    items.push({
      label: `${view === "trash" ? "彻底删除" : "移入回收站"}所选 ${selectedIds.size} 篇笔记`,
      icon: Trash2,
      danger: true,
      disabled: busy,
      onSelect: actions.deleteSelected,
    });
  }

  return items;
}

/** 与 workspace 的 ViewLayout 保持一致，但本地声明以避免与 workspace.tsx 循环依赖。 */
type NoteListLayout = "three-column" | "cards";

/** 笔记列表/卡片容器（非笔记区域）的右键菜单。 */
export function buildWorkspaceMenuItems(input: {
  view: NoteView;
  viewLayout: NoteListLayout;
  query: string;
  hasSelection: boolean;
  totalNotes: number;
  busy: boolean;
  actions: {
    newNote: () => void;
    toggleLayout: () => void;
    clearQuery: () => void;
    clearSelection: () => void;
    emptyTrash: () => void;
  };
}): ContextMenuItem[] {
  const { view, viewLayout, query, hasSelection, totalNotes, busy, actions } = input;
  const items: ContextMenuItem[] = [];
  if (view !== "trash") items.push({ label: "新建笔记", icon: Plus, onSelect: actions.newNote });
  items.push({
    label: viewLayout === "cards" ? "切换为列表视图" : "切换为卡片视图",
    icon: viewLayout === "cards" ? List : LayoutGrid,
    onSelect: actions.toggleLayout,
  });
  if (query) items.push({ label: "清空搜索", icon: X, onSelect: actions.clearQuery });
  if (hasSelection) items.push({ label: "取消多选", icon: X, onSelect: actions.clearSelection });
  if (view === "trash") {
    items.push({
      label: "清空回收站",
      icon: Trash2,
      danger: true,
      separator: true,
      disabled: !totalNotes || busy,
      onSelect: actions.emptyTrash,
    });
  }
  return items;
}
