import { Check, CheckCircle2, Clock, Inbox, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { KanbanCard, KanbanStatus, NoteSummary } from "../../shared/types";
import { relativeDate } from "./helpers";

export const COLUMNS: ReadonlyArray<{
  id: KanbanStatus;
  title: string;
  icon: typeof Inbox;
}> = [
  { id: "inbox", title: "收集箱", icon: Inbox },
  { id: "doing", title: "进行中", icon: Clock },
  { id: "done", title: "已完成", icon: CheckCircle2 },
];

export function getDialogTabTarget(
  focusableElements: readonly HTMLElement[],
  activeElement: Element | null,
  shiftKey: boolean,
) {
  if (focusableElements.length === 0) return null;
  const currentIndex = focusableElements.indexOf(activeElement as HTMLElement);
  const first = focusableElements[0];
  const last = focusableElements[focusableElements.length - 1];
  if (currentIndex < 0) return shiftKey ? last : first;
  const nextIndex =
    (currentIndex + (shiftKey ? -1 : 1) + focusableElements.length) % focusableElements.length;
  return focusableElements[nextIndex];
}

export function AddExistingNoteModal({
  open,
  targetStatus,
  availableNotes,
  cards,
  returnFocus,
  onClose,
  onSelect,
}: {
  open: boolean;
  targetStatus: KanbanStatus;
  availableNotes: NoteSummary[];
  cards: KanbanCard[];
  returnFocus: HTMLElement | null;
  onClose: () => void;
  onSelect: (noteId: string, status: KanbanStatus) => void;
}) {
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const existingNoteIds = useMemo(() => new Set(cards.map((c) => c.noteId)), [cards]);

  useEffect(() => {
    if (!open) return;
    setSearch("");
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 50);
    return () => {
      window.clearTimeout(focusTimer);
      const target =
        returnFocus?.isConnected && !returnFocus.matches(":disabled") ? returnFocus : previousFocus;
      if (target?.isConnected) target.focus({ preventScroll: true });
    };
  }, [open, returnFocus]);

  const candidates = useMemo(() => {
    const q = search.trim().toLowerCase();
    return availableNotes
      .filter((n) => !existingNoteIds.has(n.id) && n.deletedAt === null)
      .filter((n) => !q || n.title.toLowerCase().includes(q) || n.preview.toLowerCase().includes(q))
      .slice(0, 30);
  }, [availableNotes, existingNoteIds, search]);

  if (!open) return null;

  const targetCol = COLUMNS.find((c) => c.id === targetStatus);

  return (
    <div className="kanban-dialog-backdrop" onClick={onClose}>
      <div
        className="kanban-dialog-box"
        role="dialog"
        aria-modal="true"
        aria-labelledby="kanban-add-note-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
            }
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
            return;
          }
          if (event.key !== "Tab") return;
          const focusableElements = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
            ),
          );
          const target = getDialogTabTarget(
            focusableElements,
            document.activeElement,
            event.shiftKey,
          );
          if (!target) return;
          event.preventDefault();
          target.focus();
        }}
      >
        <div className="kanban-dialog-header">
          <h3 id="kanban-add-note-title">添加笔记到“{targetCol?.title ?? "看板"}”</h3>
          <button
            type="button"
            className="kanban-icon-btn"
            aria-label="关闭对话框"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        <div className="kanban-dialog-search">
          <Search size={15} className="kanban-dialog-search-icon" />
          <input
            ref={inputRef}
            type="search"
            value={search}
            placeholder="搜索要添加的笔记..."
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="kanban-dialog-list">
          {candidates.length === 0 ? (
            <p className="kanban-dialog-empty">没有可添加的笔记</p>
          ) : (
            candidates.map((note) => (
              <button
                key={note.id}
                type="button"
                className="kanban-dialog-item"
                onClick={() => {
                  onSelect(note.id, targetStatus);
                  onClose();
                }}
              >
                <div className="kanban-dialog-item-title">{note.title || "未命名笔记"}</div>
                <div className="kanban-dialog-item-meta">
                  <span>{note.notebookName}</span>
                  <time>{relativeDate(note.updatedAt)}</time>
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

export function MoveKanbanCardSheet({
  card,
  onClose,
  onSelect,
}: {
  card: KanbanCard;
  onClose: () => void;
  onSelect: (status: KanbanStatus) => void;
}) {
  const sheetRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const title = card.note.title.trim() || "未命名笔记";

  useEffect(() => {
    closeButtonRef.current?.focus({ preventScroll: true });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const buttons =
        sheetRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
      const firstButton = buttons?.[0];
      const lastButton = buttons?.[buttons.length - 1];
      if (event.shiftKey && document.activeElement === firstButton) {
        event.preventDefault();
        lastButton?.focus();
      } else if (!event.shiftKey && document.activeElement === lastButton) {
        event.preventDefault();
        firstButton?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose]);

  return (
    <div className="kanban-move-sheet-backdrop" onClick={onClose}>
      <section
        ref={sheetRef}
        className="kanban-move-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="kanban-move-sheet-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="kanban-move-sheet-grabber" aria-hidden="true" />
        <header className="kanban-move-sheet-header">
          <div className="kanban-move-sheet-heading">
            <h3 id="kanban-move-sheet-title">移动到</h3>
            <p>{title}</p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="kanban-icon-btn"
            aria-label="关闭状态选择"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>
        <div className="kanban-move-sheet-options" role="group" aria-label="选择任务状态">
          {COLUMNS.map((column) => {
            const isCurrent = column.id === card.status;
            return (
              <button
                key={column.id}
                type="button"
                className={`kanban-move-sheet-option kanban-move-sheet-option--${column.id}`}
                aria-current={isCurrent ? "true" : undefined}
                disabled={isCurrent}
                onClick={() => onSelect(column.id)}
              >
                <span
                  className={`kanban-column-dot kanban-column-dot--${column.id}`}
                  aria-hidden="true"
                />
                <span className="kanban-move-sheet-option-title">{column.title}</span>
                {isCurrent && (
                  <span className="kanban-move-sheet-current">
                    <Check size={14} aria-hidden="true" />
                    <span>当前</span>
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}
