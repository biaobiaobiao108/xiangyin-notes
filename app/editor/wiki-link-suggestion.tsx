import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Extension } from "@tiptap/core";
import { ReactRenderer } from "@tiptap/react";
import Suggestion, { type SuggestionKeyDownProps, type SuggestionOptions } from "@tiptap/suggestion";
import { FilePlus2, FileText } from "lucide-react";
import type { NoteSummary } from "../../shared/types";
import { normalizeLinkTitle } from "../../shared/wiki-links";

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

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (!items.length) return false;

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
          props.command(selected);
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
                props.command(item);
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
          const trimmed = query.trim();
          const normalized = normalizeLinkTitle(trimmed);

          let filtered: NoteSummary[];
          if (!trimmed) {
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
          if (trimmed && !allNotes.some((n) => normalizeLinkTitle(n.title) === normalized)) {
            result.push({
              title: trimmed,
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
