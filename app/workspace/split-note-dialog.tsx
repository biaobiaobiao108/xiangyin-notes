import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { FileText, Search } from "lucide-react";
import type { NoteSummary } from "../../shared/types";
import { relativeDate } from "../format";
import { FloatingScrollbar } from "../floating-scrollbar";

export const MAX_RECENT_SPLIT_NOTES = 5;
export const MAX_SEARCH_SPLIT_NOTES = 20;

export function filterSplitCandidates<
  T extends {
    id: string;
    title?: string | null;
    preview?: string | null;
    notebookName?: string | null;
    deletedAt?: number | null;
    updatedAt: number;
  },
>(notes: T[], excludeNoteId: string | null | undefined, query: string): T[] {
  const available = notes
    .filter((note) => !note.deletedAt && note.id !== excludeNoteId)
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return available.slice(0, MAX_RECENT_SPLIT_NOTES);
  return available
    .filter((note) => {
      const titleMatch = (note.title || "未命名笔记").toLowerCase().includes(trimmed);
      const previewMatch = (note.preview || "").toLowerCase().includes(trimmed);
      const notebookMatch = (note.notebookName || "").toLowerCase().includes(trimmed);
      return titleMatch || previewMatch || notebookMatch;
    })
    .slice(0, MAX_SEARCH_SPLIT_NOTES);
}

export type SplitNoteDialogProps = {
  open: boolean;
  onClose: () => void;
  onSelectNote: (noteId: string) => void;
  notes: NoteSummary[];
  excludeNoteId?: string | null;
};

export const SplitNoteDialog = memo(function SplitNoteDialog({
  open,
  onClose,
  onSelectNote,
  notes,
  excludeNoteId,
}: SplitNoteDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  const filteredNotes = useMemo(() => {
    return filterSplitCandidates(notes, excludeNoteId, query);
  }, [notes, excludeNoteId, query]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      setQuery("");
      setSelectedIndex(0);
      const returnFocus =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;

      if (!dialog.open) {
        dialog.showModal();
      }
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });

      return () => {
        if (dialog.open) dialog.close();
        if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
      };
    } else {
      if (dialog.open) dialog.close();
    }
  }, [open]);

  const handleBackdropClick = useCallback(
    (event: ReactMouseEvent<HTMLDialogElement>) => {
      if (event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const inside =
        rect.top <= event.clientY &&
        event.clientY <= rect.top + rect.height &&
        rect.left <= event.clientX &&
        event.clientX <= rect.left + rect.width;
      if (!inside) onClose();
    },
    [onClose],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedIndex((current) =>
          filteredNotes.length > 0 ? (current + 1) % filteredNotes.length : 0,
        );
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedIndex((current) =>
          filteredNotes.length > 0
            ? (current - 1 + filteredNotes.length) % filteredNotes.length
            : 0,
        );
      } else if (event.key === "Enter") {
        event.preventDefault();
        const selected = filteredNotes[selectedIndex];
        if (selected) {
          onSelectNote(selected.id);
        }
      }
    },
    [filteredNotes, onClose, onSelectNote, selectedIndex],
  );

  useEffect(() => {
    if (!listRef.current) return;
    const selectedElement = listRef.current.querySelector<HTMLElement>(
      `.command-row[aria-selected="true"]`,
    );
    selectedElement?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (!open) return null;

  return (
    <dialog
      ref={dialogRef}
      className="command-dialog split-note-dialog"
      aria-labelledby="split-note-dialog-title"
      onClick={handleBackdropClick}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="command-dialog-header">
        <h2 id="split-note-dialog-title">选择分屏对照笔记</h2>
        <kbd>Esc</kbd>
      </div>
      <div className="command-search-wrap">
        <Search size={18} aria-hidden="true" />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={filteredNotes.length > 0}
          aria-controls="split-note-options"
          aria-label="搜索要分屏对照的笔记"
          placeholder="搜索要分屏对照的笔记……"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
      </div>
      <div className="command-list-wrap">
        <FloatingScrollbar
          scrollTargetRef={listRef}
          controlsId="split-note-scroll-region"
          ariaLabel="分屏笔记列表滚动条"
          placement="right"
        />
        <div id="split-note-options" ref={listRef} role="listbox" className="command-list">
          {filteredNotes.length === 0 ? (
            <div className="command-empty">未找到匹配的笔记</div>
          ) : (
            filteredNotes.map((note, index) => (
              <button
                key={note.id}
                role="option"
                type="button"
                aria-selected={index === selectedIndex}
                className={`command-row ${index === selectedIndex ? "is-selected" : ""}`}
                onClick={() => onSelectNote(note.id)}
                onPointerMove={() => setSelectedIndex(index)}
              >
                <FileText size={16} aria-hidden="true" />
                <span className="command-row-content">
                  <span className="command-row-label">{note.title || "未命名笔记"}</span>
                </span>
                <span className="command-row-trailing">
                  {note.notebookName && (
                    <span className="split-note-notebook">{note.notebookName}</span>
                  )}
                  <span className="note-row-date">{relativeDate(note.updatedAt)}</span>
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </dialog>
  );
});
