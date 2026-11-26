import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from "react";
import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { ReactRenderer } from "@tiptap/react";
import Suggestion, { type SuggestionKeyDownProps } from "@tiptap/suggestion";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { FloatingScrollbar } from "../floating-scrollbar";
import { suggestionPopupBounds, suggestionViewport } from "./suggestion-popup.helpers";
import {
  filterSlashCommandItems,
  findSlashCommandMatch,
  getNextGroupedSlashCommandIndex,
  getNextSlashCommandIndex,
  groupSlashCommandItems,
  isSlashCommandImeEscape,
  isSlashCommandImeEvent,
  type SlashCommandItem,
} from "./slash-command-items";

export {
  filterSlashCommandItems,
  findSlashCommandMatch,
  getNextGroupedSlashCommandIndex,
  getNextSlashCommandIndex,
  groupSlashCommandItems,
  isSlashCommandImeEscape,
  isSlashCommandImeEvent,
  type SlashCommandItem,
} from "./slash-command-items";

const slashSuggestionKey = new PluginKey("slashCommandSuggestion");

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
  const lastMousePositionRef = useRef<{ x: number; y: number } | null>(null);

  if (itemsRef.current !== props.items) {
    itemsRef.current = props.items;
    selectedIndexRef.current = 0;
    lastMousePositionRef.current = null;
  }

  useEffect(() => {
    selectedIndexRef.current = 0;
    lastMousePositionRef.current = null;
    setSelectedIndex(0);
  }, [props.items]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    list.querySelector<HTMLElement>("[aria-selected='true']")?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const activeItemId = props.items[selectedIndex]
    ? `${listboxId}-option-${selectedIndex}`
    : undefined;

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
      if (editorElement.getAttribute("aria-activedescendant") === activeItemId)
        restore("aria-activedescendant", previous.activeDescendant);
      if (editorElement.getAttribute("aria-autocomplete") === "list")
        restore("aria-autocomplete", previous.autocomplete);
      if (editorElement.getAttribute("aria-controls") === listboxId)
        restore("aria-controls", previous.controls);
      if (editorElement.getAttribute("aria-haspopup") === "listbox")
        restore("aria-haspopup", previous.hasPopup);
    };
  }, [activeItemId, listboxId, props.editor]);

  const select = (index: number) => {
    const item = props.items[index];
    if (!item) return;
    props.command(item);
  };

  useImperativeHandle(
    ref,
    () => ({
      onKeyDown: ({ event }: SuggestionKeyDownProps) => {
        if (isSlashCommandImeEvent(event)) return false;
        if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(event.key)) {
          event.preventDefault();
          lastMousePositionRef.current = null;
          if (props.items.length) {
            const columns = window.innerWidth <= 720 ? 2 : 3;
            const next = isDirectory
              ? getNextGroupedSlashCommandIndex(
                  selectedIndexRef.current,
                  event.key,
                  groups.map((group) => group.items),
                  columns,
                )
              : getNextSlashCommandIndex(
                  selectedIndexRef.current,
                  event.key,
                  props.items.length,
                  1,
                );
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
    }),
    [groups, isDirectory, props.items, props.command],
  );

  const handleItemMouseMove = (index: number, event: React.MouseEvent) => {
    if (!lastMousePositionRef.current) {
      lastMousePositionRef.current = { x: event.clientX, y: event.clientY };
      return;
    }
    const deltaX = Math.abs(event.clientX - lastMousePositionRef.current.x);
    const deltaY = Math.abs(event.clientY - lastMousePositionRef.current.y);
    if (deltaX + deltaY >= 4) {
      lastMousePositionRef.current = { x: event.clientX, y: event.clientY };
      if (selectedIndexRef.current !== index) {
        selectedIndexRef.current = index;
        setSelectedIndex(index);
      }
    }
  };

  const renderItem = (item: SlashCommandItem, index: number) => {
    const Icon = item.icon;
    return (
      <button
        id={`${listboxId}-option-${index}`}
        className={`slash-command-item ${isDirectory ? "slash-command-item--directory" : "slash-command-item--suggestion"} ${index === selectedIndex ? "is-selected" : ""}`}
        type="button"
        role="option"
        aria-selected={index === selectedIndex}
        key={item.id}
        aria-label={`${item.label}，${item.description}`}
        onMouseDown={(event) => {
          event.preventDefault();
          selectedIndexRef.current = index;
          setSelectedIndex(index);
        }}
        onMouseMove={(event) => handleItemMouseMove(index, event)}
        onClick={() => select(index)}
      >
        <span className="slash-command-icon">
          <Icon size={16} aria-hidden="true" />
        </span>
        <span className="slash-command-copy">{item.label}</span>
      </button>
    );
  };

  return (
    <div
      className={`slash-command-menu ${isDirectory ? "slash-command-menu--directory" : "slash-command-menu--suggestions"}`}
      role="listbox"
      id={listboxId}
      aria-label="Markdown 插入命令"
    >
      <div className="slash-command-menu-list-shell">
        <div
          className={`slash-command-menu-list slash-command-menu-list--${isDirectory ? "directory" : "suggestions"} floating-scrollbar-target`}
          id={`${listboxId}-scroll-region`}
          ref={listRef}
        >
          {props.items.length
            ? isDirectory
              ? groups.map((group) => {
                  return (
                    <section
                      className="slash-command-group"
                      role="group"
                      aria-label={group.label}
                      key={group.id}
                    >
                      <div className="slash-command-group-items">
                        {group.items.map((item, localIndex) =>
                          renderItem(item, group.startIndex + localIndex),
                        )}
                      </div>
                    </section>
                  );
                })
              : props.items.map(renderItem)
            : null}
        </div>
        <FloatingScrollbar
          scrollTargetRef={listRef}
          controlsId={`${listboxId}-scroll-region`}
          ariaLabel="插入命令列表滚动条"
          placement="right"
          enabled={props.items.length > 5}
        />
      </div>
    </div>
  );
});
SlashCommandList.displayName = "SlashCommandList";

export type SlashCommandOptions = {
  onPickImage?: () => void;
};

export function insertSlashCommand(
  editor: Editor,
  range: { from: number; to: number },
  item: SlashCommandItem,
  onPickImage?: () => void,
) {
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
    editor
      .chain()
      .focus()
      .deleteRange(range)
      .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
      .run();
    return;
  }

  if (item.action === "callout") {
    const position = range.from;
    editor
      .chain()
      .focus()
      .deleteRange(range)
      .insertContentAt(
        position,
        {
          type: "callout",
          attrs: { type: item.calloutType ?? "NOTE" },
          content: [{ type: "paragraph" }],
        },
        { updateSelection: false },
      )
      .setTextSelection(position + 2)
      .run();
    return;
  }

  const chain = editor.chain().focus().deleteRange(range);
  switch (item.action) {
    case "paragraph":
      chain.setParagraph();
      break;
    case "heading":
      chain.setHeading({ level: item.headingLevel ?? 1 });
      break;
    case "bulletList":
      chain.toggleBulletList();
      break;
    case "orderedList":
      chain.toggleOrderedList();
      break;
    case "taskList":
      chain.toggleTaskList();
      break;
    case "blockquote":
      chain.toggleBlockquote();
      break;
    case "codeBlock":
      chain.toggleCodeBlock();
      break;
    case "mermaid":
      chain.setCodeBlock({ language: "mermaid" });
      break;
    case "horizontalRule":
      chain.setHorizontalRule();
      break;
    case "bold":
      chain.toggleBold();
      break;
    case "italic":
      chain.toggleItalic();
      break;
    case "strike":
      chain.toggleStrike();
      break;
    case "underline":
      chain.toggleUnderline();
      break;
    case "inlineCode":
      chain.toggleCode();
      break;
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
            view.dispatch(
              view.state.tr.setMeta("addToHistory", false).setMeta("preventUpdate", true),
            );
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

    return [
      imeEscapeGuard,
      Suggestion<SlashCommandItem>({
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
          if ($from.parent.type.spec.code || $from.marks().some((mark) => mark.type.spec.code))
            return false;
          return true;
        },
        items: ({ query }) => {
          return filterSlashCommandItems(query);
        },
        command: ({ editor, range, props }) =>
          insertSlashCommand(editor, range, props, this.options.onPickImage),
        render: () => {
          let component: ReactRenderer<SlashCommandListRef> | null = null;
          let popupEl: HTMLDivElement | null = null;
          let activeClientRect: (() => DOMRect | null) | undefined;
          let positionFrame: number | null = null;

          const updatePosition = () => {
            if (!popupEl || !activeClientRect) return;
            const rect = activeClientRect();
            if (!rect) return;
            const directory = popupEl.dataset.query?.trim().length === 0;
            const viewport = suggestionViewport();
            const desiredWidth = directory ? 660 : 400;
            const desiredHeight = directory ? 500 : 340;
            const bounds = suggestionPopupBounds(rect, viewport, desiredWidth, desiredHeight);
            popupEl.style.width = `${bounds.width}px`;
            popupEl.style.maxHeight = `${bounds.maxHeight}px`;
            const list = popupEl.querySelector<HTMLElement>(".slash-command-menu-list");
            if (list) list.style.maxHeight = `${Math.max(0, bounds.maxHeight - 2)}px`;
            const measuredHeight = popupEl.getBoundingClientRect().height;
            const placement = suggestionPopupBounds(
              rect,
              viewport,
              desiredWidth,
              desiredHeight,
              measuredHeight || bounds.maxHeight,
            );
            popupEl.style.left = `${placement.left}px`;
            popupEl.style.top = `${placement.top}px`;
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
            window.visualViewport?.removeEventListener("resize", updatePosition);
            window.visualViewport?.removeEventListener("scroll", updatePosition);
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
              if (!props.items.length) return;
              popupEl = document.createElement("div");
              popupEl.className = "slash-command-menu-container";
              popupEl.dataset.query = props.query;
              document.body.appendChild(popupEl);
              component = new ReactRenderer(SlashCommandList, { props, editor: props.editor });
              popupEl.appendChild(component.element);
              activeClientRect = props.clientRect as (() => DOMRect | null) | undefined;
              window.addEventListener("resize", updatePosition);
              window.addEventListener("scroll", updatePosition, true);
              window.visualViewport?.addEventListener("resize", updatePosition);
              window.visualViewport?.addEventListener("scroll", updatePosition);
              updatePosition();
              schedulePosition();
            },
            onUpdate: (props) => {
              if (!props.items.length) {
                destroy();
                return;
              }
              if (!popupEl) {
                popupEl = document.createElement("div");
                popupEl.className = "slash-command-menu-container";
                document.body.appendChild(popupEl);
                component = new ReactRenderer(SlashCommandList, { props, editor: props.editor });
                popupEl.appendChild(component.element);
                window.addEventListener("resize", updatePosition);
                window.addEventListener("scroll", updatePosition, true);
                window.visualViewport?.addEventListener("resize", updatePosition);
                window.visualViewport?.addEventListener("scroll", updatePosition);
              } else {
                component?.updateProps(props);
              }
              popupEl.dataset.query = props.query;
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
      }),
    ];
  },
});
