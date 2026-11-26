import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type TouchEvent as ReactTouchEvent,
} from "react";
import { Plus, Search, Star } from "lucide-react";
import type { KanbanCard, KanbanStatus, NoteSummary } from "../../shared/types";
import { FloatingScrollbar } from "../floating-scrollbar";
import { getNoteTags, relativeDate } from "./helpers";
import { handleKanbanCardKeyDown } from "./kanban-card-keyboard";
import { COLUMNS } from "./kanban-dialogs";
import { NoteTags } from "./note-tags";
import { useScrollEdges } from "./use-scroll-edges";
import { useVirtualKanbanColumn } from "./use-virtual-kanban-column";

export type KanbanColumnData = {
  cards: KanbanCard[];
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
  isLoadingMore: boolean;
  loadMoreError: string | null;
};

const KanbanCardItem = memo(function KanbanCardItem({
  card,
  cardRef,
  isMobileViewport,
  onOpen,
  onToggleFavorite,
  onRequestMoveCard,
  onDragStart,
  onDragEnd,
  isDragging,
}: {
  card: KanbanCard;
  cardRef?: (element: HTMLElement | null) => void;
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
      ref={cardRef}
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
      onKeyDown={(event) => handleKanbanCardKeyDown(event, () => onOpen(card.noteId))}
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

export const KanbanColumnView = memo(function KanbanColumnView({
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
  onAddExistingNote: (status: KanbanStatus, trigger: HTMLButtonElement) => void;
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
  const virtual = useVirtualKanbanColumn(cards, scrollRef);
  const columnRef = useRef<HTMLDivElement>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement>(null);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const [dropIndicatorIndex, setDropIndicatorIndex] = useState<number | null>(null);

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

  const getDropIndex = (clientY: number) => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return cards.length;

    const cardElements = Array.from(
      scrollEl.querySelectorAll<HTMLElement>("[data-kanban-note-id]"),
    );
    let targetIndex = virtual.isVirtualized
      ? virtual.startIndex + cardElements.length
      : cards.length;
    for (let i = 0; i < cardElements.length; i++) {
      const rect = cardElements[i].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) {
        targetIndex = virtual.isVirtualized ? virtual.startIndex + i : i;
        break;
      }
    }
    return Math.min(cards.length, targetIndex);
  };

  const handleDragOver = (e: ReactDragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setIsDropTarget(true);
    setDropIndicatorIndex(getDropIndex(e.clientY));
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
    setDropIndicatorIndex(null);
    onDropOnColumn(column.id, getDropIndex(e.clientY));
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
            onClick={(event) => onAddExistingNote(column.id, event.currentTarget)}
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
        className={`kanban-column-scroll-shell scroll-edge${scrollEdges.before ? " has-scroll-before" : ""}${scrollEdges.after ? " has-scroll-after" : ""}`}
      >
        <div
          ref={setScrollRef}
          id={`kanban-scroll-${column.id}`}
          className="kanban-column-scroll floating-scrollbar-target"
        >
          {virtual.paddingTop > 0 && (
            <div
              className="kanban-virtual-spacer"
              style={{ height: virtual.paddingTop }}
              aria-hidden="true"
            />
          )}
          {cards.length === 0 ? (
            <div className="kanban-column-empty">
              {isDropTarget ? <div className="kanban-drop-indicator" /> : <span>暂无卡片</span>}
            </div>
          ) : (
            <div className={`kanban-card-list${virtual.isVirtualized ? " is-virtualized" : ""}`}>
              {virtual.visibleCards.map((card, idx) => {
                const actualIndex = virtual.startIndex + idx;
                const showIndicatorBefore = isDropTarget && dropIndicatorIndex === actualIndex;
                return (
                  <Fragment key={card.noteId}>
                    {showIndicatorBefore && <div className="kanban-drop-indicator" />}
                    <KanbanCardItem
                      card={card}
                      cardRef={virtual.getCardRef(card.noteId)}
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
          {virtual.paddingBottom > 0 && (
            <div
              className="kanban-virtual-spacer"
              style={{ height: virtual.paddingBottom }}
              aria-hidden="true"
            />
          )}

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
