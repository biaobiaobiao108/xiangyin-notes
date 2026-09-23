import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  Archive,
  Check,
  ChevronDown,
  FolderInput,
  MoreHorizontal,
  Plus,
  Search,
  Star,
  Trash2,
  X,
} from "lucide-react";
import type { NoteSort, NoteSummary, NoteView, Notebook } from "../../shared/types";
import { FloatingScrollbar } from "../floating-scrollbar";
import { relativeDate, sortNotes, viewLabel } from "./helpers";

const SORT_OPTIONS: Array<{ value: NoteSort; label: string }> = [
  { value: "updated", label: "最后修改" },
  { value: "created", label: "创建时间" },
  { value: "title", label: "标题" },
];

export type NoteCardGridPanelProps = {
  notes: NoteSummary[];
  total: number;
  hasMore: boolean;
  sort: NoteSort;
  setSort: (sort: NoteSort) => void;
  selectedIds: ReadonlySet<string>;
  onOpenNote: (id: string) => void;
  onToggleSelectNote: (id: string, event: ReactMouseEvent) => void;
  onSelectAllNotes: () => void;
  onClearSelection: () => void;
  onDeleteSelected: () => void;
  view: NoteView;
  query: string;
  onQueryChange: (query: string) => void;
  onClearQuery: () => void;
  currentNotebookName?: string;
  notebooks: Notebook[];
  onMoveSelectedToNotebook: (notebookId: string) => void;
  onToggleFavoriteNote: (note: NoteSummary) => void;
  onMoveNoteToTrash: (note: NoteSummary) => void;
  onRestoreNote: (note: NoteSummary) => void;
  onPermanentDeleteNote: (note: NoteSummary) => void;
  onNewNote?: () => void;
  onEmptyTrash?: () => void;
  trashBusy?: boolean;
  onLoadMore?: () => void;
  isLoadingMore?: boolean;
};

export const NoteCardGridPanel = memo(function NoteCardGridPanel({
  notes,
  total,
  hasMore,
  sort,
  setSort,
  selectedIds,
  onOpenNote,
  onToggleSelectNote,
  onSelectAllNotes,
  onClearSelection,
  onDeleteSelected,
  view,
  query,
  onQueryChange,
  onClearQuery,
  currentNotebookName,
  notebooks,
  onMoveSelectedToNotebook,
  onToggleFavoriteNote,
  onMoveNoteToTrash,
  onRestoreNote,
  onPermanentDeleteNote,
  onNewNote,
  onEmptyTrash,
  trashBusy = false,
  onLoadMore,
  isLoadingMore = false,
}: NoteCardGridPanelProps) {
  const [sortOpen, setSortOpen] = useState(false);
  const [batchMoveOpen, setBatchMoveOpen] = useState(false);
  const sortRef = useRef<HTMLDivElement>(null);
  const sortTriggerRef = useRef<HTMLButtonElement>(null);
  const sortOptionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const batchMoveRef = useRef<HTMLDivElement>(null);
  const gridScrollRef = useRef<HTMLDivElement>(null);

  // Close sort menu on outside click or escape
  useEffect(() => {
    if (!sortOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !sortRef.current?.contains(event.target)) {
        setSortOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setSortOpen(false);
        sortTriggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [sortOpen]);

  // Close batch move menu on outside click
  useEffect(() => {
    if (!batchMoveOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !batchMoveRef.current?.contains(event.target)) {
        setBatchMoveOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [batchMoveOpen]);

  const sortedNotes = useMemo(() => sortNotes(notes, sort), [notes, sort]);
  const heading = query ? "搜索结果" : currentNotebookName ?? viewLabel(view);
  const isTrashView = view === "trash";

  return (
    <section className="note-card-grid-panel" aria-label="笔记卡片网格">
      {/* 顶栏操作区 */}
      <header className="card-grid-header">
        <div className="card-grid-header-main">
          <div className="card-grid-title-group">
            <h2>{heading}</h2>
            <span className="card-grid-count-badge" aria-label={`共 ${total} 篇笔记`}>
              {total}
            </span>
          </div>
          {query && (
            <span className="card-grid-search-hint">包含“{query}”的笔记</span>
          )}
        </div>

        <div className="card-grid-header-tools">
          {/* 内嵌搜索框 */}
          <div className="card-grid-search-wrap">
            <Search className="card-grid-search-icon" size={15} aria-hidden="true" />
            <input
              type="search"
              className="card-grid-search-input"
              placeholder="快速搜索笔记…"
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              aria-label="快速搜索笔记"
            />
            {query && (
              <button
                type="button"
                className="card-grid-search-clear"
                onClick={onClearQuery}
                aria-label="清空搜索"
              >
                <X size={14} />
              </button>
            )}
          </div>

          {/* 排序菜单 */}
          <div className="sort-menu-wrap" ref={sortRef}>
            <button
              ref={sortTriggerRef}
              id="card-grid-sort-trigger"
              className="sort-button"
              type="button"
              aria-haspopup="listbox"
              aria-expanded={sortOpen}
              onClick={() => setSortOpen((open) => !open)}
            >
              <span>{SORT_OPTIONS.find((option) => option.value === sort)?.label}</span>
              <ChevronDown size={14} />
            </button>
            {sortOpen && (
              <div className="sort-dropdown" role="listbox" aria-label="笔记排序方式">
                {SORT_OPTIONS.map((option, index) => {
                  const isSelected = sort === option.value;
                  return (
                    <button
                      ref={(el) => { sortOptionRefs.current[index] = el; }}
                      key={option.value}
                      type="button"
                      className={`sort-option ${isSelected ? "is-active" : ""}`}
                      role="option"
                      aria-selected={isSelected}
                      onClick={() => {
                        setSort(option.value);
                        setSortOpen(false);
                      }}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* 清空回收站按钮 */}
          {onEmptyTrash && isTrashView && (
            <button
              className="text-button text-danger empty-trash-button"
              type="button"
              onClick={onEmptyTrash}
              disabled={trashBusy || total === 0}
            >
              <Trash2 size={15} aria-hidden="true" />
              清空回收站
            </button>
          )}

          {/* 新建笔记按钮 */}
          {onNewNote && !isTrashView && (
            <button
              className="primary-button card-grid-new-note-btn"
              type="button"
              onClick={onNewNote}
              aria-label="新建笔记"
            >
              <Plus size={16} strokeWidth={2.2} />
              <span>新建笔记</span>
            </button>
          )}
        </div>
      </header>

      {/* 批量操作浮动工具栏 */}
      {selectedIds.size > 0 && (
        <aside className="card-grid-batch-bar" role="toolbar" aria-label="批量操作">
          <div className="card-grid-batch-info">
            <span className="card-grid-batch-count">已选 {selectedIds.size} 篇</span>
            <button
              type="button"
              className="text-button card-grid-batch-select-all"
              onClick={onSelectAllNotes}
            >
              全选 ({sortedNotes.length})
            </button>
          </div>

          <div className="card-grid-batch-actions">
            {!isTrashView && notebooks.length > 0 && (
              <div className="batch-move-dropdown-wrap" ref={batchMoveRef}>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setBatchMoveOpen((open) => !open)}
                  aria-expanded={batchMoveOpen}
                >
                  <FolderInput size={15} />
                  <span>移至笔记本</span>
                  <ChevronDown size={14} />
                </button>
                {batchMoveOpen && (
                  <div className="batch-move-dropdown" role="menu">
                    {notebooks.map((nb) => (
                      <button
                        key={nb.id}
                        type="button"
                        className="batch-move-option"
                        role="menuitem"
                        onClick={() => {
                          onMoveSelectedToNotebook(nb.id);
                          setBatchMoveOpen(false);
                        }}
                      >
                        <span
                          className="notebook-color-dot"
                          style={{ backgroundColor: nb.color }}
                          aria-hidden="true"
                        />
                        <span>{nb.name}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            <button
              type="button"
              className="secondary-button text-danger"
              onClick={onDeleteSelected}
              disabled={trashBusy}
            >
              <Trash2 size={15} />
              <span>{isTrashView ? "永久删除" : "移入回收站"}</span>
            </button>

            <button
              type="button"
              className="icon-button card-grid-batch-close"
              onClick={onClearSelection}
              aria-label="取消选择"
              title="取消选择"
            >
              <X size={16} />
            </button>
          </div>
        </aside>
      )}

      {/* 卡片滚动网格区域 */}
      <div className="card-grid-scroll-shell">
        <div
          id="card-grid-scroll-region"
          ref={gridScrollRef}
          className="card-grid-container floating-scrollbar-target"
          tabIndex={0}
        >
          {sortedNotes.length > 0 ? (
            <div className="card-grid" role="list">
              {sortedNotes.map((note) => (
                <NoteCardItem
                  key={note.id}
                  note={note}
                  isSelected={selectedIds.has(note.id)}
                  hasSelectionActive={selectedIds.size > 0}
                  onOpen={() => onOpenNote(note.id)}
                  onToggleSelect={(e) => onToggleSelectNote(note.id, e)}
                  onToggleFavorite={() => onToggleFavoriteNote(note)}
                  onMoveToTrash={() => onMoveNoteToTrash(note)}
                  onRestore={() => onRestoreNote(note)}
                  onPermanentDelete={() => onPermanentDeleteNote(note)}
                  notebooks={notebooks}
                  onMoveToNotebook={(targetId) => onMoveSelectedToNotebook(targetId)}
                  isTrashView={isTrashView}
                />
              ))}
            </div>
          ) : (
            <div className="card-grid-empty">
              <span className="empty-icon">
                {query ? <Search size={28} /> : <Archive size={28} />}
              </span>
              <strong>{query ? "没有找到匹配的笔记" : isTrashView ? "回收站是空的" : "这里还没有笔记"}</strong>
              <span>
                {query
                  ? "试试更短的关键词，或清空搜索查看全部内容。"
                  : isTrashView
                  ? "移入回收站的笔记会显示在这里。"
                  : "点击右上角“新建笔记”，让一个想法有地方落脚。"}
              </span>
              {query && (
                <button className="secondary-button" type="button" onClick={onClearQuery}>
                  清空搜索
                </button>
              )}
            </div>
          )}

          {hasMore && onLoadMore && (
            <div className="card-grid-load-more">
              <button
                type="button"
                className="secondary-button"
                onClick={onLoadMore}
                disabled={isLoadingMore}
              >
                {isLoadingMore ? "正在加载……" : `加载更多（已显示 ${notes.length} / ${total}）`}
              </button>
            </div>
          )}
        </div>

        <FloatingScrollbar
          scrollTargetRef={gridScrollRef}
          controlsId="card-grid-scroll-region"
          ariaLabel="笔记卡片网格滚动条"
          placement="right"
        />
      </div>
    </section>
  );
});

// 单张卡片组件
type NoteCardItemProps = {
  note: NoteSummary;
  isSelected: boolean;
  hasSelectionActive: boolean;
  onOpen: () => void;
  onToggleSelect: (event: ReactMouseEvent) => void;
  onToggleFavorite: () => void;
  onMoveToTrash: () => void;
  onRestore: () => void;
  onPermanentDelete: () => void;
  notebooks: Notebook[];
  onMoveToNotebook: (notebookId: string) => void;
  isTrashView: boolean;
};

const NoteCardItem = memo(function NoteCardItem({
  note,
  isSelected,
  hasSelectionActive,
  onOpen,
  onToggleSelect,
  onToggleFavorite,
  onMoveToTrash,
  onRestore,
  onPermanentDelete,
  notebooks,
  onMoveToNotebook,
  isTrashView,
}: NoteCardItemProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close card menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [menuOpen]);

  const handleCardClick = (event: ReactMouseEvent) => {
    if (event.metaKey || event.ctrlKey || hasSelectionActive) {
      event.preventDefault();
      onToggleSelect(event);
      return;
    }
    onOpen();
  };

  const handleStarClick = (event: ReactMouseEvent) => {
    event.stopPropagation();
    onToggleFavorite();
  };

  const handleCheckboxClick = (event: ReactMouseEvent) => {
    event.stopPropagation();
    onToggleSelect(event);
  };

  const handleMenuClick = (event: ReactMouseEvent) => {
    event.stopPropagation();
    setMenuOpen((open) => !open);
  };

  const displayTitle = note.title.trim() || "未命名笔记";
  const hasThumbnail = Boolean(note.thumbnail?.id);
  const displayNotebook = notebooks.find((nb) => nb.id === note.notebookId);

  return (
    <article
      className={`note-card ${isSelected ? "is-selected" : ""} ${hasThumbnail ? "has-thumbnail" : ""}`}
      onClick={handleCardClick}
      role="listitem"
      tabIndex={0}
      onKeyDown={(event: ReactKeyboardEvent) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      {/* 勾选框（悬浮或多选激活时明显展示） */}
      <button
        type="button"
        className={`note-card-checkbox ${isSelected ? "is-checked" : ""}`}
        onClick={handleCheckboxClick}
        aria-label={isSelected ? `取消选择笔记 ${displayTitle}` : `选择笔记 ${displayTitle}`}
      >
        {isSelected && <Check size={12} strokeWidth={3} />}
      </button>

      {/* 缩略图封面或纯文本摘录 */}
      {hasThumbnail ? (
        <div className="note-card-cover">
          <img
            src={`/api/assets/${encodeURIComponent(note.thumbnail!.id)}`}
            alt=""
            loading="lazy"
            className="note-card-cover-image"
          />
        </div>
      ) : (
        <div className="note-card-preview-area">
          <p className="note-card-preview-text">
            {note.preview ? note.preview.slice(0, 160) : "无正文摘录"}
          </p>
        </div>
      )}

      {/* 卡片主体内容 */}
      <div className="note-card-body">
        <div className="note-card-header">
          <h3 className="note-card-title" title={displayTitle}>
            {displayTitle}
          </h3>
          {!isTrashView && (
            <button
              type="button"
              className={`note-card-star-btn ${note.isFavorite ? "is-favorite" : ""}`}
              onClick={handleStarClick}
              aria-label={note.isFavorite ? "取消收藏" : "加入收藏"}
              aria-pressed={note.isFavorite}
            >
              <Star size={15} fill={note.isFavorite ? "currentColor" : "none"} />
            </button>
          )}
        </div>

        {/* 若有缩略图，在正文下方展示一小段文字摘要 */}
        {hasThumbnail && note.preview && (
          <p className="note-card-sub-preview">{note.preview.slice(0, 70)}</p>
        )}

        {/* 卡片底部元信息栏 */}
        <div className="note-card-footer">
          <span className="note-card-date">{relativeDate(note.updatedAt)}</span>

          {displayNotebook && (
            <span className="note-card-notebook-badge">
              <span
                className="notebook-color-dot"
                style={{ backgroundColor: displayNotebook.color }}
                aria-hidden="true"
              />
              <span className="notebook-badge-name">{displayNotebook.name}</span>
            </span>
          )}

          {/* 快捷菜单 */}
          <div className="note-card-menu-wrap" ref={menuRef}>
            <button
              type="button"
              className="note-card-menu-trigger"
              onClick={handleMenuClick}
              aria-label="更多操作"
              aria-expanded={menuOpen}
            >
              <MoreHorizontal size={15} />
            </button>

            {menuOpen && (
              <div className="note-card-dropdown" role="menu">
                {!isTrashView ? (
                  <>
                    <button
                      type="button"
                      className="note-card-dropdown-item"
                      role="menuitem"
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenuOpen(false);
                        onToggleFavorite();
                      }}
                    >
                      <Star size={14} fill={note.isFavorite ? "currentColor" : "none"} />
                      <span>{note.isFavorite ? "取消收藏" : "收藏笔记"}</span>
                    </button>
                    <button
                      type="button"
                      className="note-card-dropdown-item text-danger"
                      role="menuitem"
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenuOpen(false);
                        onMoveToTrash();
                      }}
                    >
                      <Trash2 size={14} />
                      <span>移入回收站</span>
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="note-card-dropdown-item"
                      role="menuitem"
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenuOpen(false);
                        onRestore();
                      }}
                    >
                      <Archive size={14} />
                      <span>恢复笔记</span>
                    </button>
                    <button
                      type="button"
                      className="note-card-dropdown-item text-danger"
                      role="menuitem"
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenuOpen(false);
                        onPermanentDelete();
                      }}
                    >
                      <Trash2 size={14} />
                      <span>彻底删除</span>
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </article>
  );
});
