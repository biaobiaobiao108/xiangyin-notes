import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Extension } from "@tiptap/core";
import { ReactRenderer } from "@tiptap/react";
import Suggestion, { type SuggestionKeyDownProps, type SuggestionMatch, type SuggestionOptions } from "@tiptap/suggestion";
import { FilePlus2, FileText } from "lucide-react";
import type { NoteSummary } from "../../shared/types";
import { normalizeLinkTitle } from "../../shared/wiki-links";

export function findWikiLinkSuggestionMatch(config: {
  $position: any;
  allowedPrefixes?: string[] | null;
  startOfLine?: boolean;
}): SuggestionMatch {
  const { allowedPrefixes, startOfLine, $position } = config;
  const prefix = startOfLine ? "^" : "";
  const regexp = new RegExp(`${prefix}(?:\\[\\[|【【)[^\\[\\]【】\\r\\n]*$`, "gm");
  const text = $position.nodeBefore?.isText && $position.nodeBefore.text;
  if (!text) return null;

  const textFrom = $position.pos - text.length;
  const match = Array.from(text.matchAll(regexp)).pop() as RegExpMatchArray | undefined;
  if (!match || match.input === undefined || match.index === undefined) return null;

  const matchPrefix = match.input.slice(Math.max(0, match.index - 1), match.index);
  const matchPrefixIsAllowed = new RegExp(`^[${allowedPrefixes?.join("") || ""}\0]?$`).test(matchPrefix);
  if (allowedPrefixes !== null && allowedPrefixes !== undefined && !matchPrefixIsAllowed) return null;

  const from = textFrom + match.index;
  const to = from + match[0].length;

  if (from < $position.pos && to >= $position.pos) {
    const matchedText = match[0];
    const triggerLen = 2; // both "[[" and "【【" have length 2
    return {
      range: { from, to },
      query: matchedText.slice(triggerLen),
      text: matchedText,
    };
  }
  return null;
}

export type WikiLinkSuggestionItem = {
  title: string;
  notebookName?: string;
  isCreate?: boolean;
};

export type WikiLinkSuggestionListRef = {
  onKeyDown: (props: SuggestionKeyDownProps) => boolean;
};

type WikiLinkSuggestionListProps = {
  items: WikiLinkSuggestionItem[];
  command: (item: WikiLinkSuggestionItem) => void;
  editor: any;
};

export const WikiLinkSuggestionList = forwardRef<WikiLinkSuggestionListRef, WikiLinkSuggestionListProps>((props, ref) => {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const items = props.items;
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSelectedIndex(0);
  }, [items]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const activeItem = list.querySelector<HTMLElement>(".wiki-link-item.is-selected");
    if (activeItem) {
      activeItem.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  const isExecutingRef = useRef(false);

  useEffect(() => {
    isExecutingRef.current = false;
  }, [items]);

  const handleSelect = (item: WikiLinkSuggestionItem) => {
    if (isExecutingRef.current) return;
    isExecutingRef.current = true;
    props.command(item);
  };

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (!items.length) return false;
      if (event.isComposing || (event as any).keyCode === 229) return false;

      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedIndex((current) => (current + items.length - 1) % items.length);
        return true;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedIndex((current) => (current + 1) % items.length);
        return true;
      }

      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const selected = items[selectedIndex];
        if (selected) {
          handleSelect(selected);
        }
        return true;
      }

      return false;
    },
  }));

  if (!items.length) return null;

  return (
    <div className="wiki-link-suggestion-dropdown" ref={listRef} role="listbox" aria-label="双向链接推荐笔记">
      <div className="wiki-link-suggestion-header">
        <span>双向链接至笔记</span>
        <kbd>↵ 确认</kbd>
      </div>
      <div className="wiki-link-suggestion-list">
        {items.map((item, index) => {
          const isSelected = index === selectedIndex;
          return (
            <button
              key={item.isCreate ? `create-${item.title}` : `note-${item.title}`}
              type="button"
              className={`wiki-link-item ${isSelected ? "is-selected" : ""} ${item.isCreate ? "is-create" : ""}`}
              onPointerDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleSelect(item);
              }}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onMouseEnter={() => setSelectedIndex(index)}
              role="option"
              aria-selected={isSelected}
            >
              {item.isCreate ? (
                <FilePlus2 className="wiki-link-item-icon" size={15} />
              ) : (
                <FileText className="wiki-link-item-icon" size={15} />
              )}
              <span className="wiki-link-item-title">
                {item.isCreate ? `新建笔记并链接为「${item.title}」` : item.title}
              </span>
              {item.notebookName && (
                <span className="wiki-link-item-meta">{item.notebookName}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
});

export type WikiLinkSuggestionOptions = {
  getNotes: () => NoteSummary[];
  onCreateNote?: (title: string) => void;
};

export const WikiLinkSuggestionExtension = Extension.create<WikiLinkSuggestionOptions>({
  name: "wikiLinkSuggestion",

  addOptions() {
    return {
      getNotes: () => [],
      onCreateNote: undefined,
    };
  },

  addProseMirrorPlugins() {
    const getNotes = this.options.getNotes;
    const onCreateNote = this.options.onCreateNote;

    return [
      Suggestion<WikiLinkSuggestionItem>({
        editor: this.editor,
        char: "[[",
        allowSpaces: true,
        allowedPrefixes: null,
        findSuggestionMatch: findWikiLinkSuggestionMatch,
        command: ({ editor, range, props: item }) => {
          editor
            .chain()
            .focus()
            .insertContentAt(range, [
              {
                type: "wikiLink",
                attrs: { target: item.title },
              },
              {
                type: "text",
                text: " ",
              },
            ])
            .run();

          if (item.isCreate && onCreateNote) {
            onCreateNote(item.title);
          }
        },
        items: ({ query }: { query: string }) => {
          const allNotes = (getNotes?.() ?? []).filter((n) => !n.deletedAt);
          const cleanQuery = query.replace(/^(?:\[\[|【【)\s*|\s*(?:\]\]|】】)$/g, "").trim();
          const normalized = normalizeLinkTitle(cleanQuery);

          let filtered: NoteSummary[];
          if (!cleanQuery) {
            // Show recent notes
            filtered = allNotes.slice(0, 7);
          } else {
            filtered = allNotes.filter((n) => {
              const target = normalizeLinkTitle(n.title);
              return target.includes(normalized);
            });
            // Sort exact match first, then prefix, then title length
            filtered.sort((a, b) => {
              const aNorm = normalizeLinkTitle(a.title);
              const bNorm = normalizeLinkTitle(b.title);
              if (aNorm === normalized) return -1;
              if (bNorm === normalized) return 1;
              if (aNorm.startsWith(normalized) && !bNorm.startsWith(normalized)) return -1;
              if (!aNorm.startsWith(normalized) && bNorm.startsWith(normalized)) return 1;
              return a.title.length - b.title.length;
            });
            filtered = filtered.slice(0, 6);
          }

          const result: WikiLinkSuggestionItem[] = filtered.map((note) => ({
            title: note.title.trim() || "未命名笔记",
            notebookName: note.notebookName,
            isCreate: false,
          }));

          // If query is typed and no note strictly matches the exact title, add create option
          if (cleanQuery && !allNotes.some((n) => normalizeLinkTitle(n.title) === normalized)) {
            result.push({
              title: cleanQuery,
              isCreate: true,
            });
          }

          return result;
        },
        render: () => {
          let component: ReactRenderer<WikiLinkSuggestionListRef> | null = null;
          let popupEl: HTMLDivElement | null = null;

          const updatePosition = (clientRect: (() => DOMRect | null) | undefined) => {
            if (!popupEl || !clientRect) return;
            const rect = clientRect();
            if (!rect) return;

            const dropdownWidth = 280;
            const dropdownHeight = 260;
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;

            let left = rect.left;
            if (left + dropdownWidth > viewportWidth - 16) {
              left = Math.max(16, viewportWidth - dropdownWidth - 16);
            }

            let top = rect.bottom + 6;
            if (top + dropdownHeight > viewportHeight - 16 && rect.top > dropdownHeight + 16) {
              // Flip above cursor if not enough space below
              top = rect.top - dropdownHeight - 6;
            }

            popupEl.style.left = `${Math.round(left)}px`;
            popupEl.style.top = `${Math.round(top)}px`;
          };

          return {
            onStart: (props) => {
              if (popupEl) {
                popupEl.remove();
                popupEl = null;
              }
              if (component) {
                component.destroy();
                component = null;
              }

              popupEl = document.createElement("div");
              popupEl.className = "wiki-link-suggestion-container";
              document.body.appendChild(popupEl);

              component = new ReactRenderer(WikiLinkSuggestionList, {
                props,
                editor: props.editor,
              });

              popupEl.appendChild(component.element);
              updatePosition(props.clientRect as any);
            },
            onUpdate: (props) => {
              component?.updateProps(props);
              updatePosition(props.clientRect as any);
            },
            onKeyDown: (props) => {
              if (props.event.key === "Escape") {
                popupEl?.remove();
                popupEl = null;
                component?.destroy();
                component = null;
                return true;
              }
              return component?.ref?.onKeyDown(props) ?? false;
            },
            onExit: () => {
              if (popupEl) {
                popupEl.remove();
                popupEl = null;
              }
              component?.destroy();
              component = null;
            },
          };
        },
      }),
    ];
  },
});
