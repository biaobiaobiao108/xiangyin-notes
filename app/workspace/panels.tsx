import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";
import {
  Archive,
  ChevronDown,
  ChevronLeft,
  LayoutPanelLeft,
  ListTodo,
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
  type NoteGroup,
  navItems,
  relativeDate,
  sortNotes,
  viewLabel,
} from "./helpers";
import { NOTE_DRAG_MIME_TYPE, setNoteDragImage, hasNoteDragType } from "./note-drag-drop";
import { NoteTags } from "./note-tags";
import {
  flattenNoteGroups,
  noteGroupRowId,
  useVirtualNoteList,
  type VirtualNoteListRow,
} from "./use-virtual-note-list";
import { useGroupCollapseAnchor } from "./use-group-collapse-anchor";
import { partitionVirtualGroupRows } from "./group-layout";
import { useScrollEdges } from "./use-scroll-edges";
import { MobileCollectionHeader } from "./mobile-collection-header";
import { type NoteSwipeAction, useSwipeActionGesture, useSwipeActionGroup } from "./swipe-actions";

function toggleGroupInSet(current: ReadonlySet<string>, groupId: string) {
  const next = new Set(current);
  if (current.has(groupId)) next.delete(groupId);
  else next.add(groupId);
  return next;
}

type VirtualGroupTransition = {
  groupId: string;
  phase: "preparing-collapse" | "preparing-expansion" | "collapsing" | "expanding";
};

function groupMotionDuration() {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue("--motion-group")
    .trim();
  const duration = Number.parseFloat(value);
  if (!Number.isFinite(duration)) return 0;
  if (value.endsWith("ms")) return duration;
  if (value.endsWith("s")) return duration * 1000;
  return duration;
}

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
      if (!onDropNotes || !hasNoteDragType(event.dataTransfer)) return;
      event.preventDefault();
      counterRef.current += 1;
      if (counterRef.current === 1) setIsOver(true);
    },
    [onDropNotes],
  );

  const handleDragOver = useCallback(
    (event: ReactDragEvent) => {
      if (!onDropNotes || !hasNoteDragType(event.dataTransfer)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    },
    [onDropNotes],
  );

  const handleDragLeave = useCallback(
    (event: ReactDragEvent) => {
      if (!onDropNotes || !hasNoteDragType(event.dataTransfer)) return;
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
      const data =
        event.dataTransfer.getData(NOTE_DRAG_MIME_TYPE) || event.dataTransfer.getData("text/plain");
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
  tasksActive,
  onOpenTasks,
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
  tasksActive: boolean;
  onOpenTasks: () => void;
}) {
  const notebookListRef = useRef<HTMLDivElement>(null);
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
            const isActive = !tasksActive && view === item.id && !notebookId;
            const dropHandler =
              item.id === "inbox" && systemInbox && onMoveNotesToNotebook
                ? (ids: string[]) => onMoveNotesToNotebook(ids, systemInbox.id)
                : item.id === "trash" && onTrashNotes
                  ? onTrashNotes
                  : undefined;
            return (
              <Fragment key={item.id}>
                {item.id === "trash" && (
                  <li>
                    <button
                      className={"nav-item" + (tasksActive ? " is-active" : "")}
                      type="button"
                      data-note-view="tasks"
                      aria-current={tasksActive ? "page" : undefined}
                      onClick={onOpenTasks}
                    >
                      <ListTodo size={18} />
                      <span>任务</span>
                    </button>
                  </li>
                )}
                <SidebarNavItem
                  item={item}
                  isActive={isActive}
                  onSelect={() => setView(item.id)}
                  onDropNotes={dropHandler}
                />
              </Fragment>
            );
          })}
        </ul>
      </nav>
      <div className="collapsed-notebook-shell">
        <div
          id="collapsed-notebook-scroll-region"
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
      <img
        src={thumbnail.url}
        alt=""
        width={76}
        height={76}
        loading="lazy"
        decoding="async"
        draggable={false}
      />
    </span>
  );
}

function NoteRowMeta({ note, showNotebook }: { note: NoteSummary; showNotebook: boolean }) {
  return (
    <span className="note-row-meta">
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
  isDragging,
  groupMotion,
  onDragStart,
  onDragEnd,
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
  isDragging: boolean;
  groupMotion?: "collapsing" | "expanding";
  onDragStart: (note: NoteSummary, event: ReactDragEvent<HTMLButtonElement>) => void;
  onDragEnd: () => void;
}) {
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

  return (
    <li
      ref={rowRef}
      data-note-id={note.id}
      className={`note-list-item ${isDragging ? "is-dragging" : ""}${groupMotion ? ` is-group-${groupMotion}` : ""}`.trim()}
      style={rowStyle}
      inert={groupMotion === "collapsing" || undefined}
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
          onDragStart={(event) => onDragStart(note, event)}
          onDragEnd={onDragEnd}
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
            <NoteTags tags={getNoteTags(note)} variant="row" />
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
  const { anchorGroupCollapse, isAnchoring } = useGroupCollapseAnchor(noteListRef);
  const [loadMoreSentinel, setLoadMoreSentinel] = useState<HTMLElement | null>(null);
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

  const [draggingNoteIds, setDraggingNoteIds] = useState<ReadonlySet<string> | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const [virtualGroupTransition, setVirtualGroupTransition] =
    useState<VirtualGroupTransition | null>(null);
  const dragFrameRef = useRef<number | null>(null);
  const virtualGroupTransitionTimerRef = useRef<number | null>(null);
  const queuedVirtualGroupIdRef = useRef<string | null>(null);
  const focusRestoreRef = useRef<{ noteId: string; selector: string } | null>(null);
  const transitionDataRef = useRef<{ rowIds: string } | null>(null);

  const handleRowDragStart = useCallback(
    (note: NoteSummary, event: ReactDragEvent<HTMLButtonElement>) => {
      if (isMobileViewport) return;
      const inSelection = selectedIds.has(note.id);
      const ids =
        selectedIds.size > 1
          ? inSelection
            ? Array.from(selectedIds)
            : Array.from(new Set([...selectedIds, note.id]))
          : selectedIds.size === 1 && !inSelection
            ? [selectedIds.values().next().value!, note.id]
            : [note.id];

      const serialized = JSON.stringify(ids);
      event.dataTransfer.setData(NOTE_DRAG_MIME_TYPE, serialized);
      event.dataTransfer.setData("text/plain", serialized);
      event.dataTransfer.effectAllowed = "move";
      setNoteDragImage(event.dataTransfer, event.currentTarget, ids.length);

      // 延迟到下一动画帧设置 is-dragging，避免在 dragstart 事件同微任务内重渲染 DOM 打断 Chromium 的拖拽初始化
      dragFrameRef.current = requestAnimationFrame(() => {
        dragFrameRef.current = null;
        setDraggingNoteIds(new Set(ids));
      });
    },
    [isMobileViewport, selectedIds],
  );

  const handleRowDragEnd = useCallback(() => {
    if (dragFrameRef.current !== null) cancelAnimationFrame(dragFrameRef.current);
    dragFrameRef.current = null;
    setDraggingNoteIds(null);
  }, []);

  const sortedNotes = useMemo(() => sortNotes(notes, "updated"), [notes]);
  const groups = useMemo(() => {
    if (query.trim()) return null;
    return groupNotes(sortedNotes, "updated");
  }, [query, sortedNotes]);
  const collapsingGroupId =
    virtualGroupTransition?.phase === "collapsing" &&
    collapsedGroups.has(virtualGroupTransition.groupId)
      ? virtualGroupTransition.groupId
      : null;
  const virtualRows = useMemo<VirtualNoteListRow[]>(() => {
    if (groups) return flattenNoteGroups(groups, collapsedGroups, collapsingGroupId);
    return sortedNotes.map((note) => ({ id: note.id, kind: "note" as const, note }));
  }, [collapsedGroups, collapsingGroupId, groups, sortedNotes]);
  const currentRowIds = (groups ?? [])
    .flatMap((group) => [noteGroupRowId(group.id), ...group.notes.map((note) => note.id)])
    .join("\u0000");
  const transitionDataChanged = Boolean(
    virtualGroupTransition &&
    transitionDataRef.current &&
    transitionDataRef.current.rowIds !== currentRowIds,
  );
  const sortedIndexById = useMemo(
    () => new Map(sortedNotes.map((note, index) => [note.id, index])),
    [sortedNotes],
  );
  const groupByNoteId = useMemo(() => {
    const byNoteId = new Map<string, NoteGroup>();
    for (const group of groups ?? []) {
      for (const note of group.notes) byNoteId.set(note.id, group);
    }
    return byNoteId;
  }, [groups]);
  // 收起的笔记仍保留测量值，展开时避免先按估算高度排版再跳到实际高度。
  const retainedRowIds = useMemo(
    () =>
      new Set([
        ...sortedNotes.map((note) => note.id),
        ...(groups ?? []).map((group) => noteGroupRowId(group.id)),
      ]),
    [groups, sortedNotes],
  );
  const virtualList = useVirtualNoteList(
    virtualRows,
    retainedRowIds,
    noteListRef,
    noteListElement,
    virtualizationScope,
    sortedNotes.length,
    virtualGroupTransition?.groupId ?? null,
    virtualGroupTransition?.phase === "collapsing",
  );
  const noteListScrollEdges = useScrollEdges(noteListRef, [
    noteListElement,
    sortedNotes.length,
    virtualList.totalHeight,
  ]);

  const currentStickyGroup = useMemo(() => {
    if (!groups || groups.length === 0) return null;
    const topRow = virtualList.topVisibleRow;
    if (!topRow) return groups[0];
    return topRow.kind === "group" ? topRow.group : groupByNoteId.get(topRow.note.id) || groups[0];
  }, [groupByNoteId, groups, virtualList.topVisibleRow]);
  const virtualStickyGroup = currentStickyGroup ?? groups?.[0] ?? null;
  const virtualStickyTransition =
    virtualGroupTransition && virtualStickyGroup?.id === virtualGroupTransition.groupId
      ? virtualGroupTransition.phase
      : null;
  const virtualStickyGroupCollapsed =
    virtualStickyTransition === "collapsing" || virtualStickyTransition === "preparing-expansion"
      ? true
      : virtualStickyTransition === "expanding" || virtualStickyTransition === "preparing-collapse"
        ? false
        : virtualStickyGroup
          ? collapsedGroups.has(virtualStickyGroup.id)
          : false;
  const canAutoLoadMore =
    !groups ||
    groups.some((group) => {
      return (
        !collapsedGroups.has(group.id) &&
        !(
          virtualGroupTransition?.groupId === group.id &&
          virtualGroupTransition.phase === "collapsing"
        )
      );
    });

  useEffect(() => {
    const sentinel = loadMoreSentinel;
    const container = noteListRef.current;
    if (
      !sentinel ||
      !container ||
      !hasMore ||
      !onLoadMore ||
      isLoadingMore ||
      !canAutoLoadMore ||
      virtualGroupTransition !== null ||
      typeof IntersectionObserver === "undefined"
    )
      return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) onLoadMore();
      },
      { root: container, rootMargin: "240px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [
    canAutoLoadMore,
    loadMoreSentinel,
    hasMore,
    isLoadingMore,
    onLoadMore,
    sortedNotes.length,
    virtualGroupTransition?.groupId,
    virtualGroupTransition?.phase,
  ]);

  const toggleGroup = (groupId: string, button: HTMLButtonElement) => {
    anchorGroupCollapse();
    const scroll = noteListRef.current;
    const section = button.closest<HTMLElement>(".note-list-group");
    const content = section?.querySelector<HTMLElement>(".note-list-group-content");
    if (
      !collapsedGroups.has(groupId) &&
      scroll &&
      section &&
      content &&
      button.getBoundingClientRect().top <= scroll.getBoundingClientRect().top + 1
    ) {
      anchorGroupCollapse(
        Math.max(
          0,
          scroll.scrollTop +
            section.getBoundingClientRect().top -
            scroll.getBoundingClientRect().top,
        ),
        content.getBoundingClientRect().height,
        `#${CSS.escape(content.id)}`,
      );
    }
    setCollapsedGroups((current) => toggleGroupInSet(current, groupId));
  };

  const toggleVirtualGroup = (group: NoteGroup) => {
    if (virtualGroupTransition && virtualGroupTransition.groupId !== group.id) {
      queuedVirtualGroupIdRef.current = group.id;
      return;
    }
    queuedVirtualGroupIdRef.current = null;
    anchorGroupCollapse();
    if (!collapsedGroups.has(group.id) && group.id === virtualStickyGroup?.id) {
      const index = virtualRows.findIndex((row) => row.id === noteGroupRowId(group.id));
      const end = virtualRows.findIndex((row, i) => i > index && row.kind === "group");
      const contentTop = virtualList.rowTop(index + 1);
      anchorGroupCollapse(
        index === 0 ? 0 : contentTop,
        virtualList.rowTop(end < 0 ? virtualRows.length : end) - contentTop,
        ".virtual-group-motion-clip",
      );
    }
    const duration = groupMotionDuration();
    const clearTimer = () => {
      if (virtualGroupTransitionTimerRef.current !== null)
        window.clearTimeout(virtualGroupTransitionTimerRef.current);
      virtualGroupTransitionTimerRef.current = null;
    };
    const setCollapsed = (collapsed: boolean) => {
      setCollapsedGroups((current) => {
        const next = new Set(current);
        if (collapsed) next.add(group.id);
        else next.delete(group.id);
        return next;
      });
    };
    const rememberTransitionData = () => {
      transitionDataRef.current = { rowIds: currentRowIds };
    };
    const startTransition = (phase: VirtualGroupTransition["phase"], collapsed: boolean) => {
      clearTimer();
      if (duration <= 0) {
        setCollapsed(collapsed);
        setVirtualGroupTransition(null);
        return;
      }
      setVirtualGroupTransition({ groupId: group.id, phase });
      setCollapsed(collapsed);
    };

    if (virtualGroupTransition?.groupId === group.id) {
      if (virtualGroupTransition.phase === "preparing-collapse") {
        clearTimer();
        transitionDataRef.current = null;
        setVirtualGroupTransition(null);
        return;
      }
      if (virtualGroupTransition.phase === "preparing-expansion") {
        clearTimer();
        setCollapsed(true);
        transitionDataRef.current = null;
        setVirtualGroupTransition(null);
        return;
      }
      if (virtualGroupTransition.phase === "collapsing") {
        startTransition("expanding", false);
        return;
      }
      if (virtualGroupTransition.phase === "expanding") {
        startTransition("collapsing", true);
        return;
      }
    }

    if (collapsedGroups.has(group.id)) {
      rememberTransitionData();
      startTransition("preparing-expansion", false);
      return;
    }

    if (duration <= 0) {
      setCollapsed(true);
      setVirtualGroupTransition(null);
      return;
    }
    rememberTransitionData();
    startTransition("preparing-collapse", false);
  };

  useLayoutEffect(() => {
    const transition = virtualGroupTransition;
    if (
      !transition ||
      (transition.phase !== "preparing-collapse" && transition.phase !== "preparing-expansion")
    )
      return;
    noteListRef.current?.querySelector<HTMLElement>(".virtual-group-motion-clip")?.offsetHeight;
    const frame = requestAnimationFrame(() => {
      if (transition.phase === "preparing-collapse") {
        setCollapsedGroups((current) => new Set(current).add(transition.groupId));
        setVirtualGroupTransition({ groupId: transition.groupId, phase: "collapsing" });
      } else {
        setVirtualGroupTransition({ groupId: transition.groupId, phase: "expanding" });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [virtualGroupTransition]);

  useLayoutEffect(() => {
    if (
      !virtualGroupTransition ||
      (virtualGroupTransition.phase !== "collapsing" &&
        virtualGroupTransition.phase !== "expanding")
    )
      return;
    const clip = noteListRef.current?.querySelector<HTMLElement>(".virtual-group-motion-clip");
    const finish = () => {
      if (virtualGroupTransitionTimerRef.current !== null)
        window.clearTimeout(virtualGroupTransitionTimerRef.current);
      virtualGroupTransitionTimerRef.current = null;
      transitionDataRef.current = null;
      setVirtualGroupTransition(null);
    };
    const onTransitionEnd = (event: TransitionEvent) => {
      if (event.target === clip && event.propertyName === "height") finish();
    };
    clip?.addEventListener("transitionend", onTransitionEnd);
    // 快速反向点击也重新安排收尾；无高度差时浏览器不会发 transitionend。
    virtualGroupTransitionTimerRef.current = window.setTimeout(finish, groupMotionDuration() + 50);
    return () => {
      clip?.removeEventListener("transitionend", onTransitionEnd);
      if (virtualGroupTransitionTimerRef.current !== null)
        window.clearTimeout(virtualGroupTransitionTimerRef.current);
      virtualGroupTransitionTimerRef.current = null;
    };
  }, [virtualGroupTransition]);

  useLayoutEffect(() => {
    if (!transitionDataChanged || !virtualGroupTransition) return;
    if (virtualGroupTransitionTimerRef.current !== null)
      window.clearTimeout(virtualGroupTransitionTimerRef.current);
    virtualGroupTransitionTimerRef.current = null;
    transitionDataRef.current = null;
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (
        virtualGroupTransition.phase === "collapsing" ||
        virtualGroupTransition.phase === "preparing-collapse"
      )
        next.add(virtualGroupTransition.groupId);
      else next.delete(virtualGroupTransition.groupId);
      return next;
    });
    setVirtualGroupTransition(null);
  }, [transitionDataChanged, virtualGroupTransition]);

  useEffect(() => {
    if (virtualGroupTransition) return;
    const queuedGroupId = queuedVirtualGroupIdRef.current;
    if (!queuedGroupId) return;
    queuedVirtualGroupIdRef.current = null;
    const queuedGroup = groups?.find((group) => group.id === queuedGroupId);
    if (!queuedGroup) return;
    const frame = requestAnimationFrame(() => toggleVirtualGroup(queuedGroup));
    return () => cancelAnimationFrame(frame);
  }, [groups, virtualGroupTransition]);

  useLayoutEffect(() => {
    if (virtualGroupTransition) return;
    const focus = focusRestoreRef.current;
    if (!focus || document.activeElement !== document.body) return;
    const selector = `[data-note-id="${CSS.escape(focus.noteId)}"] ${focus.selector}`;
    let target = noteListRef.current?.querySelector<HTMLElement>(selector);
    if (!target || target.closest("[inert]")) {
      const groupId = groupByNoteId.get(focus.noteId)?.id;
      const markerId = groupId ? noteGroupRowId(groupId) : null;
      target = markerId
        ? (noteListRef.current?.querySelector<HTMLElement>(
            `[data-note-id="${CSS.escape(markerId)}"] .note-list-virtual-group-toggle`,
          ) ?? null)
        : null;
    }
    if (!target || target.closest("[inert]"))
      target =
        noteListRef.current?.querySelector<HTMLElement>(
          ".note-list-group-header.is-virtual-sticky button",
        ) ?? null;
    target?.focus({ preventScroll: true });
    focusRestoreRef.current = null;
  }, [groupByNoteId, virtualGroupTransition]);

  useEffect(
    () => () => {
      if (virtualGroupTransitionTimerRef.current !== null)
        window.clearTimeout(virtualGroupTransitionTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (virtualGroupTransition) return;
    const focus = focusRestoreRef.current;
    if (!focus || document.activeElement !== document.body) return;
    const noteRow = noteListRef.current?.querySelector<HTMLElement>(
      `[data-note-id="${CSS.escape(focus.noteId)}"] ${focus.selector}`,
    );
    if (noteRow && !noteRow.closest("[inert]")) {
      noteRow.focus({ preventScroll: true });
      focusRestoreRef.current = null;
    }
  }, [virtualGroupTransition, virtualList.visibleRows]);

  const keyboardNotes = useMemo(
    () =>
      groups
        ? groups.flatMap((group) =>
            collapsedGroups.has(group.id) ||
            (virtualGroupTransition?.groupId === group.id &&
              virtualGroupTransition.phase === "collapsing")
              ? []
              : group.notes,
          )
        : sortedNotes,
    [collapsedGroups, groups, sortedNotes, virtualGroupTransition],
  );

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
    if (
      target instanceof HTMLElement &&
      target.closest(".note-list-group-toggle, .note-list-virtual-group-toggle")
    )
      return;

    const isPlainKey = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;

    if (isPlainKey && (event.key === "j" || event.key === "J" || event.key === "ArrowDown")) {
      event.preventDefault();
      const currentIndex = keyboardNotes.findIndex((n) => n.id === selectedId);
      const nextIndex =
        currentIndex >= 0 && currentIndex < keyboardNotes.length - 1 ? currentIndex + 1 : 0;
      const nextNote = keyboardNotes[nextIndex];
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
      const currentIndex = keyboardNotes.findIndex((n) => n.id === selectedId);
      const prevIndex = currentIndex > 0 ? currentIndex - 1 : keyboardNotes.length - 1;
      const prevNote = keyboardNotes[prevIndex];
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
  const activeMotionGroup = transitionDataChanged ? null : virtualList.transitionGroup;
  const motionCollapsed =
    virtualGroupTransition?.phase === "collapsing" ||
    virtualGroupTransition?.phase === "preparing-expansion";
  const listStyle: CSSProperties | undefined = virtualList.isVirtualized
    ? {
        position: "relative",
        height: `${virtualList.totalHeight - (motionCollapsed ? (activeMotionGroup?.height ?? 0) : 0) + (hasLoadMoreRow ? 76 : 0)}px`,
      }
    : undefined;
  const noteListStyle: CSSProperties = { overflowAnchor: "none" };
  const motionGroupHeader = activeMotionGroup
    ? virtualList.visibleRows.find(({ index }) => index === activeMotionGroup.start)
    : undefined;
  const motionContentTop = activeMotionGroup ? virtualList.rowTop(activeMotionGroup.start + 1) : 0;
  const motionAfterTop = activeMotionGroup ? virtualList.rowTop(activeMotionGroup.end) : 0;
  const motionRows = activeMotionGroup
    ? partitionVirtualGroupRows(
        virtualList.visibleRows,
        activeMotionGroup.start,
        activeMotionGroup.end,
        motionContentTop,
        motionAfterTop,
      )
    : null;
  const renderVirtualNote = (note: NoteSummary, rowIndex: number, top: number) => (
    <NoteListRow
      key={note.id}
      note={note}
      rowIndex={sortedIndexById.get(note.id) ?? rowIndex}
      setSize={listSize}
      rowRef={virtualList.getRowRef(note.id)}
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
      isDragging={draggingNoteIds?.has(note.id) ?? false}
      onDragStart={handleRowDragStart}
      onDragEnd={handleRowDragEnd}
    />
  );
  const renderVirtualGroupMarker = (
    row: Extract<VirtualNoteListRow, { kind: "group" }>,
    top: number,
  ) => {
    const isStickyMarker = virtualStickyGroup?.id === row.group.id;
    const isFocusedMarker = virtualList.pinnedRowId === row.id;
    const hideMarker = isStickyMarker && !isFocusedMarker;
    const markerTransition =
      virtualGroupTransition?.groupId === row.group.id ? virtualGroupTransition.phase : null;
    const markerCollapsed =
      markerTransition === "collapsing" || markerTransition === "preparing-expansion"
        ? true
        : markerTransition === "expanding" || markerTransition === "preparing-collapse"
          ? false
          : collapsedGroups.has(row.group.id);
    return (
      <li
        key={row.id}
        ref={virtualList.getRowRef(row.id)}
        data-note-id={row.id}
        className={`note-list-virtual-group-marker${row.firstGroup ? " is-first" : ""}${markerCollapsed ? " is-collapsed" : ""}${hideMarker ? " is-sticky-marker" : ""}`}
        role="presentation"
        aria-hidden={hideMarker || undefined}
        inert={hideMarker || undefined}
        style={virtualList.rowStyle(top)}
      >
        <button
          type="button"
          className="note-list-virtual-group-toggle"
          aria-expanded={!markerCollapsed}
          aria-controls="note-list-virtual-rows"
          onClick={() => toggleVirtualGroup(row.group)}
        >
          <ChevronDown className="note-list-group-chevron" size={13} aria-hidden="true" />
          <span className="note-list-group-title">{row.group.title}</span>
          <span className="note-list-group-count">{row.group.count}</span>
        </button>
      </li>
    );
  };
  const handleVirtualListFocusCapture = (event: ReactFocusEvent<HTMLDivElement>) => {
    virtualList.onFocusCapture(event);
    const active = event.target;
    if (!(active instanceof HTMLElement)) {
      focusRestoreRef.current = null;
      return;
    }
    const row = active.closest<HTMLElement>("[data-note-id]");
    if (!row?.dataset.noteId || row.dataset.noteId.startsWith("group-marker:")) {
      focusRestoreRef.current = null;
      return;
    }
    const button = active.closest<HTMLButtonElement>("button");
    if (!button) {
      focusRestoreRef.current = null;
      return;
    }
    const selector = button.classList.contains("note-row")
      ? ".note-row"
      : button.classList.contains("note-row-star-btn")
        ? ".note-row-star-btn"
        : button.classList.contains("swipe-action-button")
          ? `.swipe-action-button:nth-of-type(${Array.from(button.parentElement?.children ?? []).indexOf(button) + 1})`
          : null;
    focusRestoreRef.current = selector ? { noteId: row.dataset.noteId, selector } : null;
  };
  const handleVirtualListBlurCapture = (event: ReactFocusEvent<HTMLDivElement>) => {
    if (!virtualGroupTransition) virtualList.onBlurCapture(event);
  };
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
              className={`note-list-scroll-shell${noteListScrollEdges.before || isAnchoring ? " has-scroll-before" : ""}${noteListScrollEdges.after ? " has-scroll-after" : ""}`}
            >
              <div
                id="note-list-scroll-region"
                className="note-list floating-scrollbar-target"
                ref={setNoteListRef}
                style={noteListStyle}
                onKeyDown={handleNoteListKeyDown}
                onFocusCapture={handleVirtualListFocusCapture}
                onBlurCapture={handleVirtualListBlurCapture}
              >
                {virtualList.isVirtualized && virtualStickyGroup && (
                  <div
                    className="note-list-group-header is-virtual-sticky"
                    style={{ transform: `translateY(${virtualList.stickyOffset}px)` }}
                  >
                    <button
                      type="button"
                      className="note-list-virtual-group-toggle"
                      aria-expanded={!virtualStickyGroupCollapsed}
                      aria-controls="note-list-virtual-rows"
                      onClick={() => toggleVirtualGroup(virtualStickyGroup)}
                    >
                      <ChevronDown
                        className="note-list-group-chevron"
                        size={13}
                        aria-hidden="true"
                      />
                      <span className="note-list-group-title">{virtualStickyGroup.title}</span>
                      <span className="note-list-group-count">{virtualStickyGroup.count}</span>
                    </button>
                  </div>
                )}
                {!virtualList.isVirtualized && groups ? (
                  <div className="note-list-groups">
                    {groups.map((group) => {
                      const collapsed = collapsedGroups.has(group.id);
                      const contentId = `note-list-group-${group.id}`;
                      return (
                        <section
                          key={group.id}
                          className="note-list-group"
                          aria-label={`${group.title}，共 ${group.count} 篇`}
                        >
                          <h2 className="note-list-group-header">
                            <button
                              type="button"
                              className="note-list-group-toggle"
                              aria-expanded={!collapsed}
                              aria-controls={contentId}
                              onClick={(event) => toggleGroup(group.id, event.currentTarget)}
                            >
                              <ChevronDown
                                className="note-list-group-chevron"
                                size={13}
                                aria-hidden="true"
                              />
                              <span className="note-list-group-title">{group.title}</span>
                              <span className="note-list-group-count">{group.count}</span>
                            </button>
                          </h2>
                          <div
                            id={contentId}
                            className={`note-list-group-content${collapsed ? " is-collapsed" : ""}`}
                            inert={collapsed}
                          >
                            <ul className="note-list-group-items note-list-items" role="list">
                              {group.notes.map((note) => {
                                const index = sortedIndexById.get(note.id) ?? -1;
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
                                    isDragging={draggingNoteIds?.has(note.id) ?? false}
                                    onDragStart={handleRowDragStart}
                                    onDragEnd={handleRowDragEnd}
                                  />
                                );
                              })}
                            </ul>
                          </div>
                        </section>
                      );
                    })}
                    {hasLoadMoreRow && (
                      <div ref={setLoadMoreSentinel} className="note-list-load-more-item">
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
                  <ul
                    id={virtualList.isVirtualized ? "note-list-virtual-rows" : undefined}
                    className={`note-list-items${activeMotionGroup ? " virtual-group-list-motion" : ""}`}
                    role="list"
                    style={listStyle}
                  >
                    {activeMotionGroup && motionRows && motionGroupHeader?.row.kind === "group" ? (
                      <>
                        {motionRows.before.map(({ row, index, top }) =>
                          row.kind === "group"
                            ? renderVirtualGroupMarker(row, top)
                            : renderVirtualNote(row.note, index, top),
                        )}
                        {renderVirtualGroupMarker(motionGroupHeader.row, motionGroupHeader.top)}
                        <li
                          key={`virtual-group-motion-${virtualGroupTransition?.groupId}`}
                          className="virtual-group-motion note-list-virtual-group-motion"
                          role="presentation"
                          style={virtualList.rowStyle(motionContentTop)}
                        >
                          <div
                            className={`virtual-group-motion-clip note-list-virtual-group-clip${virtualGroupTransition?.phase === "collapsing" || virtualGroupTransition?.phase === "preparing-expansion" ? " is-collapsed" : ""}`}
                            style={
                              {
                                "--group-content-height": `${activeMotionGroup.height}px`,
                              } as CSSProperties
                            }
                            inert={virtualGroupTransition?.phase === "collapsing" || undefined}
                          >
                            <div className="virtual-group-motion-clip-content">
                              <ul
                                className="note-list-items note-list-virtual-group-content"
                                role="list"
                                style={{ height: `${activeMotionGroup.height}px` }}
                              >
                                {motionRows.group.map(({ row, index, localTop }) =>
                                  row.kind === "note"
                                    ? renderVirtualNote(row.note, index, localTop)
                                    : null,
                                )}
                              </ul>
                            </div>
                          </div>
                          <ul
                            className="note-list-items virtual-group-motion-after note-list-virtual-group-after"
                            role="list"
                            style={{
                              height: `${Math.max(0, virtualList.totalHeight - motionAfterTop + (hasLoadMoreRow ? 76 : 0))}px`,
                            }}
                          >
                            {motionRows.after.map(({ row, index, localTop }) =>
                              row.kind === "group"
                                ? renderVirtualGroupMarker(row, localTop)
                                : renderVirtualNote(row.note, index, localTop),
                            )}
                            {hasLoadMoreRow && (
                              <li
                                ref={setLoadMoreSentinel}
                                className="note-list-load-more-item"
                                style={{
                                  position: "absolute",
                                  insetInline: 0,
                                  top: 0,
                                  transform: `translateY(${virtualList.totalHeight - motionAfterTop}px)`,
                                }}
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
                        </li>
                      </>
                    ) : (
                      <>
                        {virtualList.visibleRows.map(({ row, index, top }) =>
                          row.kind === "group"
                            ? renderVirtualGroupMarker(row, top)
                            : renderVirtualNote(row.note, index, top),
                        )}
                        {hasLoadMoreRow && (
                          <li
                            ref={setLoadMoreSentinel}
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
                      </>
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
                placement="right"
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
