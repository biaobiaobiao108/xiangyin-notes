import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  Archive,
  MoreHorizontal,
  Search,
  Star,
  Trash2,
} from "lucide-react";
import type { NoteSort, NoteSummary, NoteView, Notebook } from "../../shared/types";
import { FloatingScrollbar } from "../floating-scrollbar";
import { relativeDate, sortNotes } from "./helpers";

export type NoteCardGridPanelProps = {
  notes: NoteSummary[];
  total: number;
  hasMore: boolean;
  sort: NoteSort;
  selectedIds: ReadonlySet<string>;
  onOpenNote: (id: string) => void;
  onToggleSelectNote: (id: string, event: ReactMouseEvent) => void;
  view: NoteView;
  query: string;
  onClearQuery: () => void;
  notebooks: Notebook[];
  onToggleFavoriteNote: (note: NoteSummary) => void;
  onMoveNoteToTrash: (note: NoteSummary) => void;
  onRestoreNote: (note: NoteSummary) => void;
  onPermanentDeleteNote: (note: NoteSummary) => void;
  onLoadMore?: () => void;
  isLoadingMore?: boolean;
};

export const NoteCardGridPanel = memo(function NoteCardGridPanel({
  notes,
  total,
  hasMore,
  sort,
  selectedIds,
  onOpenNote,
  onToggleSelectNote,
  view,
  query,
  onClearQuery,
  notebooks,
  onToggleFavoriteNote,
  onMoveNoteToTrash,
  onRestoreNote,
  onPermanentDeleteNote,
  onLoadMore,
  isLoadingMore = false,
}: NoteCardGridPanelProps) {
  const gridScrollRef = useRef<HTMLDivElement>(null);
  const sortedNotes = useMemo(() => sortNotes(notes, sort), [notes, sort]);
  const isTrashView = view === "trash";

  return (
    <section className="note-card-grid-panel" aria-label="笔记卡片网格">
      {/* 沉浸式瀑布流滚动区域（无多余顶栏） */}
      <div className="card-grid-scroll-shell">
        <div
          id="card-grid-scroll-region"
          ref={gridScrollRef}
          className="card-grid-container floating-scrollbar-target"
          tabIndex={0}
        >
          {sortedNotes.length > 0 ? (
            <div className="card-masonry" role="list">
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
                  isTrashView={isTrashView}
                />
              ))}
            </div>
          ) : (
            <div className="card-grid-empty">
              <span className="empty-icon">
                {query ? <Search size={28} /> : <Archive size={28} />}
              </span>
              <strong>
                {query ? "没有找到匹配的笔记" : isTrashView ? "回收站是空的" : "这里还没有笔记"}
              </strong>
              <span>
                {query
                  ? "试试更短的关键词，或清空搜索查看全部内容。"
                  : isTrashView
                  ? "移入回收站的笔记会显示在这里。"
                  : "从侧栏新建笔记，让一个想法有地方落脚。"}
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

// 单张便笺卡片组件
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
  isTrashView,
}: NoteCardItemProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

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
      {/* 缩略图封面（若有） */}
      {hasThumbnail && (
        <div className="note-card-cover">
          <img
            src={`/api/assets/${encodeURIComponent(note.thumbnail!.id)}`}
            alt=""
            loading="lazy"
            className="note-card-cover-image"
          />
        </div>
      )}

      {/* 卡片主体：统一纯白底色便笺排版 */}
      <div className="note-card-body">
        {/* 顶部标题与收藏星标 */}
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

        {/* 正文摘要：自上而下流畅展示，更高高度 */}
        {note.preview ? (
          <p className="note-card-preview-text">
            {note.preview}
          </p>
        ) : (
          <p className="note-card-preview-empty">无正文内容</p>
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

          {/* 快捷操作菜单 */}
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
