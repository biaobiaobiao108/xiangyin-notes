import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from "react";
import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { ReactRenderer } from "@tiptap/react";
import Suggestion, { type SuggestionKeyDownProps, type SuggestionMatch } from "@tiptap/suggestion";
import { Bookmark, Code2, Heading1, Heading2, Heading3, Heading4, ImagePlus, Info, Lightbulb, Link2, List, ListOrdered, ListTodo, Minus, Pilcrow, Quote, ShieldAlert, Table2, TriangleAlert, type LucideIcon } from "lucide-react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { CalloutType } from "./callout-node";
import { FloatingScrollbar } from "../floating-scrollbar";

type SlashAction = "paragraph" | "heading" | "bulletList" | "orderedList" | "taskList" | "blockquote" | "codeBlock" | "horizontalRule" | "callout" | "table" | "image" | "wikiLink";
type SlashCommandGroupId = "text" | "lists" | "callouts" | "insert";

const slashCommandGroups: { id: SlashCommandGroupId; label: string; itemGroups: SlashCommandGroupId[] }[] = [
  { id: "text", label: "文本", itemGroups: ["text"] },
  { id: "lists", label: "列表与表格", itemGroups: ["lists"] },
  { id: "callouts", label: "提示块与插入内容", itemGroups: ["callouts", "insert"] },
];

export type SlashCommandItem = {
  id: string;
  label: string;
  description: string;
  keywords: string[];
  icon: LucideIcon;
  action: SlashAction;
  group: SlashCommandGroupId;
  headingLevel?: 1 | 2 | 3 | 4;
  calloutType?: CalloutType;
};

const slashCommands: SlashCommandItem[] = [
  { id: "heading-1", label: "一级标题", description: "将当前段落设为 H1", keywords: ["h1", "heading 1", "title", "标题 1"], icon: Heading1, action: "heading", group: "text", headingLevel: 1 },
  { id: "heading-2", label: "二级标题", description: "将当前段落设为 H2", keywords: ["h2", "heading 2", "subtitle", "标题 2"], icon: Heading2, action: "heading", group: "text", headingLevel: 2 },
  { id: "heading-3", label: "三级标题", description: "将当前段落设为 H3", keywords: ["h3", "heading 3", "标题 3"], icon: Heading3, action: "heading", group: "text", headingLevel: 3 },
  { id: "heading-4", label: "四级标题", description: "将当前段落设为 H4", keywords: ["h4", "heading 4", "标题 4"], icon: Heading4, action: "heading", group: "text", headingLevel: 4 },
  { id: "paragraph", label: "正文段落", description: "转换为普通段落", keywords: ["paragraph", "text", "正文"], icon: Pilcrow, action: "paragraph", group: "text" },
  { id: "blockquote", label: "引用", description: "将当前段落设为引用块", keywords: ["quote", "blockquote", "引用"], icon: Quote, action: "blockquote", group: "text" },
  { id: "code-block", label: "代码块", description: "插入代码围栏", keywords: ["code", "fence", "代码"], icon: Code2, action: "codeBlock", group: "text" },
  { id: "horizontal-rule", label: "分隔线", description: "插入水平分隔线", keywords: ["divider", "horizontal rule", "separator", "分隔线"], icon: Minus, action: "horizontalRule", group: "text" },
  { id: "bullet-list", label: "无序列表", description: "插入项目符号列表", keywords: ["bullet", "list", "unordered", "列表"], icon: List, action: "bulletList", group: "lists" },
  { id: "ordered-list", label: "有序列表", description: "插入编号列表", keywords: ["ordered", "numbered", "list", "编号"], icon: ListOrdered, action: "orderedList", group: "lists" },
  { id: "task-list", label: "任务清单", description: "插入可勾选任务", keywords: ["task", "todo", "checkbox", "待办", "清单"], icon: ListTodo, action: "taskList", group: "lists" },
  { id: "table", label: "表格", description: "插入 3 × 3 表格", keywords: ["table", "grid", "表格"], icon: Table2, action: "table", group: "lists" },
  { id: "callout-note", label: "提示块 · 说明", description: "插入 NOTE 提示块", keywords: ["callout", "note", "提示", "说明"], icon: Info, action: "callout", group: "callouts", calloutType: "NOTE" },
  { id: "callout-tip", label: "提示块 · 建议", description: "插入 TIP 提示块", keywords: ["callout", "tip", "建议"], icon: Lightbulb, action: "callout", group: "callouts", calloutType: "TIP" },
  { id: "callout-important", label: "提示块 · 重要", description: "插入 IMPORTANT 提示块", keywords: ["callout", "important", "重要"], icon: Bookmark, action: "callout", group: "callouts", calloutType: "IMPORTANT" },
  { id: "callout-warning", label: "提示块 · 警告", description: "插入 WARNING 提示块", keywords: ["callout", "warning", "警告"], icon: TriangleAlert, action: "callout", group: "callouts", calloutType: "WARNING" },
  { id: "callout-caution", label: "提示块 · 注意", description: "插入 CAUTION 提示块", keywords: ["callout", "caution", "注意"], icon: ShieldAlert, action: "callout", group: "callouts", calloutType: "CAUTION" },
  { id: "image", label: "图片", description: "选择图片并上传", keywords: ["image", "picture", "photo", "图片"], icon: ImagePlus, action: "image", group: "insert" },
  { id: "wiki-link", label: "双向链接", description: "搜索或创建关联笔记", keywords: ["link", "wiki", "note", "双链", "笔记链接"], icon: Link2, action: "wikiLink", group: "insert" },
];

const slashSuggestionKey = new PluginKey("slashCommandSuggestion");

export function filterSlashCommandItems(query: string): SlashCommandItem[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return slashCommands;
  return slashCommands.filter((item) => `${item.label} ${item.keywords.join(" ")}`.toLocaleLowerCase().includes(normalized));
}

export function groupSlashCommandItems(items: SlashCommandItem[]) {
  return slashCommandGroups.map((group) => ({
    ...group,
    items: items.filter((item) => group.itemGroups.includes(item.group)),
  })).filter((group) => group.items.length > 0);
}

export function getNextGroupedSlashCommandIndex(current: number, key: string, groups: SlashCommandItem[][], columns = 3): number {
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
  const currentOffset = safeGroups.slice(0, groupIndex).reduce((sum, group) => sum + group.length, 0);
  const group = safeGroups[groupIndex];
  const localIndex = currentIndex - currentOffset;
  const rowCount = Math.ceil(safeGroups.length / Math.max(1, columns));
  if (key === "ArrowUp" && localIndex > 0) return currentOffset + localIndex - 1;
  if (key === "ArrowDown" && localIndex < group.length - 1) return currentOffset + localIndex + 1;
  if ((key === "ArrowUp" || key === "ArrowDown") && rowCount > 1) {
    const targetRow = (Math.floor(groupIndex / columns) + (key === "ArrowUp" ? -1 : 1) + rowCount) % rowCount;
    const targetGroupIndex = Math.min(targetRow * columns + (groupIndex % columns), safeGroups.length - 1);
    if (safeGroups[targetGroupIndex]) {
      const targetOffset = safeGroups.slice(0, targetGroupIndex).reduce((sum, target) => sum + target.length, 0);
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
    targetGroupIndex = rowStart + (groupColumn - 1 + rowSize) % rowSize;
  } else {
    const rowStart = groupRow * columns;
    const rowSize = Math.min(columns, safeGroups.length - rowStart);
    targetGroupIndex = rowStart + (groupColumn + 1) % rowSize;
  }
  const targetOffset = safeGroups.slice(0, targetGroupIndex).reduce((sum, target) => sum + target.length, 0);
  return targetOffset + Math.min(localIndex, safeGroups[targetGroupIndex].length - 1);
}

export function getNextSlashCommandIndex(current: number, key: string, itemCount: number, columns = 4): number {
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
    return Math.min(targetRow * columns + column, Math.min((targetRow + 1) * columns, itemCount) - 1);
  }
  if (key === "ArrowDown") {
    const targetRow = (row + 1) % rowCount;
    return Math.min(targetRow * columns + column, Math.min((targetRow + 1) * columns, itemCount) - 1);
  }
  return index;
}

export function findSlashCommandMatch(config: { $position: { pos: number; parentOffset?: number; parent?: { textBetween?: (from: number, to: number) => string }; nodeBefore?: { isText?: boolean; text?: string | null } | null } }): SuggestionMatch {
  const { $position } = config;
  const hasParentText = typeof $position.parent?.textBetween === "function" && typeof $position.parentOffset === "number";
  const text = hasParentText
    ? $position.parent?.textBetween?.(0, $position.parentOffset!) ?? ""
    : $position.nodeBefore?.isText ? $position.nodeBefore.text ?? "" : "";
  if (!text) return null;

  const match = /(?:^|[ \t\u3000])\/([^\n]*)$/u.exec(text);
  if (!match || match.index === undefined) return null;

  const slashOffset = match.index + match[0].lastIndexOf("/");
  const from = $position.pos - (hasParentText ? $position.parentOffset! : text.length) + slashOffset;
  const to = $position.pos;
  if (from >= to) return null;

  return { range: { from, to }, query: match[1], text: match[0].slice(match[0].lastIndexOf("/")) };
}

export function isSlashCommandImeEvent(event: { isComposing?: boolean; keyCode?: number }) {
  return Boolean(event.isComposing || event.keyCode === 229);
}

export function isSlashCommandImeEscape(event: { isComposing?: boolean; keyCode?: number; key?: string }) {
  return (event.key === "Escape" || event.key === "Esc") && isSlashCommandImeEvent(event);
}

export type SlashCommandListRef = {
  onKeyDown: (props: SuggestionKeyDownProps) => boolean;
};

type SlashCommandListProps = {
  items: SlashCommandItem[];
  command: (item: SlashCommandItem) => void;
  editor: Editor;
  query: string;
};

const SlashCommandList = forwardRef<SlashCommandListRef, SlashCommandListProps>((props, ref) => {
  const selectedIndexRef = useRef(0);
  const itemsRef = useRef(props.items);
  const isDirectory = props.query.trim().length === 0;
  const groups = groupSlashCommandItems(props.items);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listboxId = `slash-command-listbox-${useId().replaceAll(":", "")}`;
  const listRef = useRef<HTMLDivElement>(null);

  if (itemsRef.current !== props.items) {
    itemsRef.current = props.items;
    selectedIndexRef.current = 0;
  }

  useEffect(() => {
    selectedIndexRef.current = 0;
    setSelectedIndex(0);
  }, [props.items]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    list.querySelector<HTMLElement>("[aria-selected='true']")?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const activeItemId = props.items[selectedIndex] ? `${listboxId}-option-${selectedIndex}` : undefined;

  useEffect(() => {
    const editorElement = props.editor.view.dom;
    const previous = {
      activeDescendant: editorElement.getAttribute("aria-activedescendant"),
      autocomplete: editorElement.getAttribute("aria-autocomplete"),
      controls: editorElement.getAttribute("aria-controls"),
      hasPopup: editorElement.getAttribute("aria-haspopup"),
    };
    const restore = (attribute: string, value: string | null) => {
      if (value === null) editorElement.removeAttribute(attribute);
      else editorElement.setAttribute(attribute, value);
    };
    editorElement.setAttribute("aria-autocomplete", "list");
    editorElement.setAttribute("aria-controls", listboxId);
    editorElement.setAttribute("aria-haspopup", "listbox");
    if (activeItemId) editorElement.setAttribute("aria-activedescendant", activeItemId);
    else editorElement.removeAttribute("aria-activedescendant");
    return () => {
      if (editorElement.getAttribute("aria-activedescendant") === activeItemId) restore("aria-activedescendant", previous.activeDescendant);
      if (editorElement.getAttribute("aria-autocomplete") === "list") restore("aria-autocomplete", previous.autocomplete);
      if (editorElement.getAttribute("aria-controls") === listboxId) restore("aria-controls", previous.controls);
      if (editorElement.getAttribute("aria-haspopup") === "listbox") restore("aria-haspopup", previous.hasPopup);
    };
  }, [activeItemId, listboxId, props.editor]);

  const select = (index: number) => {
    const item = props.items[index];
    if (!item) return;
    props.command(item);
  };

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }: SuggestionKeyDownProps) => {
      if (isSlashCommandImeEvent(event)) return false;
      if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(event.key)) {
        event.preventDefault();
        if (props.items.length) {
          const columns = window.innerWidth <= 720 ? 2 : 3;
          const next = isDirectory
            ? getNextGroupedSlashCommandIndex(selectedIndexRef.current, event.key, groups.map((group) => group.items), columns)
            : getNextSlashCommandIndex(selectedIndexRef.current, event.key, props.items.length, 1);
          selectedIndexRef.current = next;
          setSelectedIndex(next);
        }
        return true;
      }
      if (event.key === "Enter" && props.items.length) {
        event.preventDefault();
        select(Math.min(selectedIndexRef.current, props.items.length - 1));
        return true;
      }
      return false;
    },
  }), [groups, isDirectory, props.items, props.command]);

  const renderItem = (item: SlashCommandItem, index: number) => {
    const Icon = item.icon;
    return <button
      id={`${listboxId}-option-${index}`}
      className={`slash-command-item ${isDirectory ? "slash-command-item--directory" : "slash-command-item--suggestion"} ${index === selectedIndex ? "is-selected" : ""}`}
      type="button"
      role="option"
      aria-selected={index === selectedIndex}
      key={item.id}
      aria-label={`${item.label}，${item.description}`}
      title={item.description}
      onMouseDown={(event) => event.preventDefault()}
      onMouseEnter={() => { selectedIndexRef.current = index; setSelectedIndex(index); }}
      onClick={() => select(index)}
    >
      <span className="slash-command-icon"><Icon size={16} aria-hidden="true" /></span>
      <span className="slash-command-copy"><strong>{item.label}</strong></span>
    </button>;
  };

  return <div className={`slash-command-menu ${isDirectory ? "slash-command-menu--directory" : "slash-command-menu--suggestions"}`} role="listbox" id={listboxId} aria-label="Markdown 插入命令">
    <div className="slash-command-menu-list-shell">
      <div className={`slash-command-menu-list slash-command-menu-list--${isDirectory ? "directory" : "suggestions"} floating-scrollbar-target`} id={`${listboxId}-scroll-region`} ref={listRef}>
        {props.items.length ? isDirectory ? groups.map((group) => {
          const firstIndex = props.items.findIndex((item) => item.group === group.id);
          return <section className="slash-command-group" role="group" aria-label={group.label} key={group.id}>
            <h3 className="slash-command-group-heading">{group.label}</h3>
            <div className="slash-command-group-items">
              {group.items.map((item, localIndex) => renderItem(item, firstIndex + localIndex))}
            </div>
          </section>;
        }) : props.items.map(renderItem) : <div className="slash-command-empty" role="status">没有匹配的命令</div>}
      </div>
      <FloatingScrollbar scrollTargetRef={listRef} controlsId={`${listboxId}-scroll-region`} ariaLabel="插入命令列表滚动条" placement="right" enabled={props.items.length > 5} />
    </div>
  </div>;
});
SlashCommandList.displayName = "SlashCommandList";

export type SlashCommandOptions = {
  onPickImage?: () => void;
};

export function insertSlashCommand(editor: Editor, range: { from: number; to: number }, item: SlashCommandItem, onPickImage?: () => void) {
  if (item.action === "image") {
    editor.chain().focus().deleteRange(range).run();
    onPickImage?.();
    return;
  }

  if (item.action === "wikiLink") {
    editor.chain().focus().deleteRange(range).insertContent("[[").run();
    return;
  }

  if (item.action === "table") {
    editor.chain().focus().deleteRange(range).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
    return;
  }

  if (item.action === "callout") {
    const position = range.from;
    editor.chain()
      .focus()
      .deleteRange(range)
      .insertContentAt(position, { type: "callout", attrs: { type: item.calloutType ?? "NOTE" }, content: [{ type: "paragraph" }] }, { updateSelection: false })
      .setTextSelection(position + 2)
      .run();
    return;
  }

  const chain = editor.chain().focus().deleteRange(range);
  switch (item.action) {
    case "paragraph": chain.setParagraph(); break;
    case "heading": chain.setHeading({ level: item.headingLevel ?? 1 }); break;
    case "bulletList": chain.toggleBulletList(); break;
    case "orderedList": chain.toggleOrderedList(); break;
    case "taskList": chain.toggleTaskList(); break;
    case "blockquote": chain.toggleBlockquote(); break;
    case "codeBlock": chain.toggleCodeBlock(); break;
    case "horizontalRule": chain.setHorizontalRule(); break;
  }
  chain.run();
}

export const SlashCommandExtension = Extension.create<SlashCommandOptions>({
  name: "slashCommand",

  addOptions() {
    return { onPickImage: undefined };
  },

  addProseMirrorPlugins() {
    const imeEscapeGuard = new Plugin({
      props: {
        handleDOMEvents: {
          keydown: (_view, event) => {
            if (!isSlashCommandImeEscape(event as KeyboardEvent)) return false;
            event.stopPropagation();
            return true;
          },
        },
      },
      view: (view) => {
        let refreshFrame: number | null = null;
        const refreshSuggestionAfterComposition = () => {
          if (refreshFrame !== null) window.cancelAnimationFrame(refreshFrame);
          refreshFrame = window.requestAnimationFrame(() => {
            refreshFrame = null;
            if (view.isDestroyed) return;
            view.dispatch(view.state.tr.setMeta("addToHistory", false).setMeta("preventUpdate", true));
          });
        };
        view.dom.addEventListener("compositionend", refreshSuggestionAfterComposition);
        return {
          destroy() {
            view.dom.removeEventListener("compositionend", refreshSuggestionAfterComposition);
            if (refreshFrame !== null) window.cancelAnimationFrame(refreshFrame);
          },
        };
      },
    });

    return [imeEscapeGuard, Suggestion<SlashCommandItem>({
      pluginKey: slashSuggestionKey,
      editor: this.editor,
      char: "/",
      allowSpaces: true,
      allowedPrefixes: null,
      findSuggestionMatch: findSlashCommandMatch,
      allow: ({ editor, state }) => {
        if (!editor.isEditable || editor.view.composing || !state.selection.empty) return false;
        const { $from } = state.selection;
        const parentRole = $from.node(-1)?.type.spec.tableRole;
        if (parentRole === "cell" || parentRole === "header_cell") return false;
        if ($from.parent.type.spec.code || $from.marks().some((mark) => mark.type.spec.code)) return false;
        return true;
      },
      items: ({ query }) => {
        return filterSlashCommandItems(query);
      },
      command: ({ editor, range, props }) => insertSlashCommand(editor, range, props, this.options.onPickImage),
      render: () => {
        let component: ReactRenderer<SlashCommandListRef> | null = null;
        let popupEl: HTMLDivElement | null = null;
        let activeClientRect: (() => DOMRect | null) | undefined;
        let positionFrame: number | null = null;

        const updatePosition = () => {
          if (!popupEl || !activeClientRect) return;
          const rect = activeClientRect();
          if (!rect) return;
          const viewportPadding = 12;
          const directory = popupEl.dataset.query?.trim().length === 0;
          const width = Math.min(directory ? 660 : 400, window.innerWidth - viewportPadding * 2);
          const maxHeight = Math.min(directory ? 500 : 340, window.innerHeight - viewportPadding * 2);
          popupEl.style.width = `${width}px`;
          popupEl.style.maxHeight = `${maxHeight}px`;
          const measuredHeight = popupEl.getBoundingClientRect().height;
          const height = Math.min(measuredHeight > 0 ? measuredHeight : maxHeight, window.innerHeight - viewportPadding * 2);
          const left = Math.max(viewportPadding, Math.min(rect.left, window.innerWidth - width - viewportPadding));
          const below = rect.bottom + 6;
          const above = rect.top - height - 6;
          const fitsBelow = below + height <= window.innerHeight - viewportPadding;
          const fitsAbove = above >= viewportPadding;
          const top = fitsBelow
            ? below
            : fitsAbove
              ? above
              : Math.max(viewportPadding, Math.min(below, window.innerHeight - height - viewportPadding));
          popupEl.style.left = `${Math.round(Math.max(viewportPadding, Math.min(left, window.innerWidth - width - viewportPadding)))}px`;
          popupEl.style.top = `${Math.round(Math.max(viewportPadding, top))}px`;
        };

        const schedulePosition = () => {
          if (positionFrame !== null) window.cancelAnimationFrame(positionFrame);
          positionFrame = window.requestAnimationFrame(() => {
            positionFrame = null;
            updatePosition();
          });
        };

        const destroy = () => {
          window.removeEventListener("resize", updatePosition);
          window.removeEventListener("scroll", updatePosition, true);
          if (positionFrame !== null) window.cancelAnimationFrame(positionFrame);
          positionFrame = null;
          activeClientRect = undefined;
          popupEl?.remove();
          popupEl = null;
          component?.destroy();
          component = null;
        };

        return {
          onStart: (props) => {
            destroy();
            popupEl = document.createElement("div");
            popupEl.className = "slash-command-menu-container";
            popupEl.dataset.query = props.query;
            document.body.appendChild(popupEl);
            component = new ReactRenderer(SlashCommandList, { props, editor: props.editor });
            popupEl.appendChild(component.element);
            activeClientRect = props.clientRect as (() => DOMRect | null) | undefined;
            window.addEventListener("resize", updatePosition);
            window.addEventListener("scroll", updatePosition, true);
            updatePosition();
            schedulePosition();
          },
          onUpdate: (props) => {
            component?.updateProps(props);
            if (popupEl) popupEl.dataset.query = props.query;
            activeClientRect = props.clientRect as (() => DOMRect | null) | undefined;
            updatePosition();
            schedulePosition();
          },
          onKeyDown: ({ event }) => {
            if (isSlashCommandImeEvent(event)) return false;
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              destroy();
              return true;
            }
            return component?.ref?.onKeyDown({ event } as SuggestionKeyDownProps) ?? false;
          },
          onExit: destroy,
        };
      },
    })];
  },
});
