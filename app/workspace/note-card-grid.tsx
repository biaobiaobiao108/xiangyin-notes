import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  Archive,
  Check,
  Menu,
  Search,
  Star,
  Trash2,
} from "lucide-react";
import type { NoteSort, NoteSummary, NoteView, Notebook } from "../../shared/types";
import { playEntranceAnimation } from "../animation";
import { FloatingScrollbar } from "../floating-scrollbar";
import { isNoteSelectionModifierClick, type NoteSelectionClick } from "./note-list-selection";
import { getNoteTags, NOTE_TAG_DISPLAY_LIMIT, relativeDate, sortNotes, viewLabel } from "./helpers";
import { MobileCollectionHeader } from "./mobile-collection-header";
import { useVirtualCardMasonry } from "./use-virtual-card-masonry";

export type NoteCardGridPanelProps = {
  notes: NoteSummary[];
  total: number;
  hasMore: boolean;
  sort: NoteSort;
  setSort: (sort: NoteSort) => void;
  isMobileViewport?: boolean;
  onToggleLayout?: () => void;
  selectedIds: ReadonlySet<string>;
  onOpenNote: (id: string) => void;
  onToggleSelectNote: (id: string, modifiers: Pick<NoteSelectionClick, "metaKey" | "ctrlKey" | "shiftKey">) => void;
  onDeleteSelected: () => void;
  view: NoteView;
  currentNotebookName?: string;
  query: string;
  onClearQuery: () => void;
  notebooks: Notebook[];
  onToggleFavoriteNote: (note: NoteSummary) => void;
  onEmptyTrash?: () => void;
  trashBusy?: boolean;
  transitionToken?: number;
  onOpenSidebar?: () => void;
  onLoadMore?: () => void;
  isLoadingMore?: boolean;
  scrollScope: string;
  initialScrollTop: number;
  onScrollPositionChange: (scope: string, scrollTop: number) => void;
  inert?: boolean;
};

export const NoteCardGridPanel = memo(function NoteCardGridPanel({
  notes,
  total,
  hasMore,
  sort,
  setSort,
  isMobileViewport = false,
  onToggleLayout,
  selectedIds,
  onOpenNote,
  onToggleSelectNote,
  onDeleteSelected,
  view,
  currentNotebookName,
  query,
  onClearQuery,
  notebooks,
  onToggleFavoriteNote,
  onEmptyTrash,
  trashBusy = false,
  transitionToken,
  onOpenSidebar,
  onLoadMore,
  isLoadingMore = false,
  scrollScope,
  initialScrollTop,
  onScrollPositionChange,
  inert = false,
}: NoteCardGridPanelProps) {
  const panelRef = useRef<HTMLElement>(null);
  const gridScrollRef = useRef<HTMLDivElement>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement>(null);
  const sortedNotes = useMemo(() => sortNotes(notes, sort), [notes, sort]);
  const notebooksById = useMemo(() => new Map(notebooks.map((notebook) => [notebook.id, notebook])), [notebooks]);
  const isTrashView = view === "trash";
  const showNotebook = !currentNotebookName && view !== "inbox";
  const masonry = useVirtualCardMasonry(sortedNotes, gridScrollRef, isMobileViewport);
  const renderCard = useCallback((note: NoteSummary, index: number) => (
    <NoteCardItem
      key={note.id}
      isMobileViewport={isMobileViewport}
      note={note}
      position={index + 1}
      setSize={Math.max(total, notes.length)}
      isSelected={selectedIds.has(note.id)}
      hasSelectionActive={selectedIds.size > 0}
      showNotebook={showNotebook}
      onOpen={onOpenNote}
      onToggleSelect={onToggleSelectNote}
      onToggleFavorite={onToggleFavoriteNote}
      notebook={notebooksById.get(note.notebookId)}
      isTrashView={isTrashView}
    />
  ), [isMobileViewport, isTrashView, notebooksById, notes.length, onOpenNote, onToggleFavoriteNote, onToggleSelectNote, selectedIds, showNotebook, total]);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;

    const targets = panel.querySelectorAll<HTMLElement>(".card-masonry, .card-grid-empty");
    const animations = [...targets]
      .map((target) => playEntranceAnimation(target, "page-content-in"))
      .filter((animation): animation is Animation => animation !== null);
    return () => animations.forEach((animation) => animation.cancel());
  }, [transitionToken]);

  useLayoutEffect(() => {
    if (gridScrollRef.current) gridScrollRef.current.scrollTop = initialScrollTop;
    masonry.refreshViewport();
  }, [initialScrollTop, masonry.refreshViewport, scrollScope]);

  const handleGridKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    const target = event.target;
    if (target instanceof HTMLElement && (target.isContentEditable || target.matches("input, textarea, select"))) return;
    if ((event.key === "Delete" || event.key === "Backspace") && selectedIds.size > 0) {
      event.preventDefault();
      onDeleteSelected();
    }
  };

  useEffect(() => {
    const sentinel = loadMoreSentinelRef.current;
    const container = gridScrollRef.current;
    if (inert || !sentinel || !container || !hasMore || !onLoadMore || isLoadingMore) return;
    if (typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting) {
          onLoadMore();
        }
      },
      {
        root: container,
        rootMargin: "280px",
      }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, inert, onLoadMore, isLoadingMore]);

  return (
    <section
      ref={panelRef}
      className={`note-card-grid-panel${isMobileViewport ? " is-mobile-card-grid" : ""}`}
      aria-label="笔记卡片网格"
      aria-hidden={inert || undefined}
      inert={inert}
    >
      {/* 沉浸式瀑布流滚动区域（无多余顶栏） */}
      <div className="card-grid-scroll-shell">
        {isMobileViewport && onOpenSidebar && <MobileCollectionHeader active={!inert} heading={query ? "搜索结果" : currentNotebookName ?? viewLabel(view)} total={total} shown={notes.length} query={query} sort={sort} onSort={setSort} onBack={onOpenSidebar} layout="cards" onToggleLayout={onToggleLayout} onEmptyTrash={onEmptyTrash} trashBusy={trashBusy} />}
        {!isMobileViewport && onOpenSidebar && (
          <button
            className="icon-button card-grid-mobile-menu mobile-only"
            type="button"
            aria-label="打开导航"
            onClick={onOpenSidebar}
          >
            <Menu size={20} />
          </button>
        )}
        {!isMobileViewport && onEmptyTrash && (
          <button
            className="icon-button empty-trash-button card-grid-empty-trash"
            type="button"
            aria-label="清空回收站"
            onClick={onEmptyTrash}
            disabled={trashBusy || total === 0}
          >
            <Trash2 size={18} aria-hidden="true" />
          </button>
        )}
        <div
          id="card-grid-scroll-region"
          ref={gridScrollRef}
          className={`card-grid-container floating-scrollbar-target ${onEmptyTrash ? "has-trash-action" : ""}`}
          tabIndex={0}
          onKeyDown={handleGridKeyDown}
          onKeyDownCapture={masonry.onKeyDownCapture}
          onFocusCapture={masonry.onFocusCapture}
          onBlurCapture={masonry.onBlurCapture}
          onScroll={(event) => onScrollPositionChange(scrollScope, event.currentTarget.scrollTop)}
        >
          {sortedNotes.length > 0 ? (
            <div className="card-masonry" role="list" style={{ height: masonry.totalHeight, width: masonry.config.width }}>
              {masonry.visibleCards.map((placement) => <div
                key={placement.note.id}
                ref={masonry.getCardRef(placement.note.id)}
                className="card-masonry-slot"
                data-card-masonry-note-id={placement.note.id}
                role="presentation"
                style={{ top: placement.top, insetInlineStart: placement.lane * (masonry.config.laneWidth + masonry.config.gap), width: masonry.config.laneWidth }}
              >{renderCard(placement.note, placement.index)}</div>)}
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
                  : isMobileViewport ? "点击下方新建笔记，让一个想法有地方落脚。" : "从侧栏新建笔记，让一个想法有地方落脚。"}
              </span>
              {query && (
                <button className="secondary-button" type="button" onClick={onClearQuery}>
                  清空搜索
                </button>
              )}
            </div>
          )}

          {hasMore && onLoadMore && (
            <div ref={loadMoreSentinelRef} className="card-grid-load-more">
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
  isMobileViewport: boolean;
  note: NoteSummary;
  position: number;
  setSize: number;
  isSelected: boolean;
  hasSelectionActive: boolean;
  showNotebook: boolean;
  onOpen: (id: string) => void;
  onToggleSelect: (id: string, modifiers: Pick<NoteSelectionClick, "metaKey" | "ctrlKey" | "shiftKey">) => void;
  onToggleFavorite: (note: NoteSummary) => void;
  notebook?: Notebook;
  isTrashView: boolean;
};

const NoteCardItem = memo(function NoteCardItem({
  isMobileViewport,
  note,
  position,
  setSize,
  isSelected,
  hasSelectionActive,
  showNotebook,
  onOpen,
  onToggleSelect,
  onToggleFavorite,
  notebook,
  isTrashView,
}: NoteCardItemProps) {
  const handleCardClick = (event: ReactMouseEvent) => {
    if (!isMobileViewport && (isNoteSelectionModifierClick(event) || hasSelectionActive)) {
      event.preventDefault();
      onToggleSelect(note.id, event);
      return;
    }
    onOpen(note.id);
  };

  const handleStarClick = (event: ReactMouseEvent) => {
    event.stopPropagation();
    onToggleFavorite(note);
  };

  const displayTitle = note.title.trim() || "未命名笔记";
  const hasThumbnail = Boolean(note.thumbnail?.id);
  const displayNotebook = notebook;
  const tags = getNoteTags(note);
  const visibleTags = tags.slice(0, NOTE_TAG_DISPLAY_LIMIT);

  return (
    <article
      data-note-id={note.id}
      className={`note-card ${isSelected ? "is-selected" : ""} ${hasThumbnail ? "has-thumbnail" : ""}`}
      onClick={handleCardClick}
      role="listitem"
      aria-posinset={position}
      aria-setsize={setSize}
      aria-label={isMobileViewport ? undefined : `${displayTitle}，${isSelected ? "已选择" : "未选择"}；空格键切换选择，回车打开笔记`}
      tabIndex={isMobileViewport ? undefined : 0}
      onKeyDown={(event: ReactKeyboardEvent) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === " ") {
          event.preventDefault();
          onToggleSelect(note.id, {
            metaKey: event.metaKey,
            ctrlKey: event.ctrlKey || (!event.shiftKey && !event.metaKey),
            shiftKey: event.shiftKey,
          });
        } else if (event.key === "Enter") {
          event.preventDefault();
          onOpen(note.id);
        }
      }}
    >
      <div className="note-card-foreground">
      {isMobileViewport && <button className="note-card-open" type="button" aria-label={`打开笔记：${displayTitle}`} />}
      {/* 缩略图封面（若有） */}
      {hasThumbnail && (
        <div className="note-card-cover">
          <img
            src={`/api/assets/${encodeURIComponent(note.thumbnail!.id)}`}
            alt=""
            loading="lazy"
            decoding="async"
            className="note-card-cover-image"
          />
        </div>
      )}

      {/* 卡片主体：统一纯白底色便笺排版 */}
      <div className="note-card-body">
        {/* 顶部标题与收藏星标 */}
        <div className="note-card-header">
          <h3 className="note-card-title">
            {displayTitle}
          </h3>
          {isSelected && <span className="note-selection-mark" aria-hidden="true"><Check size={11} strokeWidth={2.5} /></span>}
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

        {/* 卡片底部元信息栏：与列表视图保持统一 */}
        <div className="note-card-footer">
          <div className="note-card-footer-leading">
            {showNotebook && displayNotebook && (
              <span className="note-card-notebook-badge">
                <span
                  className="notebook-color-dot"
                  style={{ backgroundColor: displayNotebook.color }}
                  aria-hidden="true"
                />
                <span className="notebook-badge-name">{displayNotebook.name}</span>
              </span>
            )}
            {showNotebook && displayNotebook && visibleTags.length > 0 && (
              <span className="note-card-footer-divider" aria-hidden="true">·</span>
            )}
            {visibleTags.length > 0 && (
              <span className="note-card-tags" aria-label={`标签：${tags.map((tag) => `#${tag}`).join("、")}`}>
                {visibleTags.map((tag) => (
                  <span className="note-card-tag" key={tag}>#{tag}</span>
                ))}
                {tags.length > visibleTags.length && (
                  <span className="note-card-tag note-card-tag--overflow">+{tags.length - visibleTags.length}</span>
                )}
              </span>
            )}
          </div>

          <time className="note-card-date">{relativeDate(note.updatedAt)}</time>
        </div>
      </div>
      </div>
    </article>
  );
});
