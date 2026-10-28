import { Check, ChevronDown, ChevronLeft, ListTodo, LoaderCircle } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { Notebook, TaskSummary } from "../../shared/types";
import { FloatingScrollbar } from "../floating-scrollbar";
import { collapsedGroupScrollTop } from "./group-layout";
import { useScrollEdges } from "./use-scroll-edges";
import {
  flattenTaskGroups,
  taskGroupRowId,
  taskGroupRowIds,
  taskRowId,
  useVirtualTaskList,
} from "./use-virtual-task-list";

type TaskStatus = "open" | "done" | "all";
type VirtualGroupTransition = {
  groupId: string;
  phase: "collapsing" | "expanding" | "reversing";
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

export function TasksPanel({
  tasks,
  total,
  hasMore,
  loadingMore,
  loadMoreError,
  notebooks,
  notebookId,
  status,
  loading,
  error,
  onNotebookChange,
  onStatusChange,
  onSelectTask,
  onToggleTask,
  onLoadMore,
  busyTask = null,
  onBack,
}: {
  tasks: TaskSummary[];
  total: number;
  hasMore: boolean;
  loadingMore: boolean;
  loadMoreError: string | null;
  notebooks: Notebook[];
  notebookId: string;
  status: TaskStatus;
  loading: boolean;
  error: string | null;
  onNotebookChange: (id: string) => void;
  onStatusChange: (status: TaskStatus) => void;
  onSelectTask: (task: TaskSummary) => void;
  onToggleTask: (task: TaskSummary) => void;
  onLoadMore: () => void;
  busyTask: { noteId: string; ordinal: number } | null;
  onBack?: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef<HTMLElement | null>(null);
  const statusMenuRef = useRef<HTMLDivElement>(null);
  const notebookMenuRef = useRef<HTMLDivElement>(null);
  const filtersRef = useRef<HTMLDivElement>(null);
  const notebookTriggerRef = useRef<HTMLButtonElement>(null);
  const statusTriggerRef = useRef<HTMLButtonElement>(null);
  const [openFilter, setOpenFilter] = useState<"status" | "notebook" | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const [virtualGroupTransition, setVirtualGroupTransition] =
    useState<VirtualGroupTransition | null>(null);
  const virtualGroupTransitionTimerRef = useRef<number | null>(null);
  const notebookNames = useMemo(
    () => new Map(notebooks.map((notebook) => [notebook.id, notebook.name])),
    [notebooks],
  );
  const taskGroups = useMemo(() => {
    const groups = new Map<string, TaskSummary[]>();
    for (const task of tasks) {
      const group = groups.get(task.noteId) ?? [];
      group.push(task);
      groups.set(task.noteId, group);
    }
    return Array.from(groups.values());
  }, [tasks]);
  const taskGroupsById = useMemo(() => {
    const groups = new Map<string, TaskSummary[]>();
    for (const group of taskGroups) {
      const firstTask = group[0];
      if (firstTask) groups.set(firstTask.noteId, group);
    }
    return groups;
  }, [taskGroups]);
  const collapsingGroupId =
    virtualGroupTransition?.phase === "collapsing" &&
    collapsedGroups.has(virtualGroupTransition.groupId)
      ? virtualGroupTransition.groupId
      : null;
  const taskRows = useMemo(
    () => flattenTaskGroups(taskGroups, collapsedGroups, collapsingGroupId),
    [collapsedGroups, collapsingGroupId, taskGroups],
  );
  const retainedRowIds = useMemo(() => taskGroupRowIds(taskGroups), [taskGroups]);
  const virtualList = useVirtualTaskList(
    taskRows,
    retainedRowIds,
    listRef,
    `${status}:${notebookId}`,
    tasks.length,
    virtualGroupTransition?.groupId ?? null,
    virtualGroupTransition?.phase === "collapsing",
  );
  const scrollEdges = useScrollEdges(listRef, [
    loading,
    notebookId,
    status,
    tasks.length,
    virtualList.totalHeight,
  ]);
  const activeVirtualGroupId =
    virtualList.topVisibleRow?.groupId ?? taskGroups[0]?.[0]?.noteId ?? null;
  const activeVirtualGroup = activeVirtualGroupId
    ? taskGroupsById.get(activeVirtualGroupId)
    : undefined;
  const activeVirtualGroupTransition =
    virtualGroupTransition && virtualGroupTransition.groupId === activeVirtualGroupId
      ? virtualGroupTransition.phase
      : null;
  const activeVirtualGroupCollapsed =
    activeVirtualGroupTransition === "collapsing"
      ? true
      : activeVirtualGroupTransition === "expanding" || activeVirtualGroupTransition === "reversing"
        ? false
        : activeVirtualGroupId
          ? collapsedGroups.has(activeVirtualGroupId)
          : false;
  const canAutoLoadMore =
    taskGroups.length === 0 ||
    taskGroups.some((group) => {
      const groupId = group[0]!.noteId;
      return (
        !collapsedGroups.has(groupId) &&
        !(
          virtualGroupTransition?.groupId === groupId &&
          virtualGroupTransition.phase === "collapsing"
        )
      );
    });
  const selectedNotebookName =
    notebooks.find((notebook) => notebook.id === notebookId)?.name ?? "全部笔记本";
  const selectedStatusLabel = { open: "未完成", done: "已完成", all: "全部" }[status];
  useEffect(() => {
    const root = listRef.current;
    const sentinel = loadMoreRef.current;
    if (
      !root ||
      !sentinel ||
      !hasMore ||
      loading ||
      loadingMore ||
      loadMoreError ||
      !canAutoLoadMore ||
      typeof IntersectionObserver === "undefined"
    )
      return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) onLoadMore();
      },
      { root, rootMargin: "420px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [canAutoLoadMore, hasMore, loading, loadingMore, loadMoreError, onLoadMore, tasks.length]);

  const toggleGroup = (groupId: string, button?: HTMLButtonElement) => {
    if (virtualList.isVirtualized) {
      if (groupId === activeVirtualGroupId) virtualList.scrollToRowStart(taskGroupRowId(groupId));
      if (virtualGroupTransitionTimerRef.current !== null)
        window.clearTimeout(virtualGroupTransitionTimerRef.current);
      if (
        virtualGroupTransition?.phase === "collapsing" &&
        virtualGroupTransition.groupId !== groupId
      ) {
        const previousGroupId = virtualGroupTransition.groupId;
        setCollapsedGroups((current) => new Set(current).add(previousGroupId));
      }

      const duration = groupMotionDuration();
      const startTransition = (phase: VirtualGroupTransition["phase"]) => {
        if (duration <= 0) {
          setVirtualGroupTransition(null);
          return;
        }
        setVirtualGroupTransition({ groupId, phase });
        virtualGroupTransitionTimerRef.current = window.setTimeout(() => {
          virtualGroupTransitionTimerRef.current = null;
          if (phase === "collapsing") {
            setCollapsedGroups((current) => new Set(current).add(groupId));
          }
          setVirtualGroupTransition(null);
        }, duration);
      };

      if (
        virtualGroupTransition?.groupId === groupId &&
        virtualGroupTransition.phase === "collapsing"
      ) {
        startTransition("reversing");
        return;
      }
      if (collapsedGroups.has(groupId)) {
        setCollapsedGroups((current) => {
          const next = new Set(current);
          next.delete(groupId);
          return next;
        });
        startTransition("expanding");
        return;
      }
      if (duration <= 0) {
        setCollapsedGroups((current) => new Set(current).add(groupId));
        setVirtualGroupTransition(null);
        return;
      }
      startTransition("collapsing");
      return;
    }

    const scroll = listRef.current;
    const section = button?.closest<HTMLElement>(".tasks-note-group");
    const isCollapsed = collapsedGroups.has(groupId);
    if (scroll && section && button) {
      const scrollRect = scroll.getBoundingClientRect();
      const sectionRect = section.getBoundingClientRect();
      const headerRect = button.getBoundingClientRect();
      const anchorScrollTop = collapsedGroupScrollTop({
        closing: !isCollapsed,
        scrollTop: scroll.scrollTop,
        scrollEdge: scrollRect.top + scroll.clientTop,
        sectionTop: sectionRect.top,
        headerTop: headerRect.top,
      });
      if (anchorScrollTop !== null) scroll.scrollTop = anchorScrollTop;
    }
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (isCollapsed) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  useEffect(() => {
    if (virtualGroupTransitionTimerRef.current !== null)
      window.clearTimeout(virtualGroupTransitionTimerRef.current);
    virtualGroupTransitionTimerRef.current = null;
    setVirtualGroupTransition(null);
  }, [status, notebookId]);
  useEffect(
    () => () => {
      if (virtualGroupTransitionTimerRef.current !== null)
        window.clearTimeout(virtualGroupTransitionTimerRef.current);
    },
    [],
  );
  useEffect(() => {
    if (!openFilter) return;
    const frame = requestAnimationFrame(() => {
      filtersRef.current
        ?.querySelector<HTMLElement>(`.tasks-filter-menu[data-filter="${openFilter}"] button`)
        ?.focus({ preventScroll: true });
    });
    const handlePointerDown = (event: PointerEvent) => {
      if (!filtersRef.current?.contains(event.target as Node)) setOpenFilter(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.isComposing ||
        event.keyCode === 229 ||
        !filtersRef.current?.contains(event.target as Node)
      )
        return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        const trigger =
          openFilter === "notebook" ? notebookTriggerRef.current : statusTriggerRef.current;
        setOpenFilter(null);
        trigger?.focus();
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const buttons = Array.from(
        filtersRef.current?.querySelectorAll<HTMLButtonElement>(
          `.tasks-filter-menu[data-filter="${openFilter}"] button`,
        ) ?? [],
      );
      if (buttons.length === 0) return;
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? buttons.length - 1
            : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [openFilter]);

  const openFilterMenu = (
    kind: "status" | "notebook",
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => {
    event.preventDefault();
    setOpenFilter((current) => (current === kind ? null : kind));
  };

  const renderTaskItem = (
    task: TaskSummary,
    options?: {
      virtual?: boolean;
      rowRef?: (element: HTMLLIElement | null) => void;
      rowStyle?: CSSProperties;
      groupMotion?: "collapsing" | "expanding";
    },
  ) => {
    const isBusy = busyTask?.noteId === task.noteId && busyTask.ordinal === task.ordinal;
    return (
      <li
        key={task.noteId + ":" + task.ordinal}
        ref={options?.rowRef}
        data-task-row-id={options?.virtual ? taskRowId(task) : undefined}
        className={
          options?.virtual
            ? `tasks-virtual-task-row${options.groupMotion ? ` is-group-${options.groupMotion}` : ""}`
            : undefined
        }
        style={options?.rowStyle}
        inert={options?.groupMotion === "collapsing" || undefined}
      >
        <div
          className="tasks-item"
          style={{ paddingInlineStart: `${6 + Math.min(task.depth, 5) * 16}px` }}
        >
          <button
            type="button"
            className={
              "tasks-check-button" + (task.done ? " is-done" : "") + (isBusy ? " is-busy" : "")
            }
            data-task-tab-index={options?.virtual ? 0 : undefined}
            aria-label={
              isBusy
                ? "正在更新任务状态"
                : task.done
                  ? `标记为未完成：${task.text}`
                  : `标记为已完成：${task.text}`
            }
            aria-pressed={task.done}
            disabled={loading || busyTask !== null}
            onClick={() => onToggleTask(task)}
          >
            <span className="tasks-check-box" aria-hidden="true">
              {isBusy ? <LoaderCircle size={13} /> : task.done ? <Check size={13} /> : null}
            </span>
          </button>
          <button
            type="button"
            className="tasks-item-copy"
            data-task-tab-index={options?.virtual ? 1 : undefined}
            disabled={loading || busyTask !== null}
            onClick={() => onSelectTask(task)}
            aria-label={`打开笔记 ${task.noteTitle} 并定位任务：${task.text}`}
          >
            <span className={task.done ? "is-done" : ""}>{task.text}</span>
          </button>
        </div>
      </li>
    );
  };

  const renderLoadMoreContent = () =>
    loadingMore ? (
      <span role="status">正在加载更多任务…</span>
    ) : loadMoreError ? (
      <>
        <span role="alert">{loadMoreError}</span>
        <button type="button" onClick={onLoadMore}>
          重试
        </button>
      </>
    ) : !canAutoLoadMore ? (
      <button type="button" onClick={onLoadMore}>
        加载更多任务
      </button>
    ) : null;

  const virtualListStyle: CSSProperties | undefined = virtualList.isVirtualized
    ? { height: `${virtualList.totalHeight + (hasMore ? 72 : 24)}px` }
    : undefined;

  return (
    <section
      className="note-list-panel tasks-panel"
      aria-labelledby="tasks-heading"
      aria-busy={loading || busyTask !== null}
    >
      <header className="list-header tasks-header">
        {onBack && (
          <button className="tasks-back tasks-header-back" type="button" onClick={onBack}>
            <ChevronLeft size={18} aria-hidden="true" />
            <span>笔记</span>
          </button>
        )}
        <div className="list-header-main">
          <h2 id="tasks-heading">任务</h2>
          <p className="tasks-count">{total} 项</p>
        </div>
      </header>
      <div className="tasks-toolbar" ref={filtersRef}>
        <div className="tasks-filter-dropdown">
          <button
            ref={statusTriggerRef}
            type="button"
            className="tasks-filter-trigger"
            aria-label="筛选任务状态"
            aria-haspopup="menu"
            aria-expanded={openFilter === "status"}
            onClick={(event) => openFilterMenu("status", event)}
          >
            <span>{selectedStatusLabel}</span>
            <ChevronDown size={14} aria-hidden="true" />
          </button>
          {openFilter === "status" && (
            <div className="tasks-filter-menu-wrap">
              <div
                id="tasks-status-filter-menu"
                ref={statusMenuRef}
                className="tasks-filter-menu floating-scrollbar-target"
                data-filter="status"
                role="menu"
                aria-label="任务状态"
              >
                {(
                  [
                    ["open", "未完成"],
                    ["done", "已完成"],
                    ["all", "全部"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={status === value}
                    className={status === value ? "is-selected" : ""}
                    onClick={() => {
                      onStatusChange(value);
                      setOpenFilter(null);
                      statusTriggerRef.current?.focus();
                    }}
                  >
                    <span className="tasks-filter-option-label">{label}</span>
                  </button>
                ))}
              </div>
              <FloatingScrollbar
                scrollTargetRef={statusMenuRef}
                controlsId="tasks-status-filter-menu"
                ariaLabel="任务状态菜单滚动条"
                placement="right"
              />
            </div>
          )}
        </div>
        <div className="tasks-filter-dropdown">
          <button
            ref={notebookTriggerRef}
            type="button"
            className="tasks-filter-trigger tasks-filter-trigger-notebook"
            aria-label="筛选笔记本"
            aria-haspopup="menu"
            aria-expanded={openFilter === "notebook"}
            onClick={(event) => openFilterMenu("notebook", event)}
          >
            <span>{selectedNotebookName}</span>
            <ChevronDown size={14} aria-hidden="true" />
          </button>
          {openFilter === "notebook" && (
            <div className="tasks-filter-menu-wrap">
              <div
                id="tasks-notebook-filter-menu"
                ref={notebookMenuRef}
                className="tasks-filter-menu floating-scrollbar-target"
                data-filter="notebook"
                role="menu"
                aria-label="笔记本"
              >
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={!notebookId}
                  className={!notebookId ? "is-selected" : ""}
                  onClick={() => {
                    onNotebookChange("");
                    setOpenFilter(null);
                    notebookTriggerRef.current?.focus();
                  }}
                >
                  <span className="tasks-filter-option-label">全部笔记本</span>
                </button>
                {notebooks.map((notebook) => (
                  <button
                    key={notebook.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={notebookId === notebook.id}
                    className={notebookId === notebook.id ? "is-selected" : ""}
                    onClick={() => {
                      onNotebookChange(notebook.id);
                      setOpenFilter(null);
                      notebookTriggerRef.current?.focus();
                    }}
                  >
                    <span className="tasks-filter-option-label">{notebook.name}</span>
                  </button>
                ))}
              </div>
              <FloatingScrollbar
                scrollTargetRef={notebookMenuRef}
                controlsId="tasks-notebook-filter-menu"
                ariaLabel="笔记本菜单滚动条"
                placement="right"
              />
            </div>
          )}
        </div>
      </div>
      <div className="note-list-content">
        <div
          className={`tasks-scroll-shell${scrollEdges.before ? " has-scroll-before" : ""}${scrollEdges.after ? " has-scroll-after" : ""}`}
        >
          <div
            id="tasks-scroll-region"
            className="tasks-scroll floating-scrollbar-target"
            ref={listRef}
            onKeyDown={virtualList.moveTabFocus}
            onFocusCapture={virtualList.onFocusCapture}
            onBlurCapture={virtualList.onBlurCapture}
          >
            {loading && tasks.length === 0 ? (
              <p className="tasks-empty" role="status">
                正在加载任务…
              </p>
            ) : error ? (
              <p className="tasks-empty" role="alert">
                {error}
              </p>
            ) : tasks.length ? (
              virtualList.isVirtualized ? (
                <>
                  {activeVirtualGroup && (
                    <h2
                      className="tasks-note-group-header tasks-virtual-sticky-header"
                      style={{ transform: `translateY(${virtualList.stickyOffset}px)` }}
                    >
                      <button
                        type="button"
                        className="tasks-note-group-toggle"
                        aria-expanded={!activeVirtualGroupCollapsed}
                        aria-controls="tasks-virtual-list"
                        onClick={() => toggleGroup(activeVirtualGroup[0]!.noteId)}
                      >
                        <ChevronDown
                          className="tasks-note-group-chevron"
                          size={14}
                          aria-hidden="true"
                        />
                        <span className="tasks-note-title">{activeVirtualGroup[0]!.noteTitle}</span>
                        {notebookNames.has(activeVirtualGroup[0]!.notebookId) ? (
                          <small>{notebookNames.get(activeVirtualGroup[0]!.notebookId)}</small>
                        ) : null}
                      </button>
                    </h2>
                  )}
                  <ul
                    id="tasks-virtual-list"
                    className={`tasks-virtual-list${virtualGroupTransition ? " is-transitioning" : ""}`}
                    role="list"
                    style={virtualListStyle}
                  >
                    {virtualList.visibleRows.map(({ row, index, top }) => {
                      const animatedTop =
                        virtualList.collapsingGroup && index >= virtualList.collapsingGroup.end
                          ? top - virtualList.collapsingGroup.height
                          : top;
                      if (row.kind === "group") {
                        const isStickyMarker = row.groupId === activeVirtualGroupId;
                        const isFocusedMarker = virtualList.pinnedRowId === row.id;
                        const hideMarker = isStickyMarker && !isFocusedMarker;
                        const markerTransition =
                          virtualGroupTransition?.groupId === row.groupId
                            ? virtualGroupTransition.phase
                            : null;
                        const markerCollapsed =
                          markerTransition === "collapsing"
                            ? true
                            : markerTransition === "expanding" || markerTransition === "reversing"
                              ? false
                              : collapsedGroups.has(row.groupId);
                        return (
                          <li
                            key={row.id}
                            ref={virtualList.getRowRef(row.id)}
                            data-task-row-id={row.id}
                            className={`tasks-virtual-group-marker${row.firstGroup ? " is-first" : ""}${markerCollapsed ? " is-collapsed" : ""}${hideMarker ? " is-sticky-marker" : ""}`}
                            aria-hidden={hideMarker || undefined}
                            inert={hideMarker || undefined}
                            style={virtualList.rowStyle(animatedTop)}
                          >
                            <button
                              type="button"
                              className="tasks-note-group-toggle"
                              aria-expanded={!markerCollapsed}
                              aria-controls="tasks-virtual-list"
                              onClick={() => toggleGroup(row.groupId)}
                            >
                              <ChevronDown
                                className="tasks-note-group-chevron"
                                size={14}
                                aria-hidden="true"
                              />
                              <span className="tasks-note-title">{row.task.noteTitle}</span>
                              {notebookNames.has(row.task.notebookId) ? (
                                <small>{notebookNames.get(row.task.notebookId)}</small>
                              ) : null}
                            </button>
                          </li>
                        );
                      }
                      const groupMotion =
                        virtualGroupTransition?.groupId === row.groupId &&
                        (virtualGroupTransition.phase === "collapsing" ||
                          virtualGroupTransition.phase === "expanding")
                          ? virtualGroupTransition.phase
                          : undefined;
                      return renderTaskItem(row.task, {
                        virtual: true,
                        rowRef: virtualList.getRowRef(row.id),
                        rowStyle: virtualList.rowStyle(animatedTop),
                        groupMotion,
                      });
                    })}
                    {hasMore && (
                      <li
                        ref={(element) => {
                          loadMoreRef.current = element;
                        }}
                        className="tasks-load-more"
                        style={{
                          position: "absolute",
                          insetInline: 12,
                          top: 0,
                          transform: `translateY(${virtualList.totalHeight - (virtualList.collapsingGroup?.height ?? 0)}px)`,
                        }}
                      >
                        {renderLoadMoreContent()}
                      </li>
                    )}
                  </ul>
                </>
              ) : (
                <div className="tasks-list">
                  {taskGroups.map((group) => {
                    const firstTask = group[0]!;
                    const collapsed = collapsedGroups.has(firstTask.noteId);
                    const groupId = `tasks-note-${firstTask.noteId}`;
                    return (
                      <section className="tasks-note-group" key={firstTask.noteId}>
                        <h2 className="tasks-note-group-header">
                          <button
                            type="button"
                            className="tasks-note-group-toggle"
                            aria-expanded={!collapsed}
                            aria-controls={groupId}
                            onClick={(event) => toggleGroup(firstTask.noteId, event.currentTarget)}
                          >
                            <ChevronDown
                              className="tasks-note-group-chevron"
                              size={14}
                              aria-hidden="true"
                            />
                            <span className="tasks-note-title">{firstTask.noteTitle}</span>
                            {notebookNames.has(firstTask.notebookId) ? (
                              <small>{notebookNames.get(firstTask.notebookId)}</small>
                            ) : null}
                          </button>
                        </h2>
                        <div
                          id={groupId}
                          className={`tasks-note-group-content${collapsed ? " is-collapsed" : ""}`}
                          inert={collapsed}
                        >
                          <ul>{group.map((task) => renderTaskItem(task))}</ul>
                        </div>
                      </section>
                    );
                  })}
                  {hasMore && (
                    <div
                      ref={(element) => {
                        loadMoreRef.current = element;
                      }}
                      className="tasks-load-more"
                    >
                      {renderLoadMoreContent()}
                    </div>
                  )}
                </div>
              )
            ) : (
              <div className="tasks-empty">
                <ListTodo size={22} aria-hidden="true" />
                <p>没有匹配的任务</p>
              </div>
            )}
          </div>
        </div>
        <FloatingScrollbar
          scrollTargetRef={listRef}
          controlsId="tasks-scroll-region"
          ariaLabel="任务列表滚动条"
          placement="right"
        />
      </div>
    </section>
  );
}
