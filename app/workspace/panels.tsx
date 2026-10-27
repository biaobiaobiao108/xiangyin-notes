import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";
import {
  Archive,
  ChevronLeft,
  LayoutPanelLeft,
  LogOut,
  Menu,
  Plus,
  RotateCcw,
  Search,
  Star,
  Trash2,
  X,
} from "lucide-react";
import type { NoteSummary, NoteView, Notebook } from "../../shared/types";
import { playEntranceAnimation } from "../animation";
import { BrandMark } from "../brand-mark";
import { EmptyTrashButton } from "./empty-trash-button";
import type { OutlineItem } from "../editor-metrics";
import { FloatingScrollbar } from "../floating-scrollbar";
import { commandMenuShortcutLabel } from "../platform";
import { type PwaState } from "../pwa";
import {
  getNoteTags,
  getNotebookIconComponent,
  groupNotes,
  navItems,
  relativeDate,
  sortNotes,
  viewLabel,
} from "./helpers";
import { NOTE_DRAG_MIME_TYPE, createNoteDragGhost } from "./note-drag-drop";
import { NoteTags } from "./note-tags";
import { useVirtualNoteList } from "./use-virtual-note-list";
import { useScrollEdges } from "./use-scroll-edges";
import { MobileCollectionHeader } from "./mobile-collection-header";
import { type NoteSwipeAction, useSwipeActionGesture, useSwipeActionGroup } from "./swipe-actions";

export function NoteLoadingState() {
  return (
    <section className="editor-panel editor-loading-shell" aria-label="笔记编辑器" aria-busy="true">
      <div
        className="editor-switch-overlay editor-switch-overlay--visible"
        role="status"
        aria-live="polite"
      >
        <div className="editor-switch-card">
          <BrandMark className="editor-switch-mark" />
          <div className="editor-switch-lines" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <strong>正在打开笔记…</strong>
        </div>
      </div>
    </section>
  );
}

function useSidebarDropTarget(onDropNotes?: (ids: string[]) => void) {
  const [isOver, setIsOver] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const counterRef = useRef(0);

  const handleDragEnter = useCallback(
    (event: ReactDragEvent) => {
      if (!onDropNotes || !event.dataTransfer.types.includes(NOTE_DRAG_MIME_TYPE)) return;
      event.preventDefault();
      counterRef.current += 1;
      if (counterRef.current === 1) setIsOver(true);
    },
    [onDropNotes],
  );

  const handleDragOver = useCallback(
    (event: ReactDragEvent) => {
      if (!onDropNotes || !event.dataTransfer.types.includes(NOTE_DRAG_MIME_TYPE)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    },
    [onDropNotes],
  );

  const handleDragLeave = useCallback(
    (event: ReactDragEvent) => {
      if (!onDropNotes || !event.dataTransfer.types.includes(NOTE_DRAG_MIME_TYPE)) return;
      counterRef.current = Math.max(0, counterRef.current - 1);
      if (counterRef.current === 0) setIsOver(false);
    },
    [onDropNotes],
  );

  const handleDrop = useCallback(
    (event: ReactDragEvent) => {
      if (!onDropNotes) return;
      counterRef.current = 0;
      setIsOver(false);
      const data = event.dataTransfer.getData(NOTE_DRAG_MIME_TYPE);
      if (!data) return;
      event.preventDefault();
      event.stopPropagation();
      try {
        const noteIds = JSON.parse(data) as string[];
        if (Array.isArray(noteIds) && noteIds.length > 0) {
          setIsSuccess(true);
          setTimeout(() => setIsSuccess(false), 360);
          onDropNotes(noteIds);
        }
      } catch {}
    },
    [onDropNotes],
  );

  return {
    className: `${isOver ? "is-drop-target" : ""} ${isSuccess ? "is-drop-success" : ""}`.trim(),
    onDragEnter: handleDragEnter,
    onDragOver: handleDragOver,
    onDragLeave: handleDragLeave,
    onDrop: handleDrop,
  };
}

const SidebarNavItem = memo(function SidebarNavItem({
  item,
  isActive,
  onSelect,
  onDropNotes,
}: {
  item: (typeof navItems)[number];
  isActive: boolean;
  onSelect: () => void;
  onDropNotes?: (ids: string[]) => void;
}) {
  const Icon = item.icon;
  const drop = useSidebarDropTarget(onDropNotes);
  return (
    <li>
      <button
        className={`nav-item ${isActive ? "is-active" : ""} ${drop.className}`.trim()}
        type="button"
        data-note-view={item.id}
        onClick={onSelect}
        onDragEnter={drop.onDragEnter}
        onDragOver={drop.onDragOver}
        onDragLeave={drop.onDragLeave}
        onDrop={drop.onDrop}
      >
        <Icon size={18} />
        <span>{item.label}</span>
      </button>
    </li>
  );
});

const SidebarNotebookRow = memo(function SidebarNotebookRow({
  notebook,
  isActive,
  onSelect,
  onDropNotes,
}: {
  notebook: Notebook;
  isActive: boolean;
  onSelect: () => void;
  onDropNotes?: (ids: string[]) => void;
}) {
  const NotebookIcon = getNotebookIconComponent(notebook.icon);
  const drop = useSidebarDropTarget(onDropNotes);
  return (
    <li className="notebook-row-item">
      <div className={`notebook-row-wrap ${isActive ? "is-active" : ""} ${drop.className}`.trim()}>
        <button
          className="notebook-item"
          type="button"
          aria-label={`${notebook.name}，${notebook.count} 篇笔记`}
          onClick={onSelect}
          data-notebook-id={notebook.id}
          onDragEnter={drop.onDragEnter}
          onDragOver={drop.onDragOver}
          onDragLeave={drop.onDragLeave}
          onDrop={drop.onDrop}
        >
          <NotebookIcon
            size={16}
            className="notebook-custom-icon"
            style={{ color: notebook.color, flexShrink: 0 }}
          />
          <span>{notebook.name}</span>
          <em>{notebook.count}</em>
        </button>
      </div>
    </li>
  );
});

const CollapsedNotebookButton = memo(function CollapsedNotebookButton({
  notebook,
  isActive,
  onSelect,
  onDropNotes,
}: {
  notebook: Notebook;
  isActive: boolean;
  onSelect: () => void;
  onDropNotes?: (ids: string[]) => void;
}) {
  const NotebookIcon = getNotebookIconComponent(notebook.icon);
  const drop = useSidebarDropTarget(onDropNotes);
  return (
    <button
      type="button"
      className={`nav-item collapsed-notebook-item ${isActive ? "is-active" : ""} ${drop.className}`.trim()}
      onClick={onSelect}
      data-notebook-id={notebook.id}
      aria-label={`${notebook.name}，${notebook.count} 篇笔记`}
      onDragEnter={drop.onDragEnter}
      onDragOver={drop.onDragOver}
      onDragLeave={drop.onDragLeave}
      onDrop={drop.onDrop}
    >
      <NotebookIcon size={18} style={{ color: notebook.color }} />
    </button>
  );
});

export const Sidebar = memo(function Sidebar({
  view,
  setView,
  notebooks,
  notebookId,
  setNotebookId,
  query,
  setQuery,
  searchRef,
  onNewInboxNote,
  onCreateNotebook,
  collapsed,
  onCollapse,
  onLogout,
  onMoveNotesToNotebook,
  onTrashNotes,
}: {
  view: NoteView;
  setView: (view: NoteView) => void;
  notebooks: Notebook[];
  notebookId?: string;
  setNotebookId: (id: string) => void;
  query: string;
  setQuery: (query: string) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  onNewInboxNote: () => void;
  onCreateNotebook: () => void;
  collapsed: boolean;
  onCollapse: () => void;
  onLogout: () => void;
  onMoveNotesToNotebook?: (ids: string[], notebookId: string) => void;
  onTrashNotes?: (ids: string[]) => void;
}) {
  const notebookListRef = useRef<HTMLDivElement>(null);
  const collapsedNotebookListRef = useRef<HTMLDivElement>(null);
  const systemInbox = useMemo(() => notebooks.find((notebook) => notebook.isSystem), [notebooks]);
  const customNotebooks = useMemo(
    () => notebooks.filter((notebook) => !notebook.isSystem),
    [notebooks],
  );
  const notebookScrollEdges = useScrollEdges(notebookListRef, [customNotebooks.length]);

  return (
    <aside className="sidebar" aria-label="主导航">
      <div className="brand-row">
        <BrandMark />
        <span className="brand-name">象映笔记</span>
        <button
          className="icon-button collapse-button"
          type="button"
          onClick={onCollapse}
          aria-label={collapsed ? "展开侧栏" : "收起侧栏"}
        >
          <LayoutPanelLeft size={18} />
        </button>
      </div>
      <button
        className="primary-button new-note-button"
        type="button"
        aria-label="在收件箱中新建笔记"
        onClick={onNewInboxNote}
      >
        <Plus size={18} />
        新建笔记
      </button>
      <label className="search-box">
        <Search size={17} />
        <input
          ref={searchRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="全局搜索笔记或 #标签……"
          aria-label="全局搜索笔记或标签"
        />
        {query ? (
          <button
            className="search-clear"
            type="button"
            aria-label="清空搜索"
            onClick={() => setQuery("")}
          >
            <X size={15} />
          </button>
        ) : null}
      </label>
      <nav className="main-nav">
        <ul>
          {navItems.map((item) => {
            const isActive = view === item.id && !notebookId;
            const dropHandler =
              item.id === "inbox" && systemInbox && onMoveNotesToNotebook
                ? (ids: string[]) => onMoveNotesToNotebook(ids, systemInbox.id)
                : item.id === "trash" && onTrashNotes
                  ? onTrashNotes
                  : undefined;
            return (
              <SidebarNavItem
                key={item.id}
                item={item}
                isActive={isActive}
                onSelect={() => setView(item.id)}
                onDropNotes={dropHandler}
              />
            );
          })}
        </ul>
      </nav>
      <div className="collapsed-notebook-shell">
        <div
          id="collapsed-notebook-scroll-region"
          ref={collapsedNotebookListRef}
          className="collapsed-notebook-list floating-scrollbar-target"
          role="toolbar"
          aria-label="笔记本快捷切换"
        >
          {customNotebooks.length > 0 && (
            <div className="collapsed-notebook-divider" aria-hidden="true" />
          )}
          {customNotebooks.map((notebook) => (
            <CollapsedNotebookButton
              key={notebook.id}
              notebook={notebook}
              isActive={notebook.id === notebookId}
              onSelect={() => setNotebookId(notebook.id)}
              onDropNotes={
                onMoveNotesToNotebook ? (ids) => onMoveNotesToNotebook(ids, notebook.id) : undefined
              }
            />
          ))}
        </div>
        <FloatingScrollbar
          scrollTargetRef={collapsedNotebookListRef}
          controlsId="collapsed-notebook-scroll-region"
          ariaLabel="笔记本快捷切换滚动条"
          placement="left"
        />
      </div>
      <div className="notebook-section">
        <div className="section-heading">
          <span>笔记本</span>
          <button
            className="icon-button tiny-button"
            type="button"
            aria-label="新建笔记本"
            onClick={onCreateNotebook}
          >
            <Plus size={16} />
          </button>
        </div>
        <div
          className={`notebook-list-scroll-shell${notebookScrollEdges.before ? " has-scroll-before" : ""}${notebookScrollEdges.after ? " has-scroll-after" : ""}`}
        >
          <div
            id="notebook-list-scroll-region"
            className="notebook-list-scroll floating-scrollbar-target"
            ref={notebookListRef}
          >
            <ul>
              {customNotebooks.map((notebook) => (
                <SidebarNotebookRow
                  key={notebook.id}
                  notebook={notebook}
                  isActive={notebook.id === notebookId}
                  onSelect={() => setNotebookId(notebook.id)}
                  onDropNotes={
                    onMoveNotesToNotebook
                      ? (ids) => onMoveNotesToNotebook(ids, notebook.id)
                      : undefined
                  }
                />
              ))}
            </ul>
          </div>
          <FloatingScrollbar
            scrollTargetRef={notebookListRef}
            controlsId="notebook-list-scroll-region"
            ariaLabel="笔记本列表滚动条"
            placement="left"
          />
        </div>
      </div>
      <div className="sidebar-bottom">
        <button className="nav-item" type="button" aria-label="退出登录" onClick={onLogout}>
          <LogOut size={18} />
          <span>退出登录</span>
        </button>
      </div>
    </aside>
  );
});

function NoteThumbnail({ note }: { note: NoteSummary }) {
  const thumbnail = note.thumbnail;
  if (!thumbnail?.url) return null;
  return (
    <span className="note-row-thumbnail" aria-hidden="true">
      <img src={thumbnail.url} alt="" width={76} height={76} loading="lazy" decoding="async" />
    </span>
  );
}

function NoteRowMeta({ note, showNotebook }: { note: NoteSummary; showNotebook: boolean }) {
  const tags = getNoteTags(note);
  return (
    <span className="note-row-meta">
      <NoteTags tags={tags} variant="row" />
      {showNotebook && note.notebookName && (
        <span className="note-row-notebook">{note.notebookName}</span>
      )}
      <time>{relativeDate(note.updatedAt)}</time>
    </span>
  );
}

const NoteListRow = memo(function NoteListRow({
  note,
  isSelected,
  selectedIds,
  isActive,
  showNotebook,
  onToggleFavorite,
  onSelect,
  rowRef,
  rowStyle,
  rowIndex,
  setSize,
  isMobileViewport,
  isTrashView,
  trashBusy,
  onNoteSwipeAction,
  open,
  setOpenId,
}: {
  note: NoteSummary;
  isSelected: boolean;
  selectedIds?: ReadonlySet<string>;
  isActive: boolean;
  showNotebook: boolean;
  onToggleFavorite: (note: NoteSummary) => void;
  onSelect: (id: string, event: ReactMouseEvent<HTMLButtonElement>) => void;
  rowRef?: (element: HTMLLIElement | null) => void;
  rowStyle?: CSSProperties;
  rowIndex: number;
  setSize: number;
  isMobileViewport: boolean;
  isTrashView: boolean;
  trashBusy: boolean;
  onNoteSwipeAction: (note: NoteSummary, action: NoteSwipeAction) => void;
  open: boolean;
  setOpenId: (id: string | null) => void;
}) {
  const [isDragging, setIsDragging] = useState(false);
  const actionWidth = isTrashView ? 144 : 96;
  const foregroundRef = useRef<HTMLButtonElement>(null);
  const gesture = useSwipeActionGesture({
    enabled: isMobileViewport && !trashBusy,
    itemId: note.id,
    open,
    actionWidth,
    onOpenChange: setOpenId,
    foregroundRef,
  });

  const handleDragStart = (event: ReactDragEvent<HTMLButtonElement>) => {
    if (isMobileViewport) return;
    const isMulti = isSelected && selectedIds && selectedIds.size > 1;
    const ids = isMulti && selectedIds ? Array.from(selectedIds) : [note.id];
    event.dataTransfer.setData(NOTE_DRAG_MIME_TYPE, JSON.stringify(ids));
    event.dataTransfer.effectAllowed = "move";
    const ghost = createNoteDragGhost(note.title, ids.length);
    event.dataTransfer.setDragImage(ghost, 28, 28);
    requestAnimationFrame(() => ghost.remove());
    setIsDragging(true);
  };

  const handleDragEnd = () => {
    setIsDragging(false);
  };

  return (
    <li
      ref={rowRef}
      data-note-id={note.id}
      className={`note-list-item ${isDragging ? "is-dragging" : ""}`.trim()}
      style={rowStyle}
      aria-posinset={rowIndex + 1}
      aria-setsize={setSize}
    >
      <div
        className={`swipe-action-row note-row-swipe${open ? " is-swipe-open" : ""}`}
        style={
          {
            "--swipe-action-width": `${actionWidth}px`,
            "--swipe-action-button-width": isTrashView ? "72px" : "96px",
          } as CSSProperties
        }
        {...gesture}
      >
        {isMobileViewport && (
          <div
            id={`note-actions-${note.id}`}
            className="swipe-action-buttons"
            role="group"
            aria-label={`${note.title || "未命名笔记"}的操作`}
            aria-hidden={!open}
            inert={!open}
          >
            {isTrashView ? (
              <>
                <button
                  type="button"
                  className="swipe-action-button"
                  tabIndex={open ? 0 : -1}
                  aria-label={`恢复笔记：${note.title || "未命名笔记"}`}
                  disabled={trashBusy}
                  onClick={() => {
                    setOpenId(null);
                    onNoteSwipeAction(note, "restore");
                  }}
                >
                  <span className="swipe-action-icon">
                    <RotateCcw size={17} aria-hidden="true" />
                  </span>
                </button>
                <button
                  type="button"
                  className="swipe-action-button is-danger"
                  tabIndex={open ? 0 : -1}
                  aria-label={`彻底删除笔记：${note.title || "未命名笔记"}`}
                  disabled={trashBusy}
                  onClick={() => {
                    setOpenId(null);
                    onNoteSwipeAction(note, "permanent-delete");
                  }}
                >
                  <span className="swipe-action-icon">
                    <Trash2 size={17} aria-hidden="true" />
                  </span>
                </button>
              </>
            ) : (
              <button
                type="button"
                className="swipe-action-button is-danger"
                tabIndex={open ? 0 : -1}
                aria-label={`移入回收站：${note.title || "未命名笔记"}`}
                disabled={trashBusy}
                onClick={() => {
                  setOpenId(null);
                  onNoteSwipeAction(note, "trash");
                }}
              >
                <span className="swipe-action-icon">
                  <Trash2 size={17} aria-hidden="true" />
                </span>
              </button>
            )}
          </div>
        )}
        <button
          ref={foregroundRef}
          type="button"
          draggable={!isMobileViewport}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          className={`note-row swipe-action-foreground ${note.thumbnail ? "has-thumbnail" : ""} ${!isTrashView ? "has-favorite-action" : ""} ${isSelected ? "is-selected" : ""} ${isActive ? "is-active" : ""}`}
          aria-current={isActive ? "page" : undefined}
          aria-pressed={isSelected}
          aria-expanded={isMobileViewport ? open : undefined}
          aria-controls={isMobileViewport ? `note-actions-${note.id}` : undefined}
          onClick={(event) => onSelect(note.id, event)}
        >
          <NoteThumbnail note={note} />
          <span className="note-row-main">
            <span className="note-row-title">
              <span className="note-row-title-text">{note.title || "未命名笔记"}</span>
            </span>
            <span className="note-row-preview">
              {note.preview || "还没有内容，开始写下第一句话。"}
            </span>
            <NoteRowMeta note={note} showNotebook={showNotebook} />
          </span>
        </button>
        {!isTrashView && (
          <button
            type="button"
            className={`note-row-star-btn ${note.isFavorite ? "is-favorite" : ""}`}
            aria-label={note.isFavorite ? "取消收藏" : "加入收藏"}
            aria-pressed={note.isFavorite}
            onClick={(event) => {
              event.stopPropagation();
              onToggleFavorite(note);
            }}
          >
            <Star size={15} fill={note.isFavorite ? "currentColor" : "none"} />
          </button>
        )}
      </div>
    </li>
  );
});

export function NoteOutlinePanel({
  outlineItems,
  activeOutlineId,
  onScrollToOutlineItem,
  onCloseOutline,
  isFloating = false,
}: {
  outlineItems: OutlineItem[];
  activeOutlineId: string | null;
  onScrollToOutlineItem: (id: string) => void;
  onCloseOutline: () => void;
  isFloating?: boolean;
}) {
  const outlineScrollRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const scrollRoot = outlineScrollRef.current;
    const shell = scrollRoot?.parentElement;
    if (!isFloating || !scrollRoot || !shell) return;
    const fitCompleteRows = () => {
      const list = scrollRoot.querySelector<HTMLOListElement>(".editor-outline-list");
      const row = list?.querySelector<HTMLButtonElement>("button");
      if (!list || !row) {
        scrollRoot.style.height = "100%";
        return;
      }
      const style = getComputedStyle(scrollRoot);
      const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      const gap = parseFloat(getComputedStyle(list).rowGap) || 0;
      const stride = row.offsetHeight + gap;
      if (stride <= 0) return;
      const rows = Math.max(1, Math.floor((shell.clientHeight - padding + gap) / stride));
      scrollRoot.style.height = `${Math.min(shell.clientHeight, rows * stride - gap + padding)}px`;
    };
    fitCompleteRows();
    const observer = new ResizeObserver(fitCompleteRows);
    observer.observe(shell);
    return () => {
      observer.disconnect();
      scrollRoot.style.removeProperty("height");
    };
  }, [isFloating, outlineItems]);
  useLayoutEffect(() => {
    const scrollRoot = outlineScrollRef.current;
    if (!scrollRoot) return;
    let frame: number | null = null;
    const updateScrollEdges = () => {
      frame = null;
      // Clamp Safari's elastic overscroll; tolerate fractional offsets at the edges.
      const maxScroll = Math.max(0, scrollRoot.scrollHeight - scrollRoot.clientHeight);
      const offset = Math.min(maxScroll, Math.max(0, scrollRoot.scrollTop));
      scrollRoot.toggleAttribute("data-scroll-above", offset > 1);
      scrollRoot.toggleAttribute("data-scroll-below", maxScroll - offset > 1);
    };
    const scheduleScrollEdges = () => {
      if (frame === null) frame = requestAnimationFrame(updateScrollEdges);
    };
    const observer = new ResizeObserver(scheduleScrollEdges);
    observer.observe(scrollRoot);
    const content = scrollRoot.firstElementChild;
    if (content) observer.observe(content);
    scrollRoot.addEventListener("scroll", scheduleScrollEdges, { passive: true });
    updateScrollEdges();
    return () => {
      observer.disconnect();
      scrollRoot.removeEventListener("scroll", scheduleScrollEdges);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [isFloating, outlineItems]);
  useEffect(() => {
    const scrollRoot = outlineScrollRef.current;
    if (!scrollRoot || !activeOutlineId) return;
    const activeButton = Array.from(
      scrollRoot.querySelectorAll<HTMLButtonElement>(".editor-outline-item button"),
    ).find((button) => button.dataset.outlineId === activeOutlineId);
    if (!activeButton) return;
    const scrollRect = scrollRoot.getBoundingClientRect();
    const buttonRect = activeButton.getBoundingClientRect();
    const edgePadding = isFloating ? 14 : 8;
    const visibleTop = scrollRect.top + edgePadding;
    const visibleBottom = scrollRect.bottom - edgePadding;
    let delta = 0;
    if (buttonRect.top < visibleTop) delta = buttonRect.top - visibleTop;
    else if (buttonRect.bottom > visibleBottom) delta = buttonRect.bottom - visibleBottom;
    if (delta === 0) return;
    const behavior: ScrollBehavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "auto"
      : "smooth";
    const maxScrollTop = Math.max(0, scrollRoot.scrollHeight - scrollRoot.clientHeight);
    scrollRoot.scrollTo({
      top: Math.min(maxScrollTop, Math.max(0, scrollRoot.scrollTop + delta)),
      behavior,
    });
  }, [activeOutlineId, outlineItems, isFloating]);

  return (
    <aside
      className={`note-outline-panel ${isFloating ? "is-floating" : ""}`}
      id="note-outline"
      aria-label={isFloating ? "笔记大纲" : undefined}
      aria-labelledby={isFloating ? undefined : "note-outline-title"}
    >
      {!isFloating && (
        <header className="list-header note-outline-header">
          <div className="list-header-main">
            <h2 id="note-outline-title">笔记大纲</h2>
            <p>{outlineItems.length > 0 ? `${outlineItems.length} 个标题` : "当前笔记暂无标题"}</p>
          </div>
          <div className="list-header-controls">
            <button
              className="text-button outline-back-button"
              type="button"
              onClick={onCloseOutline}
            >
              <ChevronLeft size={15} aria-hidden="true" />
              <span>返回笔记列表</span>
            </button>
          </div>
        </header>
      )}
      <div className="note-outline-scroll-shell">
        <div
          id="note-outline-scroll-region"
          className="note-outline-scroll floating-scrollbar-target"
          ref={outlineScrollRef}
        >
          {outlineItems.length > 0 ? (
            <nav aria-label="笔记标题">
              <ol className="editor-outline-list">
                {outlineItems.map((item) => (
                  <li
                    className={`editor-outline-item editor-outline-item--level-${item.level}`}
                    key={item.id}
                  >
                    <button
                      type="button"
                      data-outline-id={item.id}
                      aria-current={activeOutlineId === item.id ? "true" : undefined}
                      onClick={() => onScrollToOutlineItem(item.id)}
                    >
                      <span className="outline-item-title">{item.title}</span>
                    </button>
                  </li>
                ))}
              </ol>
            </nav>
          ) : (
            <p className="editor-outline-empty">
              用 <code>#</code> 标题为这篇笔记建立大纲。
            </p>
          )}
        </div>
        <FloatingScrollbar
          scrollTargetRef={outlineScrollRef}
          controlsId="note-outline-scroll-region"
          ariaLabel="笔记大纲滚动条"
          placement="right"
          enabled={!isFloating}
        />
      </div>
    </aside>
  );
}

type NoteListPanelProps = {
  notes: NoteSummary[];
  total: number;
  hasMore?: boolean;
  selectedId: string | null;
  selectedIds: ReadonlySet<string>;
  onSelect: (id: string, event: ReactMouseEvent<HTMLButtonElement>) => void;
  onToggleFavoriteNote: (note: NoteSummary) => void;
  onDeleteSelected: () => void;
  onNoteSwipeAction: (note: NoteSummary, action: NoteSwipeAction) => void;
  view: NoteView;
  query: string;
  currentNotebookName?: string;
  onNewNote?: () => void;
  onEmptyTrash?: () => void;
  trashBusy: boolean;
  onClearQuery: () => void;
  onOpenSidebar: () => void;
  onToggleLayout?: () => void;
  transitionToken: number;

  isMobileViewport?: boolean;
  outlineOpen: boolean;
  outlineItems: OutlineItem[];
  activeOutlineId: string | null;
  onScrollToOutlineItem: (id: string) => void;
  onCloseOutline: () => void;
  onLoadMore?: () => void;
  isLoadingMore?: boolean;
  virtualizationScope: string;
  onFocusEditor?: () => void;

  inert?: boolean;
};

export const NoteListPanel = memo(function NoteListPanel({
  notes,
  total,
  hasMore = total > notes.length,
  selectedId,
  selectedIds,
  onSelect,
  onToggleFavoriteNote,
  onDeleteSelected,
  onNoteSwipeAction,
  view,
  query,
  currentNotebookName,
  onNewNote,
  onEmptyTrash,
  trashBusy,
  onClearQuery,
  isMobileViewport = false,
  onOpenSidebar,
  onToggleLayout,
  transitionToken,
  outlineOpen,
  outlineItems,
  activeOutlineId,
  onScrollToOutlineItem,
  onCloseOutline,
  onLoadMore,
  isLoadingMore = false,
  virtualizationScope,
  onFocusEditor,
  inert = false,
}: NoteListPanelProps) {
  const noteListRef = useRef<HTMLDivElement>(null);
  const [noteListElement, setNoteListElement] = useState<HTMLDivElement | null>(null);
  const setNoteListRef = useCallback((element: HTMLDivElement | null) => {
    noteListRef.current = element;
    setNoteListElement((current) => (current === element ? current : element));
  }, []);
  const loadMoreSentinelRef = useRef<HTMLLIElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const swipeActions = useSwipeActionGroup(
    noteListRef,
    isMobileViewport && !inert,
    virtualizationScope,
  );

  useLayoutEffect(() => {
    if (transitionToken === 0 || !panelRef.current) return;
    const panel = panelRef.current;
    const content = panel.querySelector<HTMLElement>(".note-list-content");
    if (!content) return;
    const animation = playEntranceAnimation(content, "page-content-in");
    return () => animation?.cancel();
  }, [transitionToken]);

  useEffect(() => {
    const sentinel = loadMoreSentinelRef.current;
    const container = noteListRef.current;
    if (!sentinel || !container || !hasMore || !onLoadMore || isLoadingMore) return;
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
        rootMargin: "240px",
      },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, onLoadMore, isLoadingMore]);

  const sortedNotes = useMemo(() => sortNotes(notes, "updated"), [notes]);
  const virtualList = useVirtualNoteList(
    sortedNotes,
    noteListRef,
    noteListElement,
    virtualizationScope,
  );
  const noteListScrollEdges = useScrollEdges(noteListRef, [
    noteListElement,
    sortedNotes.length,
    virtualList.totalHeight,
  ]);

  const groups = useMemo(() => {
    if (query.trim()) return null;
    return groupNotes(sortedNotes, "updated");
  }, [query, sortedNotes]);

  const currentStickyGroup = useMemo(() => {
    if (!groups || groups.length === 0) return null;
    const topNote = virtualList.visibleRows[0]?.note;
    if (!topNote) return groups[0];
    return groups.find((g) => g.notes.some((n) => n.id === topNote.id)) || groups[0];
  }, [groups, virtualList.visibleRows]);

  const handleNoteListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    virtualList.moveTabFocus(event);
    if (event.defaultPrevented) return;
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.isContentEditable || target.matches("input, textarea, select"))
    )
      return;

    const isPlainKey = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;

    if (isPlainKey && (event.key === "j" || event.key === "J" || event.key === "ArrowDown")) {
      event.preventDefault();
      const currentIndex = sortedNotes.findIndex((n) => n.id === selectedId);
      const nextIndex =
        currentIndex >= 0 && currentIndex < sortedNotes.length - 1 ? currentIndex + 1 : 0;
      const nextNote = sortedNotes[nextIndex];
      if (nextNote) {
        onSelect(nextNote.id, event as unknown as ReactMouseEvent<HTMLButtonElement>);
        const row = noteListRef.current?.querySelector<HTMLButtonElement>(
          `[data-note-id="${CSS.escape(nextNote.id)}"] .note-row`,
        );
        row?.focus();
        row?.scrollIntoView({ block: "nearest" });
      }
      return;
    }

    if (isPlainKey && (event.key === "k" || event.key === "K" || event.key === "ArrowUp")) {
      event.preventDefault();
      const currentIndex = sortedNotes.findIndex((n) => n.id === selectedId);
      const prevIndex = currentIndex > 0 ? currentIndex - 1 : sortedNotes.length - 1;
      const prevNote = sortedNotes[prevIndex];
      if (prevNote) {
        onSelect(prevNote.id, event as unknown as ReactMouseEvent<HTMLButtonElement>);
        const row = noteListRef.current?.querySelector<HTMLButtonElement>(
          `[data-note-id="${CSS.escape(prevNote.id)}"] .note-row`,
        );
        row?.focus();
        row?.scrollIntoView({ block: "nearest" });
      }
      return;
    }

    if (isPlainKey && event.key === "Enter") {
      if (selectedId && onFocusEditor) {
        event.preventDefault();
        onFocusEditor();
        return;
      }
    }

    if (isPlainKey && (event.key === "s" || event.key === "S")) {
      const currentNote = sortedNotes.find((n) => n.id === selectedId);
      if (currentNote) {
        event.preventDefault();
        onToggleFavoriteNote(currentNote);
        return;
      }
    }

    if (
      (event.key === "Delete" || event.key === "Backspace") &&
      (selectedIds.size > 0 || selectedId)
    ) {
      event.preventDefault();
      onDeleteSelected();
      return;
    }
  };
  const heading = query ? "搜索结果" : (currentNotebookName ?? viewLabel(view));
  const truncated = hasMore;
  const hasLoadMoreRow = hasMore && Boolean(onLoadMore);
  const listSize = Math.max(total, sortedNotes.length);
  const listStyle: CSSProperties | undefined = virtualList.isVirtualized
    ? {
        position: "relative",
        height: `${virtualList.totalHeight + (hasLoadMoreRow ? 76 : 0)}px`,
      }
    : undefined;
  const noteListStyle: CSSProperties | undefined = virtualList.isVirtualized
    ? { overflowAnchor: "none" }
    : undefined;
  return (
    <section
      ref={panelRef}
      className={`note-list-panel ${outlineOpen ? "is-outline-open" : ""}`.trim()}
      aria-label={outlineOpen ? "笔记大纲" : "笔记列表"}
      aria-hidden={inert || undefined}
      inert={inert}
    >
      <div className="note-list-content">
        {outlineOpen ? (
          <NoteOutlinePanel
            outlineItems={outlineItems}
            activeOutlineId={activeOutlineId}
            onScrollToOutlineItem={onScrollToOutlineItem}
            onCloseOutline={onCloseOutline}
          />
        ) : (
          <>
            {isMobileViewport ? (
              <MobileCollectionHeader
                active={!inert}
                heading={heading}
                total={total}
                shown={notes.length}
                query={query}
                onBack={onOpenSidebar}
                layout="three-column"
                onToggleLayout={onToggleLayout}
                onEmptyTrash={onEmptyTrash}
                trashBusy={trashBusy}
              />
            ) : (
              <header className="list-header">
                <button
                  className="icon-button mobile-only"
                  type="button"
                  aria-label="打开导航"
                  onClick={onOpenSidebar}
                >
                  <Menu size={20} />
                </button>
                <div className="list-header-main">
                  <h2 tabIndex={-1}>{heading}</h2>
                  <p>
                    {query ? `包含“${query}”的笔记` : `${truncated ? total : notes.length} 篇笔记`}
                    {truncated && <> · 已显示最近 {notes.length} 篇</>}
                  </p>
                </div>
                <div className="list-header-controls">
                  {onEmptyTrash && (
                    <EmptyTrashButton onClick={onEmptyTrash} disabled={trashBusy || total === 0} />
                  )}
                  {onNewNote && !isMobileViewport && (
                    <button
                      className="icon-button list-new-note-button"
                      type="button"
                      aria-label={`在${currentNotebookName}中新建笔记`}
                      onClick={onNewNote}
                    >
                      <Plus size={18} />
                    </button>
                  )}
                </div>
              </header>
            )}
            <div
              className={`note-list-scroll-shell${noteListScrollEdges.before ? " has-scroll-before" : ""}${noteListScrollEdges.after ? " has-scroll-after" : ""}`}
            >
              <div
                id="note-list-scroll-region"
                className="note-list floating-scrollbar-target"
                ref={setNoteListRef}
                style={noteListStyle}
                onKeyDown={handleNoteListKeyDown}
                onFocusCapture={virtualList.onFocusCapture}
                onBlurCapture={virtualList.onBlurCapture}
              >
                {virtualList.isVirtualized && groups && groups.length > 0 && (
                  <div className="note-list-group-header is-virtual-sticky" aria-hidden="true">
                    <span className="note-list-group-title">
                      {currentStickyGroup?.title || groups[0]?.title}
                    </span>
                    <span className="note-list-group-count">
                      {currentStickyGroup?.count || groups[0]?.count}
                    </span>
                  </div>
                )}
                {!virtualList.isVirtualized && groups ? (
                  <div className="note-list-groups">
                    {groups.map((group) => (
                      <section
                        key={group.id}
                        className="note-list-group"
                        aria-label={`${group.title}，共 ${group.count} 篇`}
                      >
                        <div className="note-list-group-header">
                          <span className="note-list-group-title">{group.title}</span>
                          <span className="note-list-group-count">{group.count}</span>
                        </div>
                        <ul className="note-list-group-items note-list-items" role="list">
                          {group.notes.map((note) => {
                            const index = sortedNotes.findIndex((n) => n.id === note.id);
                            return (
                              <NoteListRow
                                key={note.id}
                                note={note}
                                rowIndex={index}
                                setSize={listSize}
                                isSelected={selectedIds.has(note.id)}
                                selectedIds={selectedIds}
                                isActive={selectedId === note.id && !isMobileViewport}
                                showNotebook
                                onToggleFavorite={onToggleFavoriteNote}
                                onSelect={onSelect}
                                isMobileViewport={isMobileViewport}
                                isTrashView={view === "trash"}
                                trashBusy={trashBusy}
                                onNoteSwipeAction={onNoteSwipeAction}
                                open={swipeActions.openId === note.id}
                                setOpenId={swipeActions.setOpenId}
                              />
                            );
                          })}
                        </ul>
                      </section>
                    ))}
                    {hasLoadMoreRow && (
                      <div className="note-list-load-more-item">
                        <button
                          className="secondary-button note-list-load-more-button"
                          type="button"
                          onClick={onLoadMore}
                          disabled={isLoadingMore}
                        >
                          {isLoadingMore
                            ? "正在加载……"
                            : `加载更多（已显示 ${notes.length} / ${total}）`}
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  <ul className="note-list-items" role="list" style={listStyle}>
                    {virtualList.visibleRows.map(({ note, index, top }) => (
                      <NoteListRow
                        key={note.id}
                        note={note}
                        rowIndex={index}
                        setSize={listSize}
                        rowRef={
                          virtualList.isVirtualized ? virtualList.getRowRef(note.id) : undefined
                        }
                        rowStyle={virtualList.rowStyle(top)}
                        isSelected={selectedIds.has(note.id)}
                        selectedIds={selectedIds}
                        isActive={selectedId === note.id && !isMobileViewport}
                        showNotebook
                        onToggleFavorite={onToggleFavoriteNote}
                        onSelect={onSelect}
                        isMobileViewport={isMobileViewport}
                        isTrashView={view === "trash"}
                        trashBusy={trashBusy}
                        onNoteSwipeAction={onNoteSwipeAction}
                        open={swipeActions.openId === note.id}
                        setOpenId={swipeActions.setOpenId}
                      />
                    ))}
                    {hasLoadMoreRow && (
                      <li
                        ref={loadMoreSentinelRef}
                        className="note-list-load-more-item"
                        style={
                          virtualList.isVirtualized
                            ? {
                                position: "absolute",
                                insetInline: 0,
                                top: 0,
                                transform: `translateY(${virtualList.totalHeight}px)`,
                              }
                            : undefined
                        }
                      >
                        <button
                          className="secondary-button note-list-load-more-button"
                          type="button"
                          onClick={onLoadMore}
                          disabled={isLoadingMore}
                        >
                          {isLoadingMore
                            ? "正在加载……"
                            : `加载更多（已显示 ${notes.length} / ${total}）`}
                        </button>
                      </li>
                    )}
                  </ul>
                )}
                {!sortedNotes.length &&
                  (query ? (
                    <div className="list-empty">
                      <span className="empty-icon">
                        <Search size={23} />
                      </span>
                      <strong>没有找到匹配的笔记</strong>
                      <span>试试更短的关键词，或清空搜索查看全部内容。</span>
                      <button className="secondary-button" type="button" onClick={onClearQuery}>
                        清空搜索
                      </button>
                    </div>
                  ) : (
                    <div className="list-empty">
                      <span className="empty-icon">
                        <Archive size={23} />
                      </span>
                      <strong>{view === "trash" ? "回收站是空的" : "这里还没有笔记"}</strong>
                      <span>
                        {view === "trash"
                          ? "移入回收站的笔记会显示在这里。"
                          : "按下“新建笔记”，让一个想法有地方落脚。"}
                      </span>
                    </div>
                  ))}
              </div>
              <FloatingScrollbar
                scrollTargetRef={noteListRef}
                controlsId="note-list-scroll-region"
                ariaLabel="笔记列表滚动条"
                placement="left"
              />
            </div>
          </>
        )}
      </div>
    </section>
  );
});

export function EmptyEditor({
  isTrash,
  onNewNote,
  onOpenList,
  transitionToken,
}: {
  isTrash: boolean;
  onNewNote: () => void;
  onOpenList: () => void;
  transitionToken: number;
}) {
  return (
    <section key={transitionToken} className="empty-editor">
      <button
        className="icon-button mobile-only empty-back"
        type="button"
        aria-label="打开笔记列表"
        onClick={onOpenList}
      >
        <ChevronLeft size={20} />
      </button>
      <BrandMark className="empty-editor-mark" />
      <h1 tabIndex={-1}>{isTrash ? "回收站是空的" : "让想法有地方落脚"}</h1>
      <p>{isTrash ? "没有需要清理或恢复的笔记。" : "创建一篇笔记，记录此刻值得留下的东西。"}</p>
      {!isTrash && (
        <>
          <button className="primary-button" type="button" onClick={onNewNote}>
            <Plus size={18} />
            新建笔记
          </button>
          <span className="empty-shortcut">或按 {commandMenuShortcutLabel} 打开命令菜单</span>
        </>
      )}
    </section>
  );
}
