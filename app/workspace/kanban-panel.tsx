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
} from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  Clock,
  Inbox,
  Plus,
  Search,
  Star,
  Trash2,
  X,
} from "lucide-react";
import type { KanbanCard, KanbanStatus, NoteSummary, Notebook } from "../../shared/types";
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
  notebooks: Notebook[];
  notebookId?: string;
  onNotebookChange: (id: string) => void;
  loading?: boolean;
  onOpenNote: (noteId: string) => void;
  onCreateNoteInColumn: (status: KanbanStatus) => void;
  onAddExistingNote: (noteId: string, status: KanbanStatus) => void;
  onMoveCard: (noteId: string, targetStatus: KanbanStatus, targetSortOrder: number) => void;
  onRemoveCard?: (noteId: string) => void;
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
  onDragStart,
  onDragEnd,
  isDragging,
}: {
  card: KanbanCard;
  isMobileViewport?: boolean;
  onOpen: (noteId: string) => void;
  onToggleFavorite?: (note: NoteSummary) => void;
  onDragStart: (card: KanbanCard, event: ReactDragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  isDragging: boolean;
}) {
  const note = card.note;
  const displayTitle = note.title.trim() || "未命名笔记";
  const hasThumbnail = Boolean(note.thumbnail?.id);
  const tags = getNoteTags(note);

  const handleCardClick = () => {
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

// Main KanbanPanel Export
export const KanbanPanel = memo(function KanbanPanel({
  columns,
  notebooks,
  notebookId = "",
  onNotebookChange,
  loading = false,
  onOpenNote,
  onCreateNoteInColumn,
  onAddExistingNote,
  onMoveCard,
  onRemoveCard,
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
  const [openFilter, setOpenFilter] = useState<"notebook" | null>(null);
  const [addModalStatus, setAddModalStatus] = useState<KanbanStatus | null>(null);
  const [trashOver, setTrashOver] = useState(false);

  const notebookTriggerRef = useRef<HTMLButtonElement>(null);
  const notebookMenuRef = useRef<HTMLDivElement>(null);

  const allCards = useMemo(() => Object.values(columns).flatMap((col) => col.cards), [columns]);

  const totalNotesCount = useMemo(
    () => Object.values(columns).reduce((sum, col) => sum + (col.total ?? 0), 0),
    [columns],
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

  const selectedNotebookName = useMemo(() => {
    if (!notebookId) return "全部笔记本";
    const found = notebooks.find((nb) => nb.id === notebookId);
    return found?.name ?? "全部笔记本";
  }, [notebookId, notebooks]);

  return (
    <section
      ref={panelRef}
      className={`kanban-panel ${isMobileViewport ? "is-mobile" : ""}`}
      aria-label="看板视图"
      aria-busy={loading}
    >
      {/* Top Header / Toolbar */}
      <header className="kanban-header">
        <div className="kanban-header-left">
          {onBack && (
            <button
              className="tasks-back kanban-header-back"
              type="button"
              onClick={onBack}
              aria-label="返回"
            >
              <ChevronLeft size={18} aria-hidden="true" />
              <span>返回</span>
            </button>
          )}
          <h2 className="kanban-heading">看板</h2>
          <span className="kanban-total-count">{totalNotesCount} 篇笔记</span>
        </div>

        <div className="kanban-header-right">
          {/* Notebook Filter Dropdown */}
          <div className="tasks-filter-dropdown kanban-notebook-dropdown">
            <button
              ref={notebookTriggerRef}
              type="button"
              className="tasks-filter-trigger kanban-filter-trigger"
              aria-label="筛选笔记本"
              aria-haspopup="menu"
              aria-expanded={openFilter === "notebook"}
              onClick={() => setOpenFilter((cur) => (cur === "notebook" ? null : "notebook"))}
            >
              <span>{selectedNotebookName}</span>
              <ChevronDown size={14} aria-hidden="true" />
            </button>
            {openFilter === "notebook" && (
              <div className="tasks-filter-menu-wrap">
                <div
                  ref={notebookMenuRef}
                  className="tasks-filter-menu floating-scrollbar-target"
                  role="menu"
                >
                  <button
                    type="button"
                    className={!notebookId ? "is-selected" : ""}
                    onClick={() => {
                      onNotebookChange("");
                      setOpenFilter(null);
                    }}
                  >
                    <span className="tasks-filter-option-label">全部笔记本</span>
                  </button>
                  {notebooks.map((nb) => (
                    <button
                      key={nb.id}
                      type="button"
                      className={notebookId === nb.id ? "is-selected" : ""}
                      onClick={() => {
                        onNotebookChange(nb.id);
                        setOpenFilter(null);
                      }}
                    >
                      <span className="tasks-filter-option-label">{nb.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </header>

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
