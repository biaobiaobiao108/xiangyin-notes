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
  Archive,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  Clock,
  Inbox,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Search,
  Star,
  Trash2,
  X,
} from "lucide-react";
import type { KanbanCard, KanbanStatus, NoteSummary, Notebook } from "../../shared/types";
import { playEntranceAnimation } from "../animation";
import { FloatingScrollbar } from "../floating-scrollbar";
import { relativeDate } from "./helpers";
import {
  calculateTargetSortOrder,
  KANBAN_DRAG_MIME_TYPE,
  parseKanbanDragPayload,
  parseNoteIdsFromDrag,
  type KanbanDragPayload,
} from "./kanban-drag";
import { NOTE_DRAG_MIME_TYPE, setNoteDragImage } from "./note-drag-drop";
import { useVirtualKanbanColumn } from "./use-virtual-kanban-column";

const COLUMNS: ReadonlyArray<{
  id: KanbanStatus;
  title: string;
  icon: typeof Inbox;
}> = [
  { id: "inbox", title: "收集箱", icon: Inbox },
  { id: "doing", title: "进行中", icon: Clock },
  { id: "done", title: "已完成", icon: CheckCircle2 },
];

export type KanbanPanelProps = {
  cards: KanbanCard[];
  notebooks: Notebook[];
  notebookId?: string;
  onNotebookChange: (id: string) => void;
  loading?: boolean;
  onOpenNote: (noteId: string) => void;
  onCreateNoteInColumn: (status: KanbanStatus) => void;
  onAddExistingNote: (noteId: string, status: KanbanStatus) => void;
  onMoveCard: (noteId: string, targetStatus: KanbanStatus, targetSortOrder: number) => void;
  onArchiveCard: (noteId: string) => void;
  onUnarchiveCard: (noteId: string, targetStatus: KanbanStatus) => void;
  onRemoveCard: (noteId: string) => void;
  onTrashCard: (noteId: string) => void;
  onBack?: () => void;
  isMobileViewport?: boolean;
  availableNotes?: NoteSummary[];
  archivedCards?: KanbanCard[];
  onOpenArchived?: () => void;
};

// Single Kanban Card Item
const KanbanCardItem = memo(function KanbanCardItem({
  card,
  isMobileViewport,
  onOpen,
  onMoveToStatus,
  onArchive,
  onRemove,
  onTrash,
  onDragStart,
  onDragEnd,
  isDragging,
}: {
  card: KanbanCard;
  isMobileViewport?: boolean;
  onOpen: (noteId: string) => void;
  onMoveToStatus: (noteId: string, status: KanbanStatus) => void;
  onArchive: (noteId: string) => void;
  onRemove: (noteId: string) => void;
  onTrash: (noteId: string) => void;
  onDragStart: (card: KanbanCard, event: ReactDragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  isDragging: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const note = card.note;
  const displayTitle = note.title.trim() || "未命名笔记";
  const hasThumbnail = Boolean(note.thumbnail?.id);

  useEffect(() => {
    if (!menuOpen) return;
    const handleOutside = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", handleOutside);
    return () => document.removeEventListener("pointerdown", handleOutside);
  }, [menuOpen]);

  const handleCardClick = (e: ReactMouseEvent) => {
    if ((e.target as HTMLElement).closest(".kanban-card-menu-btn, .kanban-card-menu")) {
      return;
    }
    onOpen(card.noteId);
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
        <div className="kanban-card-header">
          <h4 className="kanban-card-title">{displayTitle}</h4>
          <div className="kanban-card-actions" ref={menuRef}>
            {note.isFavorite && (
              <Star size={13} className="kanban-card-star is-favorite" aria-label="已收藏" />
            )}
            <button
              type="button"
              className="kanban-card-menu-btn"
              aria-label="卡片操作菜单"
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen(!menuOpen);
              }}
            >
              <MoreHorizontal size={14} />
            </button>
            {menuOpen && (
              <div className="kanban-card-menu" role="menu">
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    onOpen(card.noteId);
                  }}
                >
                  打开笔记
                </button>
                {COLUMNS.filter((c) => c.id !== card.status).map((col) => (
                  <button
                    key={col.id}
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      onMoveToStatus(card.noteId, col.id);
                    }}
                  >
                    移至{col.title}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    onArchive(card.noteId);
                  }}
                >
                  归档
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    onRemove(card.noteId);
                  }}
                >
                  从看板移出
                </button>
                <button
                  type="button"
                  className="is-danger"
                  onClick={() => {
                    setMenuOpen(false);
                    onTrash(card.noteId);
                  }}
                >
                  移到回收站
                </button>
              </div>
            )}
          </div>
        </div>

        {note.preview ? <p className="kanban-card-preview">{note.preview}</p> : null}

        {note.tags && note.tags.length > 0 && (
          <div className="kanban-card-tags">
            {note.tags.slice(0, 3).map((tag) => (
              <span key={tag} className="kanban-card-tag">
                #{tag}
              </span>
            ))}
            {note.tags.length > 3 && (
              <span className="kanban-card-tag kanban-card-tag--overflow">
                +{note.tags.length - 3}
              </span>
            )}
          </div>
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
  cards,
  isMobileViewport,
  draggingNoteId,
  onOpenNote,
  onCreateNote,
  onAddExistingNote,
  onMoveToStatus,
  onArchiveCard,
  onRemoveCard,
  onTrashCard,
  onCardDragStart,
  onCardDragEnd,
  onDropOnColumn,
}: {
  column: (typeof COLUMNS)[number];
  cards: KanbanCard[];
  isMobileViewport?: boolean;
  draggingNoteId: string | null;
  onOpenNote: (noteId: string) => void;
  onCreateNote: (status: KanbanStatus) => void;
  onAddExistingNote: (status: KanbanStatus) => void;
  onMoveToStatus: (noteId: string, status: KanbanStatus) => void;
  onArchiveCard: (noteId: string) => void;
  onRemoveCard: (noteId: string) => void;
  onTrashCard: (noteId: string) => void;
  onCardDragStart: (card: KanbanCard, event: ReactDragEvent<HTMLElement>) => void;
  onCardDragEnd: () => void;
  onDropOnColumn: (status: KanbanStatus, targetIndex: number) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const [dropIndicatorIndex, setDropIndicatorIndex] = useState<number | null>(null);

  const virtual = useVirtualKanbanColumn(cards, scrollRef);
  const Icon = column.icon;

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
      className={`kanban-column ${isDropTarget ? "is-drop-target" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="kanban-column-header">
        <div className="kanban-column-title-group">
          <Icon size={16} className="kanban-column-icon" />
          <h3 className="kanban-column-title">{column.title}</h3>
          <span className="kanban-column-count">{cards.length}</span>
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
            className="kanban-icon-btn kanban-icon-btn--primary"
            aria-label={`在${column.title}新建笔记`}
            onClick={() => onCreateNote(column.id)}
          >
            <Plus size={15} />
          </button>
        </div>
      </div>

      <div className="kanban-column-scroll-shell">
        <div ref={scrollRef} className="kanban-column-scroll floating-scrollbar-target">
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
                      onMoveToStatus={onMoveToStatus}
                      onArchive={onArchiveCard}
                      onRemove={onRemoveCard}
                      onTrash={onTrashCard}
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

// Archived Drawer Modal
function KanbanArchivedDrawer({
  open,
  archivedCards,
  onClose,
  onUnarchive,
  onTrash,
}: {
  open: boolean;
  archivedCards: KanbanCard[];
  onClose: () => void;
  onUnarchive: (noteId: string, targetStatus: KanbanStatus) => void;
  onTrash: (noteId: string) => void;
}) {
  if (!open) return null;

  return (
    <div className="kanban-dialog-backdrop" onClick={onClose}>
      <div
        className="kanban-archived-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="kanban-archived-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="kanban-archived-header">
          <div className="kanban-archived-title-group">
            <Archive size={17} />
            <h3 id="kanban-archived-title">已归档卡片</h3>
            <span className="kanban-column-count">{archivedCards.length}</span>
          </div>
          <button
            type="button"
            className="kanban-icon-btn"
            aria-label="关闭归档面板"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        <div className="kanban-archived-list">
          {archivedCards.length === 0 ? (
            <p className="kanban-dialog-empty">暂无归档卡片</p>
          ) : (
            archivedCards.map((card) => (
              <div key={card.noteId} className="kanban-archived-item">
                <div className="kanban-archived-item-main">
                  <div className="kanban-archived-item-title">
                    {card.note.title || "未命名笔记"}
                  </div>
                  <div className="kanban-archived-item-meta">
                    <span>{card.note.notebookName}</span>
                    <time>归档于 {relativeDate(card.updatedAt)}</time>
                  </div>
                </div>
                <div className="kanban-archived-item-actions">
                  <button
                    type="button"
                    className="kanban-btn-sm"
                    onClick={() => onUnarchive(card.noteId, "inbox")}
                  >
                    恢复到收集箱
                  </button>
                  <button
                    type="button"
                    className="kanban-btn-sm"
                    onClick={() => onUnarchive(card.noteId, "doing")}
                  >
                    恢复到进行中
                  </button>
                  <button
                    type="button"
                    className="kanban-icon-btn is-danger"
                    aria-label="移入回收站"
                    onClick={() => onTrash(card.noteId)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// Main KanbanPanel Export
export const KanbanPanel = memo(function KanbanPanel({
  cards,
  notebooks,
  notebookId = "",
  onNotebookChange,
  loading = false,
  onOpenNote,
  onCreateNoteInColumn,
  onAddExistingNote,
  onMoveCard,
  onArchiveCard,
  onUnarchiveCard,
  onRemoveCard,
  onTrashCard,
  onBack,
  isMobileViewport = false,
  availableNotes = [],
  archivedCards = [],
  onOpenArchived,
}: KanbanPanelProps) {
  const panelRef = useRef<HTMLElement>(null);
  const [activeMobileColumn, setActiveMobileColumn] = useState<KanbanStatus>("inbox");
  const [draggingCard, setDraggingCard] = useState<KanbanDragPayload | null>(null);
  const [openFilter, setOpenFilter] = useState<"notebook" | null>(null);
  const [addModalStatus, setAddModalStatus] = useState<KanbanStatus | null>(null);
  const [archivedDrawerOpen, setArchivedDrawerOpen] = useState(false);
  const [trashOver, setTrashOver] = useState(false);
  const [archiveOver, setArchiveOver] = useState(false);

  const notebookTriggerRef = useRef<HTMLButtonElement>(null);
  const notebookMenuRef = useRef<HTMLDivElement>(null);

  // Group cards by column
  const cardsByColumn = useMemo(() => {
    const map = new Map<KanbanStatus, KanbanCard[]>([
      ["inbox", []],
      ["doing", []],
      ["done", []],
    ]);
    for (const card of cards) {
      if (card.status !== "archived") {
        const list = map.get(card.status);
        if (list) list.push(card);
      }
    }
    // Sort each column by sortOrder ascending
    for (const list of map.values()) {
      list.sort((a, b) => a.sortOrder - b.sortOrder);
    }
    return map;
  }, [cards]);

  // Entrance animation
  useLayoutEffect(() => {
    if (!panelRef.current) return;
    const columns = panelRef.current.querySelectorAll<HTMLElement>(
      ".kanban-column, .kanban-column-mobile-wrap",
    );
    const animations = [...columns]
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
    setArchiveOver(false);
  }, []);

  const handleDropOnColumn = useCallback(
    (targetStatus: KanbanStatus, targetIndex: number) => {
      if (!draggingCard) return;
      const targetColumnCards = cardsByColumn.get(targetStatus) ?? [];
      const newSortOrder = calculateTargetSortOrder(
        targetColumnCards,
        targetIndex,
        draggingCard.noteId,
      );
      onMoveCard(draggingCard.noteId, targetStatus, newSortOrder);
      setDraggingCard(null);
    },
    [cardsByColumn, draggingCard, onMoveCard],
  );

  const handleMoveToStatus = useCallback(
    (noteId: string, status: KanbanStatus) => {
      const targetColumnCards = cardsByColumn.get(status) ?? [];
      const newSortOrder = calculateTargetSortOrder(
        targetColumnCards,
        targetColumnCards.length,
        noteId,
      );
      onMoveCard(noteId, status, newSortOrder);
    },
    [cardsByColumn, onMoveCard],
  );

  // Drop on Bottom Trash Zone
  const handleTrashDragOver = (e: ReactDragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setTrashOver(true);
  };
  const handleTrashDrop = (e: ReactDragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setTrashOver(false);
    const payload = parseKanbanDragPayload(e.dataTransfer);
    const noteIds = parseNoteIdsFromDrag(e.dataTransfer);
    const targetId = payload?.noteId || noteIds[0] || draggingCard?.noteId;
    if (targetId) {
      onTrashCard(targetId);
    }
    setDraggingCard(null);
  };

  // Drop on Bottom Archive Zone
  const handleArchiveDragOver = (e: ReactDragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setArchiveOver(true);
  };
  const handleArchiveDrop = (e: ReactDragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setArchiveOver(false);
    const payload = parseKanbanDragPayload(e.dataTransfer);
    const noteIds = parseNoteIdsFromDrag(e.dataTransfer);
    const targetId = payload?.noteId || noteIds[0] || draggingCard?.noteId;
    if (targetId) {
      onArchiveCard(targetId);
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
          <span className="kanban-total-count">
            {cards.filter((c) => c.status !== "archived").length} 篇笔记
          </span>
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

          {/* Archived Cards button */}
          <button
            type="button"
            className="kanban-archived-trigger"
            aria-label="查看已归档卡片"
            onClick={() => {
              onOpenArchived?.();
              setArchivedDrawerOpen(true);
            }}
          >
            <Archive size={15} />
            <span>已归档 ({archivedCards.length})</span>
          </button>
        </div>
      </header>

      {/* Mobile Segmented Tabs */}
      {isMobileViewport && (
        <div className="kanban-mobile-tabs" role="tablist">
          {COLUMNS.map((col) => {
            const count = (cardsByColumn.get(col.id) ?? []).length;
            const active = activeMobileColumn === col.id;
            return (
              <button
                key={col.id}
                role="tab"
                aria-selected={active}
                className={`kanban-mobile-tab ${active ? "is-active" : ""}`}
                onClick={() => setActiveMobileColumn(col.id)}
              >
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
                  cards={cardsByColumn.get(activeCol.id) ?? []}
                  isMobileViewport={true}
                  draggingNoteId={draggingCard?.noteId ?? null}
                  onOpenNote={onOpenNote}
                  onCreateNote={onCreateNoteInColumn}
                  onAddExistingNote={(status) => setAddModalStatus(status)}
                  onMoveToStatus={handleMoveToStatus}
                  onArchiveCard={onArchiveCard}
                  onRemoveCard={onRemoveCard}
                  onTrashCard={onTrashCard}
                  onCardDragStart={handleCardDragStart}
                  onCardDragEnd={handleCardDragEnd}
                  onDropOnColumn={handleDropOnColumn}
                />
              );
            })()}
          </div>
        ) : (
          COLUMNS.map((col) => (
            <KanbanColumnView
              key={col.id}
              column={col}
              cards={cardsByColumn.get(col.id) ?? []}
              isMobileViewport={false}
              draggingNoteId={draggingCard?.noteId ?? null}
              onOpenNote={onOpenNote}
              onCreateNote={onCreateNoteInColumn}
              onAddExistingNote={(status) => setAddModalStatus(status)}
              onMoveToStatus={handleMoveToStatus}
              onArchiveCard={onArchiveCard}
              onRemoveCard={onRemoveCard}
              onTrashCard={onTrashCard}
              onCardDragStart={handleCardDragStart}
              onCardDragEnd={handleCardDragEnd}
              onDropOnColumn={handleDropOnColumn}
            />
          ))
        )}
      </div>

      {/* Floating Bottom Drop Zones during drag */}
      {draggingCard !== null && (
        <div className="kanban-floating-drop-zones">
          <div
            className={`kanban-drop-zone kanban-drop-zone--trash ${trashOver ? "is-over" : ""}`}
            onDragOver={handleTrashDragOver}
            onDragLeave={() => setTrashOver(false)}
            onDrop={handleTrashDrop}
          >
            <Trash2 size={20} />
            <span>移动到回收站</span>
          </div>

          <div
            className={`kanban-drop-zone kanban-drop-zone--archive ${archiveOver ? "is-over" : ""}`}
            onDragOver={handleArchiveDragOver}
            onDragLeave={() => setArchiveOver(false)}
            onDrop={handleArchiveDrop}
          >
            <Archive size={20} />
            <span>归档</span>
          </div>
        </div>
      )}

      {/* Add Existing Note Dialog */}
      <AddExistingNoteModal
        open={addModalStatus !== null}
        targetStatus={addModalStatus ?? "inbox"}
        availableNotes={availableNotes}
        cards={cards}
        onClose={() => setAddModalStatus(null)}
        onSelect={onAddExistingNote}
      />

      {/* Archived Cards Drawer */}
      <KanbanArchivedDrawer
        open={archivedDrawerOpen}
        archivedCards={archivedCards}
        onClose={() => setArchivedDrawerOpen(false)}
        onUnarchive={onUnarchiveCard}
        onTrash={onTrashCard}
      />
    </section>
  );
});
