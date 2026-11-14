import {
  ArrowUpRight,
  Bold,
  Calendar,
  Check,
  ClipboardPaste,
  Copy,
  FileText,
  Hash,
  Italic,
  Pencil,
  Plus,
  Redo2,
  RemoveFormatting,
  RotateCcw,
  Scissors,
  Tag,
  TextSelect,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import type { Memo } from "../../shared/types";
import type { ContextMenuItem } from "../context-menu";
import { modKey } from "../platform";
import { localDateKey, timelineDateLabel } from "./memo-date";

export type MemoCardContextMenuInput = {
  memo: Memo;
  isEditing: boolean;
  selectedDate: string | null;
  activeTag: string | null;
  selectedText?: string;
  linkUrl?: string;
  actions: {
    startEdit: (memo: Memo) => void;
    copyContent: (content: string) => void | Promise<void>;
    filterDate: (date: string | null) => void;
    filterTag: (tag: string | null) => void;
    deleteMemo: (memo: Memo) => void | Promise<void>;
    openLink?: (url: string) => void;
  };
};

export function buildMemoCardMenuItems({
  memo,
  isEditing,
  selectedDate,
  activeTag,
  selectedText,
  linkUrl,
  actions,
}: MemoCardContextMenuInput): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];

  if (linkUrl && actions.openLink) {
    items.push(
      {
        label: "打开链接",
        icon: ArrowUpRight,
        onSelect: () => actions.openLink!(linkUrl),
      },
      {
        label: "复制链接地址",
        icon: Copy,
        onSelect: () => actions.copyContent(linkUrl),
      },
    );
  }

  if (!isEditing) {
    items.push({
      label: "编辑随记",
      icon: Pencil,
      separator: items.length > 0,
      onSelect: () => actions.startEdit(memo),
    });
  }

  if (selectedText && selectedText.trim()) {
    items.push(
      {
        label: "复制所选文字",
        icon: Copy,
        onSelect: () => actions.copyContent(selectedText),
      },
      {
        label: "复制随记内容",
        icon: Copy,
        onSelect: () => actions.copyContent(memo.contentMarkdown),
      },
    );
  } else {
    items.push({
      label: "复制内容",
      icon: Copy,
      onSelect: () => actions.copyContent(memo.contentMarkdown),
    });
  }

  const memoDate = localDateKey(memo.createdAt);
  if (selectedDate === memoDate) {
    items.push({
      label: "清除日期筛选",
      icon: RotateCcw,
      separator: true,
      onSelect: () => actions.filterDate(null),
    });
  } else {
    items.push({
      label: `按此日期筛选 (${timelineDateLabel(memoDate)})`,
      icon: Calendar,
      separator: true,
      onSelect: () => actions.filterDate(memoDate),
    });
  }

  if (memo.tags && memo.tags.length > 0) {
    for (const tag of memo.tags) {
      if (activeTag === tag) {
        items.push({
          label: `清除 #${tag} 标签筛选`,
          icon: X,
          onSelect: () => actions.filterTag(null),
        });
      } else {
        items.push({
          label: `按 #${tag} 筛选`,
          icon: Hash,
          onSelect: () => actions.filterTag(tag),
        });
      }
    }
  }

  items.push({
    label: "删除随记",
    icon: Trash2,
    danger: true,
    separator: true,
    disabled: isEditing,
    onSelect: () => actions.deleteMemo(memo),
  });

  return items;
}

export type MemoFeedContextMenuInput = {
  hasQuery: boolean;
  hasTag: boolean;
  hasDate: boolean;
  activeTag: string | null;
  selectedDate: string | null;
  actions: {
    newMemo: () => void;
    refresh: () => void;
    clearQuery: () => void;
    clearTag: () => void;
    clearDate: () => void;
    clearAllFilters: () => void;
  };
};

export function buildMemoFeedMenuItems({
  hasQuery,
  hasTag,
  hasDate,
  activeTag,
  selectedDate,
  actions,
}: MemoFeedContextMenuInput): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    {
      label: "新建随记",
      icon: Plus,
      onSelect: actions.newMemo,
    },
    {
      label: "刷新随记",
      icon: RotateCcw,
      onSelect: actions.refresh,
    },
  ];

  const activeCount = [hasQuery, hasTag, hasDate].filter(Boolean).length;
  if (activeCount > 1) {
    items.push({
      label: "清除全部筛选",
      icon: X,
      separator: true,
      onSelect: actions.clearAllFilters,
    });
  }

  if (hasQuery) {
    items.push({
      label: "清空搜索",
      icon: X,
      separator: activeCount === 1,
      onSelect: actions.clearQuery,
    });
  }

  if (hasTag && activeTag) {
    items.push({
      label: `清除 #${activeTag} 标签筛选`,
      icon: X,
      separator: activeCount === 1 && !hasQuery,
      onSelect: actions.clearTag,
    });
  }

  if (hasDate && selectedDate) {
    items.push({
      label: `清除 ${timelineDateLabel(selectedDate)} 日期筛选`,
      icon: X,
      separator: activeCount === 1 && !hasQuery && !hasTag,
      onSelect: actions.clearDate,
    });
  }

  return items;
}

export type MemoCalendarContextMenuInput = {
  date?: string | null;
  today: string;
  selectedDate: string | null;
  actions: {
    selectDate: (date: string | null) => void;
    newMemoOnDate: (date: string) => void;
    goToToday: () => void;
  };
};

export function buildMemoCalendarMenuItems({
  date,
  today,
  selectedDate,
  actions,
}: MemoCalendarContextMenuInput): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];

  if (date) {
    if (selectedDate === date) {
      items.push({
        label: "清除日期筛选",
        icon: RotateCcw,
        onSelect: () => actions.selectDate(null),
      });
    } else {
      items.push({
        label: `按此日期筛选 (${timelineDateLabel(date)})`,
        icon: Calendar,
        onSelect: () => actions.selectDate(date),
      });
    }

    items.push({
      label: `在${date === today ? "今天" : timelineDateLabel(date)}新建随记`,
      icon: Plus,
      onSelect: () => actions.newMemoOnDate(date),
    });

    if (date !== today) {
      items.push({
        label: "回到今天",
        icon: Calendar,
        separator: true,
        onSelect: actions.goToToday,
      });
    }
  } else {
    items.push({
      label: "回到今天",
      icon: Calendar,
      onSelect: actions.goToToday,
    });

    if (selectedDate) {
      items.push({
        label: "清除日期筛选",
        icon: RotateCcw,
        separator: true,
        onSelect: () => actions.selectDate(null),
      });
    }
  }

  return items;
}

export type MemoTagContextMenuInput = {
  tag?: string | null;
  activeTag: string | null;
  actions: {
    selectTag: (tag: string | null) => void;
    copyTagName: (tag: string) => void | Promise<void>;
  };
};

export function buildMemoTagMenuItems({
  tag,
  activeTag,
  actions,
}: MemoTagContextMenuInput): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];

  if (tag) {
    if (activeTag === tag) {
      items.push({
        label: "取消标签筛选",
        icon: X,
        onSelect: () => actions.selectTag(null),
      });
    } else {
      items.push({
        label: `按 #${tag} 筛选`,
        icon: Tag,
        onSelect: () => actions.selectTag(tag),
      });
    }

    items.push({
      label: "复制标签名",
      icon: Copy,
      separator: true,
      onSelect: () => actions.copyTagName(tag),
    });
  } else {
    if (activeTag) {
      items.push({
        label: "显示全部标签",
        icon: X,
        onSelect: () => actions.selectTag(null),
      });
    }
  }

  return items;
}

export type MemoComposerContextMenuInput = {
  canUndo: boolean;
  canRedo: boolean;
  hasSelection: boolean;
  editable: boolean;
  isEditingMemo?: boolean;
  actions: {
    undo: () => void;
    redo: () => void;
    cut: () => void | Promise<void>;
    copy: () => void | Promise<void>;
    paste: () => void | Promise<void>;
    pastePlain: () => void | Promise<void>;
    selectAll: () => void;
    toggleBold?: () => void;
    toggleItalic?: () => void;
    clearFormatting?: () => void;
    submit?: () => void;
    cancel?: () => void;
  };
};

export function buildMemoComposerMenuItems({
  canUndo,
  canRedo,
  hasSelection,
  editable,
  isEditingMemo,
  actions,
}: MemoComposerContextMenuInput): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    {
      label: "撤销",
      icon: Undo2,
      shortcut: `${modKey} Z`,
      disabled: !editable || !canUndo,
      onSelect: actions.undo,
    },
    {
      label: "重做",
      icon: Redo2,
      shortcut: `${modKey} ⇧ Z`,
      disabled: !editable || !canRedo,
      onSelect: actions.redo,
    },
    {
      label: "剪切",
      icon: Scissors,
      shortcut: `${modKey} X`,
      separator: true,
      disabled: !editable || !hasSelection,
      onSelect: actions.cut,
    },
    {
      label: "复制",
      icon: Copy,
      shortcut: `${modKey} C`,
      disabled: !hasSelection,
      onSelect: actions.copy,
    },
    {
      label: "粘贴",
      icon: ClipboardPaste,
      shortcut: `${modKey} V`,
      disabled: !editable,
      onSelect: actions.paste,
    },
    {
      label: "粘贴为纯文本",
      icon: FileText,
      disabled: !editable,
      onSelect: actions.pastePlain,
    },
    {
      label: "全选",
      icon: TextSelect,
      shortcut: `${modKey} A`,
      separator: true,
      onSelect: actions.selectAll,
    },
  ];

  if (hasSelection && editable) {
    if (actions.toggleBold) {
      items.push({
        label: "加粗",
        icon: Bold,
        shortcut: `${modKey} B`,
        separator: true,
        onSelect: actions.toggleBold,
      });
    }
    if (actions.toggleItalic) {
      items.push({
        label: "斜体",
        icon: Italic,
        shortcut: `${modKey} I`,
        onSelect: actions.toggleItalic,
      });
    }
    if (actions.clearFormatting) {
      items.push({
        label: "清除文字格式",
        icon: RemoveFormatting,
        onSelect: actions.clearFormatting,
      });
    }
  }

  if (isEditingMemo) {
    if (actions.submit) {
      items.push({
        label: "保存修改",
        icon: Check,
        shortcut: `${modKey} ↵`,
        separator: true,
        onSelect: actions.submit,
      });
    }
    if (actions.cancel) {
      items.push({
        label: "取消编辑",
        icon: X,
        shortcut: "Esc",
        onSelect: actions.cancel,
      });
    }
  }

  return items;
}
