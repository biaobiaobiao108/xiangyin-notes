import type { SuggestionMatch } from "@tiptap/suggestion";
import {
  Bold,
  Bookmark,
  Code,
  Code2,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Heading5,
  Heading6,
  ImagePlus,
  Info,
  Italic,
  Lightbulb,
  Link2,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  Network,
  Pilcrow,
  Quote,
  ShieldAlert,
  Strikethrough,
  Table2,
  TriangleAlert,
  Underline,
  type LucideIcon,
} from "lucide-react";
import type { CalloutType } from "./callout-node";

export type SlashAction =
  | "paragraph"
  | "heading"
  | "bulletList"
  | "orderedList"
  | "taskList"
  | "blockquote"
  | "codeBlock"
  | "mermaid"
  | "horizontalRule"
  | "callout"
  | "table"
  | "image"
  | "wikiLink"
  | "bold"
  | "italic"
  | "strike"
  | "underline"
  | "inlineCode";

export type SlashCommandGroupId = "text" | "lists" | "callouts" | "insert";

export const SLASH_COMMAND_COLUMN_COUNT = 3;

export type SlashCommandItem = {
  id: string;
  label: string;
  description: string;
  keywords: string[];
  icon: LucideIcon;
  action: SlashAction;
  group: SlashCommandGroupId;
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  calloutType?: CalloutType;
};

export const slashCommands: SlashCommandItem[] = [
  {
    id: "heading-1",
    label: "一级标题",
    description: "#",
    keywords: ["h1", "heading 1", "title", "标题 1"],
    icon: Heading1,
    action: "heading",
    group: "text",
    headingLevel: 1,
  },
  {
    id: "heading-2",
    label: "二级标题",
    description: "##",
    keywords: ["h2", "heading 2", "subtitle", "标题 2"],
    icon: Heading2,
    action: "heading",
    group: "text",
    headingLevel: 2,
  },
  {
    id: "heading-3",
    label: "三级标题",
    description: "###",
    keywords: ["h3", "heading 3", "标题 3"],
    icon: Heading3,
    action: "heading",
    group: "text",
    headingLevel: 3,
  },
  {
    id: "heading-4",
    label: "四级标题",
    description: "####",
    keywords: ["h4", "heading 4", "标题 4"],
    icon: Heading4,
    action: "heading",
    group: "text",
    headingLevel: 4,
  },
  {
    id: "heading-5",
    label: "五级标题",
    description: "#####",
    keywords: ["h5", "heading 5", "标题 5"],
    icon: Heading5,
    action: "heading",
    group: "text",
    headingLevel: 5,
  },
  {
    id: "heading-6",
    label: "六级标题",
    description: "######",
    keywords: ["h6", "heading 6", "标题 6"],
    icon: Heading6,
    action: "heading",
    group: "text",
    headingLevel: 6,
  },
  {
    id: "bold",
    label: "加粗",
    description: "**文本**",
    keywords: ["bold", "strong", "加粗", "粗体"],
    icon: Bold,
    action: "bold",
    group: "text",
  },
  {
    id: "italic",
    label: "斜体",
    description: "*文本*",
    keywords: ["italic", "emphasis", "斜体"],
    icon: Italic,
    action: "italic",
    group: "text",
  },
  {
    id: "strike",
    label: "删除线",
    description: "~~文本~~",
    keywords: ["strike", "strikethrough", "删除线"],
    icon: Strikethrough,
    action: "strike",
    group: "text",
  },
  {
    id: "underline",
    label: "下划线",
    description: "<u>文本</u>",
    keywords: ["underline", "下划线"],
    icon: Underline,
    action: "underline",
    group: "text",
  },
  {
    id: "inline-code",
    label: "行内代码",
    description: "从光标处开始使用行内代码",
    keywords: ["inline code", "code", "行内代码"],
    icon: Code,
    action: "inlineCode",
    group: "text",
  },
  {
    id: "paragraph",
    label: "正文段落",
    description: "普通段落",
    keywords: ["paragraph", "text", "正文"],
    icon: Pilcrow,
    action: "paragraph",
    group: "text",
  },
  {
    id: "blockquote",
    label: "引用",
    description: "将当前段落设为引用块",
    keywords: ["quote", "blockquote", "引用"],
    icon: Quote,
    action: "blockquote",
    group: "text",
  },
  {
    id: "code-block",
    label: "代码块",
    description: "插入代码围栏",
    keywords: ["code", "fence", "代码"],
    icon: Code2,
    action: "codeBlock",
    group: "text",
  },
  {
    id: "mermaid",
    label: "Mermaid 图表",
    description: "从流程图示例开始",
    keywords: ["mermaid", "diagram", "chart", "图表", "流程图"],
    icon: Network,
    action: "mermaid",
    group: "insert",
  },
  {
    id: "horizontal-rule",
    label: "分隔线",
    description: "插入水平分隔线",
    keywords: ["divider", "horizontal rule", "separator", "分隔线"],
    icon: Minus,
    action: "horizontalRule",
    group: "text",
  },
  {
    id: "bullet-list",
    label: "无序列表",
    description: "插入项目符号列表",
    keywords: ["bullet", "list", "unordered", "列表"],
    icon: List,
    action: "bulletList",
    group: "lists",
  },
  {
    id: "ordered-list",
    label: "有序列表",
    description: "插入编号列表",
    keywords: ["ordered", "numbered", "list", "编号"],
    icon: ListOrdered,
    action: "orderedList",
    group: "lists",
  },
  {
    id: "task-list",
    label: "任务清单",
    description: "插入可勾选任务",
    keywords: ["task", "todo", "checkbox", "待办", "清单"],
    icon: ListTodo,
    action: "taskList",
    group: "lists",
  },
  {
    id: "table",
    label: "表格",
    description: "3 × 3 表格",
    keywords: ["table", "grid", "表格"],
    icon: Table2,
    action: "table",
    group: "lists",
  },
  {
    id: "callout-note",
    label: "提示块 · 说明",
    description: "[!NOTE]",
    keywords: ["callout", "note", "提示", "说明"],
    icon: Info,
    action: "callout",
    group: "callouts",
    calloutType: "NOTE",
  },
  {
    id: "callout-tip",
    label: "提示块 · 建议",
    description: "[!TIP]",
    keywords: ["callout", "tip", "建议"],
    icon: Lightbulb,
    action: "callout",
    group: "callouts",
    calloutType: "TIP",
  },
  {
    id: "callout-important",
    label: "提示块 · 重要",
    description: "[!IMPORTANT]",
    keywords: ["callout", "important", "重要"],
    icon: Bookmark,
    action: "callout",
    group: "callouts",
    calloutType: "IMPORTANT",
  },
  {
    id: "callout-warning",
    label: "提示块 · 警告",
    description: "[!WARNING]",
    keywords: ["callout", "warning", "警告"],
    icon: TriangleAlert,
    action: "callout",
    group: "callouts",
    calloutType: "WARNING",
  },
  {
    id: "callout-caution",
    label: "提示块 · 注意",
    description: "[!CAUTION]",
    keywords: ["callout", "caution", "注意"],
    icon: ShieldAlert,
    action: "callout",
    group: "callouts",
    calloutType: "CAUTION",
  },
  {
    id: "image",
    label: "图片",
    description: "上传图片",
    keywords: ["image", "picture", "photo", "图片"],
    icon: ImagePlus,
    action: "image",
    group: "insert",
  },
  {
    id: "wiki-link",
    label: "双向链接",
    description: "搜索或创建关联笔记",
    keywords: ["link", "wiki", "note", "双链", "笔记链接"],
    icon: Link2,
    action: "wikiLink",
    group: "insert",
  },
];

export function filterSlashCommandItems(query: string): SlashCommandItem[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return slashCommands;
  const words = normalized.split(/\s+/).filter(Boolean);
  if (!words.length) return slashCommands;
  return slashCommands.filter((item) => {
    const text = `${item.label} ${item.keywords.join(" ")}`.toLocaleLowerCase();
    return words.every((word) => text.includes(word));
  });
}

export function groupSlashCommandItems(items: SlashCommandItem[]) {
  const columnCount = Math.min(SLASH_COMMAND_COLUMN_COUNT, items.length);
  if (!columnCount) return [];

  const baseCount = Math.floor(items.length / columnCount);
  const remainder = items.length % columnCount;
  let offset = 0;

  return Array.from({ length: columnCount }, (_, index) => {
    const count = baseCount + (index < remainder ? 1 : 0);
    const column = {
      id: `column-${index + 1}`,
      label: `命令第 ${index + 1} 列`,
      startIndex: offset,
      items: items.slice(offset, offset + count),
    };
    offset += count;
    return column;
  });
}

export function getNextGroupedSlashCommandIndex(
  current: number,
  key: string,
  groups: SlashCommandItem[][],
  columns = 3,
): number {
  const safeGroups = groups.filter((group) => group.length > 0);
  const flatItems = safeGroups.flat();
  if (!flatItems.length) return 0;
  const currentIndex = Math.max(0, Math.min(current, flatItems.length - 1));
  let offset = 0;
  const groupIndex = safeGroups.findIndex((group) => {
    const includesCurrent = currentIndex >= offset && currentIndex < offset + group.length;
    offset += group.length;
    return includesCurrent;
  });
  const currentOffset = safeGroups
    .slice(0, groupIndex)
    .reduce((sum, group) => sum + group.length, 0);
  const group = safeGroups[groupIndex];
  const localIndex = currentIndex - currentOffset;
  const rowCount = Math.ceil(safeGroups.length / Math.max(1, columns));
  if (key === "ArrowUp" && localIndex > 0) return currentOffset + localIndex - 1;
  if (key === "ArrowDown" && localIndex < group.length - 1) return currentOffset + localIndex + 1;
  if ((key === "ArrowUp" || key === "ArrowDown") && rowCount > 1) {
    const targetRow =
      (Math.floor(groupIndex / columns) + (key === "ArrowUp" ? -1 : 1) + rowCount) % rowCount;
    const targetGroupIndex = Math.min(
      targetRow * columns + (groupIndex % columns),
      safeGroups.length - 1,
    );
    if (safeGroups[targetGroupIndex]) {
      const targetOffset = safeGroups
        .slice(0, targetGroupIndex)
        .reduce((sum, target) => sum + target.length, 0);
      const targetItems = safeGroups[targetGroupIndex];
      const targetLocalIndex = key === "ArrowUp" ? targetItems.length - 1 : 0;
      return targetOffset + targetLocalIndex;
    }
  }
  if (key === "ArrowUp") return currentOffset + group.length - 1;
  if (key === "ArrowDown") return currentOffset;
  if (key !== "ArrowLeft" && key !== "ArrowRight") return currentIndex;

  const groupRow = Math.floor(groupIndex / columns);
  const groupColumn = groupIndex % columns;
  let targetGroupIndex = groupIndex;
  if (key === "ArrowLeft") {
    const rowStart = groupRow * columns;
    const rowSize = Math.min(columns, safeGroups.length - rowStart);
    targetGroupIndex = rowStart + ((groupColumn - 1 + rowSize) % rowSize);
  } else {
    const rowStart = groupRow * columns;
    const rowSize = Math.min(columns, safeGroups.length - rowStart);
    targetGroupIndex = rowStart + ((groupColumn + 1) % rowSize);
  }
  const targetOffset = safeGroups
    .slice(0, targetGroupIndex)
    .reduce((sum, target) => sum + target.length, 0);
  return targetOffset + Math.min(localIndex, safeGroups[targetGroupIndex].length - 1);
}

export function getNextSlashCommandIndex(
  current: number,
  key: string,
  itemCount: number,
  columns = 4,
): number {
  if (itemCount < 1 || columns < 1) return 0;
  const index = Math.max(0, Math.min(current, itemCount - 1));
  const row = Math.floor(index / columns);
  const column = index % columns;
  const rowStart = row * columns;
  const rowEnd = Math.min(rowStart + columns, itemCount) - 1;
  const rowCount = Math.ceil(itemCount / columns);

  if (key === "ArrowLeft") return column > 0 ? index - 1 : rowEnd;
  if (key === "ArrowRight") return index < rowEnd ? index + 1 : rowStart;
  if (key === "ArrowUp") {
    const targetRow = (row - 1 + rowCount) % rowCount;
    return Math.min(
      targetRow * columns + column,
      Math.min((targetRow + 1) * columns, itemCount) - 1,
    );
  }
  if (key === "ArrowDown") {
    const targetRow = (row + 1) % rowCount;
    return Math.min(
      targetRow * columns + column,
      Math.min((targetRow + 1) * columns, itemCount) - 1,
    );
  }
  return index;
}

export function findSlashCommandMatch(config: {
  $position: {
    pos: number;
    parentOffset?: number;
    parent?: { textBetween?: (from: number, to: number) => string };
    nodeBefore?: { isText?: boolean; text?: string | null } | null;
  };
}): SuggestionMatch {
  const { $position } = config;
  const hasParentText =
    typeof $position.parent?.textBetween === "function" &&
    typeof $position.parentOffset === "number";
  const text = hasParentText
    ? ($position.parent?.textBetween?.(0, $position.parentOffset!) ?? "")
    : $position.nodeBefore?.isText
      ? ($position.nodeBefore.text ?? "")
      : "";
  if (!text) return null;

  const match = /(?:^|[ \t\u3000])\/([^\n]*)$/u.exec(text);
  if (!match || match.index === undefined) return null;

  const rawQuery = match[1];
  // 1. 斜杠后紧跟空格或全角空格，属于普通标点用法（如 "A / B"），不触发斜杠命令
  if (/^[ \t\u3000]/.test(rawQuery)) return null;

  // 2. 包含后续斜杠（如文件路径或 URL），或长度超过命令关键词上限，不触发斜杠命令
  if (rawQuery.includes("/") || rawQuery.length > 30) return null;

  // 3. 当已输入搜索词但无任何匹配命令时立即退出，避免将整行置于搜索状态并显示空白浮层
  if (rawQuery.length > 0 && filterSlashCommandItems(rawQuery).length === 0) return null;

  const slashOffset = match.index + match[0].lastIndexOf("/");
  const from =
    $position.pos - (hasParentText ? $position.parentOffset! : text.length) + slashOffset;
  const to = $position.pos;
  if (from >= to) return null;

  return { range: { from, to }, query: rawQuery, text: match[0].slice(match[0].lastIndexOf("/")) };
}

export function isSlashCommandImeEvent(event: { isComposing?: boolean; keyCode?: number }) {
  return Boolean(event.isComposing || event.keyCode === 229);
}

export function isSlashCommandImeEscape(event: {
  isComposing?: boolean;
  keyCode?: number;
  key?: string;
}) {
  return (event.key === "Escape" || event.key === "Esc") && isSlashCommandImeEvent(event);
}
