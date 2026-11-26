import {
  Fragment,
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import {
  LayoutPanelLeft,
  ListTodo,
  LoaderCircle,
  NotebookPen,
  Plus,
  Search,
  SquareKanban,
  X,
} from "lucide-react";
import type { NoteView, Notebook } from "../../shared/types";
import { BrandMark } from "../brand-mark";
import { getNotebookIconComponent, navItems } from "./helpers";
import { hasNoteDragType, parseNoteIdsFromDrag } from "./note-drag-drop";
import { useNotebookReorder } from "./use-notebook-reorder";
import { useScrollEdges } from "./use-scroll-edges";

function useSidebarDropTarget(onDropNotes?: (ids: string[]) => Promise<void>) {
  const [isOver, setIsOver] = useState(false);
  const [pendingDrops, setPendingDrops] = useState(0);
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

  const handleDragLeave = useCallback(() => {
    if (counterRef.current === 0) return;
    counterRef.current -= 1;
    if (counterRef.current === 0) setIsOver(false);
  }, []);

  const handleDrop = useCallback(
    (event: ReactDragEvent) => {
      if (!onDropNotes || !hasNoteDragType(event.dataTransfer)) return;
      counterRef.current = 0;
      setIsOver(false);
      event.preventDefault();
      event.stopPropagation();
      const noteIds = parseNoteIdsFromDrag(event.dataTransfer);
      if (!noteIds.length) return;
      setPendingDrops((count) => count + 1);
      void onDropNotes(noteIds).finally(() => setPendingDrops((count) => count - 1));
    },
    [onDropNotes],
  );

  return {
    className: isOver || pendingDrops ? "is-drop-target" : "",
    busy: pendingDrops > 0,
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
  onDropNotes?: (ids: string[]) => Promise<void>;
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
        aria-busy={drop.busy || undefined}
        onDrop={drop.onDrop}
      >
        <Icon size={18} />
        <span>{item.label}</span>
      </button>
    </li>
  );
});

const SidebarNotebookRow = memo(function SidebarNotebookRow({
  sortHandle,
  notebook,
  isActive,
  onSelect,
  onDropNotes,
}: {
  sortHandle: ReturnType<ReturnType<typeof useNotebookReorder>>;
  notebook: Notebook;
  isActive: boolean;
  onSelect: () => void;
  onDropNotes?: (ids: string[]) => Promise<void>;
}) {
  const NotebookIcon = getNotebookIconComponent(notebook.icon);
  const drop = useSidebarDropTarget(onDropNotes);
  return (
    <li className="notebook-row-item" data-sort-id={notebook.id}>
      <div className={`notebook-row-wrap ${isActive ? "is-active" : ""} ${drop.className}`.trim()}>
        <button
          {...sortHandle}
          className="notebook-item"
          type="button"
          aria-label={`${notebook.name}，${notebook.count} 篇笔记`}
          onClick={onSelect}
          data-notebook-id={notebook.id}
          onDragEnter={drop.onDragEnter}
          onDragOver={drop.onDragOver}
          onDragLeave={drop.onDragLeave}
          aria-busy={drop.busy || undefined}
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
  onDropNotes?: (ids: string[]) => Promise<void>;
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
      aria-busy={drop.busy || undefined}
      onDrop={drop.onDrop}
    >
      <NotebookIcon size={18} style={{ color: notebook.color }} />
    </button>
  );
});

export const Sidebar = memo(function Sidebar({
  onReorderNotebooks,
  reorderingNotebooks,
  view,
  setView,
  notebooks,
  notebookId,
  setNotebookId,
  query,
  setQuery,
  onSubmitQuery,
  searchRef,
  onNewInboxNote,
  creatingNote = false,
  onCreateNotebook,
  collapsed,
  onCollapse,
  onMoveNotesToNotebook,
  onTrashNotes,
  tasksActive,
  onOpenTasks,
  memoActive,
  onOpenMemo,
  kanbanActive = false,
  onOpenKanban,
}: {
  onReorderNotebooks: (ids: string[], expectedIds: string[]) => Promise<void>;
  reorderingNotebooks: boolean;
  view: NoteView;
  setView: (view: NoteView) => void;
  notebooks: Notebook[];
  notebookId?: string;
  setNotebookId: (id: string) => void;
  query: string;
  setQuery: (query: string) => void;
  onSubmitQuery: () => void;
  searchRef: RefObject<HTMLInputElement | null>;
  onNewInboxNote: () => void;
  creatingNote?: boolean;
  onCreateNotebook: () => void;
  collapsed: boolean;
  onCollapse: () => void;
  onMoveNotesToNotebook?: (ids: string[], notebookId: string) => Promise<void>;
  onTrashNotes?: (ids: string[]) => Promise<void>;
  tasksActive: boolean;
  onOpenTasks: () => void;
  memoActive: boolean;
  onOpenMemo: () => void;
  kanbanActive?: boolean;
  onOpenKanban?: () => void;
}) {
  const notebookListRef = useRef<HTMLDivElement>(null);
  const systemInbox = useMemo(() => notebooks.find((notebook) => notebook.isSystem), [notebooks]);
  const customNotebooks = useMemo(
    () => notebooks.filter((notebook) => !notebook.isSystem),
    [notebooks],
  );
  const sortHandle = useNotebookReorder(
    notebookListRef,
    customNotebooks.map((n) => n.id),
    onReorderNotebooks,
    reorderingNotebooks,
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
        aria-label={creatingNote ? "正在新建笔记" : "在收件箱中新建笔记"}
        aria-busy={creatingNote || undefined}
        disabled={creatingNote}
        onClick={onNewInboxNote}
      >
        {creatingNote ? (
          <LoaderCircle className="spin-icon" size={18} aria-hidden="true" />
        ) : (
          <Plus size={18} aria-hidden="true" />
        )}
        {creatingNote ? "正在新建…" : "新建笔记"}
      </button>
      <label className="search-box">
        <Search size={17} />
        <input
          ref={searchRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
            if (
              event.key !== "Enter" ||
              event.nativeEvent.isComposing ||
              event.nativeEvent.keyCode === 229
            )
              return;
            event.preventDefault();
            onSubmitQuery();
          }}
          enterKeyHint="search"
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
            const isActive =
              !tasksActive && !kanbanActive && !memoActive && view === item.id && !notebookId;
            const dropHandler =
              item.id === "inbox" && systemInbox && onMoveNotesToNotebook
                ? (ids: string[]) => onMoveNotesToNotebook(ids, systemInbox.id)
                : item.id === "trash" && onTrashNotes
                  ? onTrashNotes
                  : undefined;
            return (
              <Fragment key={item.id}>
                {item.id === "trash" && (
                  <>
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
                    {onOpenKanban && (
                      <li>
                        <button
                          className={"nav-item" + (kanbanActive ? " is-active" : "")}
                          type="button"
                          data-note-view="kanban"
                          aria-current={kanbanActive ? "page" : undefined}
                          onClick={onOpenKanban}
                        >
                          <SquareKanban size={18} />
                          <span>看板</span>
                        </button>
                      </li>
                    )}
                  </>
                )}
                <SidebarNavItem
                  item={item}
                  isActive={isActive}
                  onSelect={() => setView(item.id)}
                  onDropNotes={dropHandler}
                />
                {item.id === "favorites" && (
                  <li>
                    <button
                      className={"nav-item" + (memoActive ? " is-active" : "")}
                      type="button"
                      data-note-view="memos"
                      aria-current={memoActive ? "page" : undefined}
                      onClick={onOpenMemo}
                    >
                      <NotebookPen size={18} />
                      <span>随记</span>
                    </button>
                  </li>
                )}
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
          className={`notebook-list-scroll-shell scroll-edge${notebookScrollEdges.before ? " has-scroll-before" : ""}${notebookScrollEdges.after ? " has-scroll-after" : ""}`}
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
                  sortHandle={sortHandle(notebook.id)}
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
    </aside>
  );
});
