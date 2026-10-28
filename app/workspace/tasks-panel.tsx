import { Check, ChevronDown, ChevronLeft, ListTodo, LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { Notebook, TaskSummary } from "../../shared/types";
import { FloatingScrollbar } from "../floating-scrollbar";
import { useScrollEdges } from "./use-scroll-edges";

type TaskStatus = "open" | "done" | "all";

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
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const statusMenuRef = useRef<HTMLDivElement>(null);
  const notebookMenuRef = useRef<HTMLDivElement>(null);
  const filtersRef = useRef<HTMLDivElement>(null);
  const notebookTriggerRef = useRef<HTMLButtonElement>(null);
  const statusTriggerRef = useRef<HTMLButtonElement>(null);
  const [openFilter, setOpenFilter] = useState<"status" | "notebook" | null>(null);
  const [collapsedNotes, setCollapsedNotes] = useState<Set<string>>(() => new Set());
  const scrollEdges = useScrollEdges(listRef, [loading, notebookId, status, tasks.length]);
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
  const selectedNotebookName =
    notebooks.find((notebook) => notebook.id === notebookId)?.name ?? "全部笔记本";
  const selectedStatusLabel = { open: "未完成", done: "已完成", all: "全部" }[status];
  useEffect(() => {
    const root = listRef.current;
    const sentinel = loadMoreRef.current;
    if (!root || !sentinel || !hasMore || loading || loadingMore || loadMoreError) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) onLoadMore();
      },
      { root, rootMargin: "420px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loading, loadingMore, loadMoreError, onLoadMore, tasks.length]);
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
              <div className="tasks-list">
                {taskGroups.map((group) => {
                  const firstTask = group[0]!;
                  const collapsed = collapsedNotes.has(firstTask.noteId);
                  const groupId = `tasks-note-${firstTask.noteId}`;
                  return (
                    <section className="tasks-note-group" key={firstTask.noteId}>
                      <h2 className="tasks-note-group-header">
                        <button
                          type="button"
                          className="tasks-note-group-toggle"
                          aria-expanded={!collapsed}
                          aria-controls={groupId}
                          onClick={() => {
                            setCollapsedNotes((current) => {
                              const next = new Set(current);
                              if (next.has(firstTask.noteId)) next.delete(firstTask.noteId);
                              else next.add(firstTask.noteId);
                              return next;
                            });
                          }}
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
                      <ul id={groupId} hidden={collapsed}>
                        {group.map((task) => {
                          const isBusy =
                            busyTask?.noteId === task.noteId && busyTask.ordinal === task.ordinal;
                          return (
                            <li key={task.noteId + ":" + task.ordinal}>
                              <div
                                className="tasks-item"
                                style={{
                                  paddingInlineStart: `${6 + Math.min(task.depth, 5) * 16}px`,
                                }}
                              >
                                <button
                                  type="button"
                                  className={
                                    "tasks-check-button" +
                                    (task.done ? " is-done" : "") +
                                    (isBusy ? " is-busy" : "")
                                  }
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
                                    {isBusy ? (
                                      <LoaderCircle size={13} />
                                    ) : task.done ? (
                                      <Check size={13} />
                                    ) : null}
                                  </span>
                                </button>
                                <button
                                  type="button"
                                  className="tasks-item-copy"
                                  disabled={loading || busyTask !== null}
                                  onClick={() => onSelectTask(task)}
                                  aria-label={`打开笔记 ${task.noteTitle} 并定位任务：${task.text}`}
                                >
                                  <span className={task.done ? "is-done" : ""}>{task.text}</span>
                                </button>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    </section>
                  );
                })}
                {hasMore && (
                  <div className="tasks-load-more" ref={loadMoreRef}>
                    {loadingMore ? (
                      <span role="status">正在加载更多任务…</span>
                    ) : loadMoreError ? (
                      <>
                        <span role="alert">{loadMoreError}</span>
                        <button type="button" onClick={onLoadMore}>
                          重试
                        </button>
                      </>
                    ) : null}
                  </div>
                )}
              </div>
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
