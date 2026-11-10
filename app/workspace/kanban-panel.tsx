import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type TouchEvent as ReactTouchEvent,
} from "react";
import {
  Check,
  CheckCircle2,
  ChevronLeft,
  Clock,
  Inbox,
  Plus,
  Search,
  Star,
  Trash2,
  X,
} from "lucide-react";
import type { KanbanCard, KanbanStatus, NoteSummary } from "../../shared/types";
import { playEntranceAnimation } from "../animation";
import { FloatingScrollbar } from "../floating-scrollbar";
import { getNoteTags, relativeDate } from "./helpers";
import { NoteTags } from "./note-tags";
import {
  calculateTargetSortOrder,
  KANBAN_DRAG_MIME_TYPE,
  parseKanbanDragPayload,
  parseNoteIdsFromDrag,
  type KanbanDragPayload,
} from "./kanban-drag";
import { NOTE_DRAG_MIME_TYPE, setNoteDragImage } from "./note-drag-drop";
import { useVirtualKanbanColumn } from "./use-virtual-kanban-column";
import { useScrollEdges } from "./use-scroll-edges";

const COLUMNS: ReadonlyArray<{
  id: KanbanStatus;
  title: string;
  icon: typeof Inbox;
}> = [
  { id: "inbox", title: "收集箱", icon: Inbox },
  { id: "doing", title: "进行中", icon: Clock },
  { id: "done", title: "已完成", icon: CheckCircle2 },
];

export type KanbanColumnData = {
  cards: KanbanCard[];
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
  isLoadingMore: boolean;
  loadMoreError: string | null;
};

export type KanbanPanelProps = {
  columns: Record<KanbanStatus, KanbanColumnData>;
  loading?: boolean;
  onOpenNote: (noteId: string) => void;
  onCreateNoteInColumn: (status: KanbanStatus) => void;
  onAddExistingNote: (noteId: string, status: KanbanStatus) => void;
  onMoveCard: (noteId: string, targetStatus: KanbanStatus, targetSortOrder: number) => void;
  onTrashCard: (noteId: string) => void;
  onLoadMoreColumn: (status: KanbanStatus) => void;
  onToggleFavorite?: (note: NoteSummary) => void;
  onBack?: () => void;
  isMobileViewport?: boolean;
  availableNotes?: NoteSummary[];
};

// Single Kanban Card Item
const KanbanCardItem = memo(function KanbanCardItem({
  card,
  isMobileViewport,
  onOpen,
  onToggleFavorite,
  onRequestMoveCard,
  onDragStart,
  onDragEnd,
  isDragging,
}: {
  card: KanbanCard;
  isMobileViewport?: boolean;
  onOpen: (noteId: string) => void;
  onToggleFavorite?: (note: NoteSummary) => void;
  onRequestMoveCard: (card: KanbanCard, trigger: HTMLElement) => void;
  onDragStart: (card: KanbanCard, event: ReactDragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  isDragging: boolean;
}) {
  const note = card.note;
  const displayTitle = note.title.trim() || "未命名笔记";
  const hasThumbnail = Boolean(note.thumbnail?.id);
  const tags = getNoteTags(note);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressClickRef = useRef(false);
  const suppressClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  const clearLongPress = () => {
    if (longPressTimerRef.current !== null) clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = null;
    touchStartRef.current = null;
  };

  useEffect(
    () => () => {
      clearLongPress();
      if (suppressClickTimerRef.current !== null) clearTimeout(suppressClickTimerRef.current);
    },
    [],
  );

  const handleCardTouchStart = (event: ReactTouchEvent<HTMLElement>) => {
    if (!isMobileViewport) return;
    if (event.touches.length !== 1) {
      clearLongPress();
      return;
    }
    if (
      event.target instanceof Element &&
      event.target.closest("button, a, input, textarea, [contenteditable='true']")
    )
      return;

    clearLongPress();
    const touch = event.touches[0];
    touchStartRef.current = { x: touch.clientX, y: touch.clientY };
    const cardElement = event.currentTarget;
    longPressTimerRef.current = setTimeout(() => {
      longPressTimerRef.current = null;
      suppressClickRef.current = true;
      onRequestMoveCard(card, cardElement);
      suppressClickTimerRef.current = setTimeout(() => {
        suppressClickRef.current = false;
        suppressClickTimerRef.current = null;
      }, 750);
    }, 500);
  };

  const handleCardTouchMove = (event: ReactTouchEvent<HTMLElement>) => {
    const start = touchStartRef.current;
    const touch = event.touches[0];
    if (!start || !touch) return;
    if (Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > 10) clearLongPress();
  };

  const handleCardClick = (event: ReactMouseEvent<HTMLElement>) => {
    if (suppressClickRef.current) {
      event.preventDefault();
      event.stopPropagation();
      suppressClickRef.current = false;
      if (suppressClickTimerRef.current !== null) clearTimeout(suppressClickTimerRef.current);
      suppressClickTimerRef.current = null;
      return;
    }
    onOpen(card.noteId);
  };

  const handleStarClick = (event: ReactMouseEvent) => {
    event.stopPropagation();
    onToggleFavorite?.(note);
  };

  const handleDragStart = (e: ReactDragEvent<HTMLElement>) => {
    if (isMobileViewport) return;
    onDragStart(card, e);
  };

  return (
    <article
      data-kanban-note-id={card.noteId}
      draggable={!isMobileViewport}
      onDragStart={handleDragStart}
      onDragEnd={onDragEnd}
      onClick={handleCardClick}
      onTouchStart={handleCardTouchStart}
      onTouchMove={handleCardTouchMove}
      onTouchEnd={clearLongPress}
      onTouchCancel={clearLongPress}
      onContextMenu={(event) => {
        if (!isMobileViewport) return;
        event.preventDefault();
        event.stopPropagation();
      }}
      className={`kanban-card ${isDragging ? "is-dragging" : ""}`}
      tabIndex={0}
      role="listitem"
      aria-label={`${displayTitle}，看板卡片`}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(card.noteId);
        }
      }}
    >
      {hasThumbnail && (
        <div className="kanban-card-cover">
          <img
            src={`/api/assets/${encodeURIComponent(note.thumbnail!.id)}`}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
          />
        </div>
      )}

      <div className="kanban-card-body">
        <div className="kanban-card-header has-favorite-action">
          <h4 className="kanban-card-title">{displayTitle}</h4>
          <button
            type="button"
            className={`note-card-star-btn ${note.isFavorite ? "is-favorite" : ""}`}
            onClick={handleStarClick}
            aria-label={note.isFavorite ? "取消收藏" : "加入收藏"}
            aria-pressed={note.isFavorite}
          >
            <Star size={15} fill={note.isFavorite ? "currentColor" : "none"} />
          </button>
        </div>

        <NoteTags tags={tags} variant="card" />

        {note.preview ? (
          <p className="note-card-preview-text">{note.preview}</p>
        ) : (
          <p className="note-card-preview-empty">无正文内容</p>
        )}

        <div className="kanban-card-footer">
          <span className="kanban-card-notebook">{note.notebookName || "笔记"}</span>
          <time className="kanban-card-time">{relativeDate(note.updatedAt)}</time>
        </div>
      </div>
    </article>
  );
});

// Single Kanban Column
const KanbanColumnView = memo(function KanbanColumnView({
  column,
  columnData,
  isMobileViewport,
  draggingNoteId,
  onOpenNote,
  onCreateNote,
  onAddExistingNote,
  onCardDragStart,
  onCardDragEnd,
  onDropOnColumn,
  onLoadMore,
  onToggleFavorite,
  onRequestMoveCard,
}: {
  column: (typeof COLUMNS)[number];
  columnData: KanbanColumnData;
  isMobileViewport?: boolean;
  draggingNoteId: string | null;
  onOpenNote: (noteId: string) => void;
  onCreateNote: (status: KanbanStatus) => void;
  onAddExistingNote: (status: KanbanStatus) => void;
  onCardDragStart: (card: KanbanCard, event: ReactDragEvent<HTMLElement>) => void;
  onCardDragEnd: () => void;
  onDropOnColumn: (status: KanbanStatus, targetIndex: number) => void;
  onLoadMore: (status: KanbanStatus) => void;
  onToggleFavorite?: (note: NoteSummary) => void;
  onRequestMoveCard: (card: KanbanCard, trigger: HTMLElement) => void;
}) {
  const { cards, total, hasMore, isLoadingMore, loadMoreError } = columnData;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const setScrollRef = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el;
    setScrollElement(el);
  }, []);
  const columnRef = useRef<HTMLDivElement>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement>(null);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const [dropIndicatorIndex, setDropIndicatorIndex] = useState<number | null>(null);

  const virtual = useVirtualKanbanColumn(cards, scrollRef);
  const scrollEdges = useScrollEdges(scrollElement, [
    column.id,
    cards.length,
    virtual.paddingTop,
    virtual.paddingBottom,
    virtual.isVirtualized,
    hasMore,
    isLoadingMore,
  ]);

  useEffect(() => {
    const sentinel = loadMoreSentinelRef.current;
    const container = scrollRef.current;
    if (!sentinel || !container || !hasMore || isLoadingMore || loadMoreError) return;
    if (typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting) {
          onLoadMore(column.id);
        }
      },
      {
        root: container,
        rootMargin: "260px 0px",
      },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [column.id, hasMore, isLoadingMore, loadMoreError, onLoadMore]);

  const handleDragOver = (e: ReactDragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setIsDropTarget(true);

    const scrollEl = scrollRef.current;
    if (!scrollEl) return;

    // Calculate which card boundary cursor is closest to
    const cardElements = Array.from(
      scrollEl.querySelectorAll<HTMLElement>("[data-kanban-note-id]"),
    );
    let targetIndex = cards.length;
    for (let i = 0; i < cardElements.length; i++) {
      const rect = cardElements[i].getBoundingClientRect();
      if (e.clientY < rect.top + rect.height / 2) {
        targetIndex = virtual.isVirtualized ? virtual.startIndex + i : i;
        break;
      }
    }
    setDropIndicatorIndex(targetIndex);
  };

  const handleDragLeave = (e: ReactDragEvent<HTMLDivElement>) => {
    if (!columnRef.current?.contains(e.relatedTarget as Node)) {
      setIsDropTarget(false);
      setDropIndicatorIndex(null);
    }
  };

  const handleDrop = (e: ReactDragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDropTarget(false);
    const index = dropIndicatorIndex ?? cards.length;
    setDropIndicatorIndex(null);
    onDropOnColumn(column.id, index);
  };

  return (
    <div
      ref={columnRef}
      className={`kanban-column kanban-column--${column.id} ${isDropTarget ? "is-drop-target" : ""}`}
      data-kanban-status={column.id}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="kanban-column-header">
        <div className="kanban-column-title-group">
          <span
            className={`kanban-column-dot kanban-column-dot--${column.id}`}
            aria-hidden="true"
          />
          <h3 className="kanban-column-title">{column.title}</h3>
          <span className="kanban-column-count">{total}</span>
        </div>
        <div className="kanban-column-header-actions">
          <button
            type="button"
            className="kanban-icon-btn"
            aria-label={`添加现有笔记到${column.title}`}
            onClick={() => onAddExistingNote(column.id)}
          >
            <Search size={14} />
          </button>
          <button
            type="button"
            className="kanban-icon-btn"
            aria-label={`在${column.title}新建笔记`}
            onClick={() => onCreateNote(column.id)}
          >
            <Plus size={15} />
          </button>
        </div>
      </div>

      <div
        className={`kanban-column-scroll-shell${scrollEdges.before ? " has-scroll-before" : ""}${scrollEdges.after ? " has-scroll-after" : ""}`}
      >
        <div ref={setScrollRef} className="kanban-column-scroll floating-scrollbar-target">
          {virtual.paddingTop > 0 && <div style={{ height: virtual.paddingTop }} />}

          {cards.length === 0 ? (
            <div className="kanban-column-empty">
              <p>暂无卡片</p>
              <button
                type="button"
                className="kanban-empty-create-btn"
                onClick={() => onCreateNote(column.id)}
              >
                <Plus size={14} />
                <span>新建笔记</span>
              </button>
            </div>
          ) : (
            <div className="kanban-card-list">
              {virtual.visibleCards.map((card, idx) => {
                const actualIndex = virtual.isVirtualized ? virtual.startIndex + idx : idx;
                const showIndicatorBefore = isDropTarget && dropIndicatorIndex === actualIndex;
                return (
                  <Fragment key={card.noteId}>
                    {showIndicatorBefore && <div className="kanban-drop-indicator" />}
                    <KanbanCardItem
                      card={card}
                      isMobileViewport={isMobileViewport}
                      onOpen={onOpenNote}
                      onToggleFavorite={onToggleFavorite}
                      onRequestMoveCard={onRequestMoveCard}
                      onDragStart={onCardDragStart}
                      onDragEnd={onCardDragEnd}
                      isDragging={draggingNoteId === card.noteId}
                    />
                  </Fragment>
                );
              })}
              {isDropTarget &&
                dropIndicatorIndex !== null &&
                dropIndicatorIndex >= cards.length && <div className="kanban-drop-indicator" />}
            </div>
          )}

          {virtual.paddingBottom > 0 && <div style={{ height: virtual.paddingBottom }} />}

          {hasMore && (
            <div ref={loadMoreSentinelRef} className="kanban-column-load-more">
              {loadMoreError ? (
                <button
                  type="button"
                  className="kanban-column-load-more-btn is-error"
                  onClick={() => onLoadMore(column.id)}
                >
                  {loadMoreError}，点击重试
                </button>
              ) : isLoadingMore ? (
                <span className="kanban-column-load-more-text">正在加载更多……</span>
              ) : (
                <span className="kanban-column-load-more-text kanban-column-load-more-text--idle">
                  向下滚动加载更多
                </span>
              )}
            </div>
          )}
        </div>
        <FloatingScrollbar
          scrollTargetRef={scrollRef}
          controlsId={`kanban-scroll-${column.id}`}
          ariaLabel={`${column.title}滚动条`}
          placement="right"
        />
      </div>
    </div>
  );
});

// Add Existing Note Modal Dialog
function AddExistingNoteModal({
  open,
  targetStatus,
  availableNotes,
  cards,
  onClose,
  onSelect,
}: {
  open: boolean;
  targetStatus: KanbanStatus;
  availableNotes: NoteSummary[];
  cards: KanbanCard[];
  onClose: () => void;
  onSelect: (noteId: string, status: KanbanStatus) => void;
}) {
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const existingNoteIds = useMemo(() => new Set(cards.map((c) => c.noteId)), [cards]);

  useEffect(() => {
    if (open) {
      setSearch("");
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

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

function MoveKanbanCardSheet({
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

// Main KanbanPanel Export
export const KanbanPanel = memo(function KanbanPanel({
  columns,
  loading = false,
  onOpenNote,
  onCreateNoteInColumn,
  onAddExistingNote,
  onMoveCard,
  onTrashCard,
  onLoadMoreColumn,
  onToggleFavorite,
  onBack,
  isMobileViewport = false,
  availableNotes = [],
}: KanbanPanelProps) {
  const panelRef = useRef<HTMLElement>(null);
  const [activeMobileColumn, setActiveMobileColumn] = useState<KanbanStatus>("inbox");
  const [draggingCard, setDraggingCard] = useState<KanbanDragPayload | null>(null);
  const [movingCard, setMovingCard] = useState<KanbanCard | null>(null);
  const [addModalStatus, setAddModalStatus] = useState<KanbanStatus | null>(null);
  const [trashOver, setTrashOver] = useState(false);
  const moveCardRef = useRef<HTMLElement | null>(null);

  const allCards = useMemo(() => Object.values(columns).flatMap((col) => col.cards), [columns]);

  const totalNotesCount = useMemo(
    () => Object.values(columns).reduce((sum, col) => sum + (col.total ?? 0), 0),
    [columns],
  );

  const restoreMoveCardFocus = useCallback(() => {
    requestAnimationFrame(() => {
      if (moveCardRef.current?.isConnected) {
        moveCardRef.current.focus({ preventScroll: true });
        return;
      }
      panelRef.current
        ?.querySelector<HTMLButtonElement>(".kanban-mobile-tab.is-active")
        ?.focus({ preventScroll: true });
    });
  }, []);

  const handleRequestMoveCard = useCallback((card: KanbanCard, trigger: HTMLElement) => {
    moveCardRef.current = trigger;
    setMovingCard(card);
  }, []);

  const closeMoveCardSheet = useCallback(() => {
    setMovingCard(null);
    restoreMoveCardFocus();
  }, [restoreMoveCardFocus]);

  const handleMoveCardToStatus = useCallback(
    (targetStatus: KanbanStatus) => {
      if (!movingCard) return;
      if (targetStatus !== movingCard.status) {
        const targetCards = columns[targetStatus]?.cards ?? [];
        onMoveCard(
          movingCard.noteId,
          targetStatus,
          calculateTargetSortOrder(targetCards, 0, movingCard.noteId),
        );
      }
      setMovingCard(null);
      restoreMoveCardFocus();
    },
    [columns, movingCard, onMoveCard, restoreMoveCardFocus],
  );

  // Entrance animation
  useLayoutEffect(() => {
    if (!panelRef.current) return;
    const columnElements = panelRef.current.querySelectorAll<HTMLElement>(
      ".kanban-column, .kanban-column-mobile-wrap",
    );
    const animations = [...columnElements]
      .map((col) => playEntranceAnimation(col, "page-content-in"))
      .filter((anim): anim is Animation => anim !== null);
    return () => animations.forEach((anim) => anim.cancel());
  }, []);

  const handleCardDragStart = useCallback(
    (card: KanbanCard, event: ReactDragEvent<HTMLElement>) => {
      if (isMobileViewport) return;
      const payload: KanbanDragPayload = {
        noteId: card.noteId,
        sourceStatus: card.status,
        sortOrder: card.sortOrder,
      };
      event.dataTransfer.setData(KANBAN_DRAG_MIME_TYPE, JSON.stringify(payload));
      event.dataTransfer.setData(NOTE_DRAG_MIME_TYPE, JSON.stringify([card.noteId]));
      event.dataTransfer.setData("text/plain", card.noteId);
      event.dataTransfer.effectAllowed = "move";
      setNoteDragImage(event.dataTransfer, event.currentTarget, 1);

      requestAnimationFrame(() => {
        setDraggingCard(payload);
      });
    },
    [isMobileViewport],
  );

  const handleCardDragEnd = useCallback(() => {
    setDraggingCard(null);
    setTrashOver(false);
  }, []);

  const handleDropOnColumn = useCallback(
    (targetStatus: KanbanStatus, targetIndex: number) => {
      if (!draggingCard) return;
      const targetColumnCards = columns[targetStatus]?.cards ?? [];
      const newSortOrder = calculateTargetSortOrder(
        targetColumnCards,
        targetIndex,
        draggingCard.noteId,
      );
      onMoveCard(draggingCard.noteId, targetStatus, newSortOrder);
      setDraggingCard(null);
    },
    [columns, draggingCard, onMoveCard],
  );

  // Drop on Corner Trash Zone
  const handleTrashDragOver = (e: ReactDragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    setTrashOver(true);
  };
  const handleTrashDragLeave = (e: ReactDragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setTrashOver(false);
  };
  const handleTrashDrop = (e: ReactDragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setTrashOver(false);
    const payload = parseKanbanDragPayload(e.dataTransfer);
    const noteIds = parseNoteIdsFromDrag(e.dataTransfer);
    const targetId = payload?.noteId || noteIds[0] || draggingCard?.noteId;
    if (targetId) {
      onTrashCard(targetId);
    }
    setDraggingCard(null);
  };

  return (
    <section
      ref={panelRef}
      className={`kanban-panel ${isMobileViewport ? "is-mobile" : ""}`}
      aria-label="看板视图"
      aria-busy={loading}
    >
      {/* Mobile Top Header (Desktop has no top bar) */}
      {isMobileViewport && (
        <header className="list-header kanban-header">
          {onBack && (
            <button
              className="tasks-back tasks-header-back kanban-header-back"
              type="button"
              onClick={onBack}
              aria-label="返回"
            >
              <ChevronLeft size={18} aria-hidden="true" />
              <span>返回</span>
            </button>
          )}
          <div className="list-header-main">
            <h2>看板</h2>
            <p className="kanban-count">{totalNotesCount} 篇笔记</p>
          </div>
        </header>
      )}

      {/* Mobile Segmented Tabs */}
      {isMobileViewport && (
        <div className="kanban-mobile-tabs" role="tablist">
          {COLUMNS.map((col) => {
            const count = columns[col.id]?.total ?? 0;
            const active = activeMobileColumn === col.id;
            return (
              <button
                key={col.id}
                role="tab"
                aria-selected={active}
                className={`kanban-mobile-tab kanban-mobile-tab--${col.id} ${active ? "is-active" : ""}`}
                onClick={() => setActiveMobileColumn(col.id)}
              >
                <span
                  className={`kanban-column-dot kanban-column-dot--${col.id}`}
                  aria-hidden="true"
                />
                <span>{col.title}</span>
                <span className="kanban-mobile-tab-count">{count}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Kanban Columns Board */}
      <div className="kanban-board">
        {isMobileViewport ? (
          <div className="kanban-column-mobile-wrap">
            {(() => {
              const activeCol = COLUMNS.find((c) => c.id === activeMobileColumn) ?? COLUMNS[0];
              return (
                <KanbanColumnView
                  key={activeCol.id}
                  column={activeCol}
                  columnData={columns[activeCol.id]}
                  isMobileViewport={true}
                  draggingNoteId={draggingCard?.noteId ?? null}
                  onOpenNote={onOpenNote}
                  onCreateNote={onCreateNoteInColumn}
                  onAddExistingNote={(status) => setAddModalStatus(status)}
                  onCardDragStart={handleCardDragStart}
                  onCardDragEnd={handleCardDragEnd}
                  onDropOnColumn={handleDropOnColumn}
                  onLoadMore={onLoadMoreColumn}
                  onToggleFavorite={onToggleFavorite}
                  onRequestMoveCard={handleRequestMoveCard}
                />
              );
            })()}
          </div>
        ) : (
          COLUMNS.map((col) => (
            <KanbanColumnView
              key={col.id}
              column={col}
              columnData={columns[col.id]}
              isMobileViewport={false}
              draggingNoteId={draggingCard?.noteId ?? null}
              onOpenNote={onOpenNote}
              onCreateNote={onCreateNoteInColumn}
              onAddExistingNote={(status) => setAddModalStatus(status)}
              onCardDragStart={handleCardDragStart}
              onCardDragEnd={handleCardDragEnd}
              onDropOnColumn={handleDropOnColumn}
              onLoadMore={onLoadMoreColumn}
              onToggleFavorite={onToggleFavorite}
              onRequestMoveCard={handleRequestMoveCard}
            />
          ))
        )}
      </div>

      {/* Corner Drop Zone during drag (右下角移动到回收站) */}
      {draggingCard !== null && (
        <div
          className={`kanban-corner-zone kanban-corner-zone--trash ${trashOver ? "is-over" : ""}`}
          onDragOver={handleTrashDragOver}
          onDragLeave={handleTrashDragLeave}
          onDrop={handleTrashDrop}
          role="region"
          aria-label="拖拽至此移到回收站"
        >
          <div className="kanban-corner-zone-content">
            <div className="kanban-corner-icon-circle">
              <Trash2 size={18} className="kanban-corner-icon" />
            </div>
            <span className="kanban-corner-label">移到回收站</span>
          </div>
        </div>
      )}

      {isMobileViewport && movingCard && (
        <MoveKanbanCardSheet
          card={movingCard}
          onClose={closeMoveCardSheet}
          onSelect={handleMoveCardToStatus}
        />
      )}

      {/* Add Existing Note Dialog */}
      <AddExistingNoteModal
        open={addModalStatus !== null}
        targetStatus={addModalStatus ?? "inbox"}
        availableNotes={availableNotes}
        cards={allCards}
        onClose={() => setAddModalStatus(null)}
        onSelect={onAddExistingNote}
      />
    </section>
  );
});
