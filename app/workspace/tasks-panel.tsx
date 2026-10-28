import { Check, ChevronDown, ChevronLeft, Circle, ListTodo, LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Notebook, TaskSummary } from "../../shared/types";
import { useContextMenu, type ContextMenuItem } from "../context-menu";
import { FloatingScrollbar } from "../floating-scrollbar";

type TaskStatus = "open" | "done" | "all";

export function TasksPanel({
  tasks,
  notebooks,
  notebookId,
  status,
  loading,
  error,
  onNotebookChange,
  onStatusChange,
  onSelectTask,
  onToggleTask,
  busyTask = null,
  onBack,
}: {
  tasks: TaskSummary[];
  notebooks: Notebook[];
  notebookId: string;
  status: TaskStatus;
  loading: boolean;
  error: string | null;
  onNotebookChange: (id: string) => void;
  onStatusChange: (status: TaskStatus) => void;
  onSelectTask: (task: TaskSummary) => void;
  onToggleTask: (task: TaskSummary) => void;
  busyTask: { noteId: string; ordinal: number } | null;
  onBack?: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const notebookFilterRef = useRef<HTMLDivElement>(null);
  const notebookTriggerRef = useRef<HTMLButtonElement>(null);
  const [notebookMenuOpen, setNotebookMenuOpen] = useState(false);
  const { openMenu, menu: contextMenu } = useContextMenu();
  const useContextDropdown =
    typeof window !== "undefined" &&
    window.innerWidth > 900 &&
    window.matchMedia("(any-pointer: fine)").matches;
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
  const notebookMenuItems = useMemo<ContextMenuItem[]>(
    () => [
      {
        label: "全部笔记本",
        icon: !notebookId ? Check : undefined,
        onSelect: () => onNotebookChange(""),
      },
      ...notebooks.map((notebook) => ({
        label: notebook.name,
        icon: notebook.id === notebookId ? Check : undefined,
        onSelect: () => onNotebookChange(notebook.id),
      })),
    ],
    [notebookId, notebooks, onNotebookChange],
  );

  useEffect(() => {
    if (!notebookMenuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!notebookFilterRef.current?.contains(event.target as Node)) setNotebookMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setNotebookMenuOpen(false);
      notebookTriggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [notebookMenuOpen]);

  return (
    <section className="note-list-panel tasks-panel" aria-labelledby="tasks-heading">
      <header className="list-header tasks-header">
        <div className="note-list-title-row">
          <div>
            {onBack && (
              <button className="tasks-back" type="button" onClick={onBack}>
                <ChevronLeft size={18} />
                笔记
              </button>
            )}
            <h1 id="tasks-heading">任务</h1>
            <span className="tasks-count">{tasks.length} 项</span>
          </div>
          <div className="tasks-notebook-filter" ref={notebookFilterRef}>
            <button
              ref={notebookTriggerRef}
              className="tasks-notebook-trigger"
              type="button"
              aria-label="按笔记本筛选任务"
              aria-haspopup={useContextDropdown ? "menu" : "listbox"}
              aria-expanded={useContextDropdown ? undefined : notebookMenuOpen}
              onClick={(event) => {
                if (useContextDropdown) {
                  setNotebookMenuOpen(false);
                  openMenu(event, notebookMenuItems, "按笔记本筛选任务");
                } else {
                  setNotebookMenuOpen((open) => !open);
                }
              }}
            >
              <span>{selectedNotebookName}</span>
              <ChevronDown size={15} aria-hidden="true" />
            </button>
            {notebookMenuOpen && (
              <div className="tasks-notebook-menu" role="listbox" aria-label="选择笔记本">
                <button
                  type="button"
                  role="option"
                  aria-selected={!notebookId}
                  className={!notebookId ? "is-selected" : ""}
                  onClick={() => {
                    onNotebookChange("");
                    setNotebookMenuOpen(false);
                  }}
                >
                  全部笔记本
                </button>
                {notebooks.map((notebook) => (
                  <button
                    key={notebook.id}
                    type="button"
                    role="option"
                    aria-selected={notebookId === notebook.id}
                    className={notebookId === notebook.id ? "is-selected" : ""}
                    onClick={() => {
                      onNotebookChange(notebook.id);
                      setNotebookMenuOpen(false);
                    }}
                  >
                    {notebook.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="tasks-status-filter" role="group" aria-label="任务状态">
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
              className={status === value ? "is-active" : ""}
              aria-pressed={status === value}
              onClick={() => onStatusChange(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </header>
      <div className="note-list-content">
        <div
          id="tasks-scroll-region"
          className="tasks-scroll floating-scrollbar-target"
          ref={listRef}
        >
          {loading ? (
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
                return (
                  <section className="tasks-note-group" key={firstTask.noteId}>
                    <h2>
                      <span className="tasks-note-title">{firstTask.noteTitle}</span>
                      {notebookNames.has(firstTask.notebookId) ? (
                        <small>{notebookNames.get(firstTask.notebookId)}</small>
                      ) : null}
                    </h2>
                    <ul>
                      {group.map((task) => {
                        const isBusy =
                          busyTask?.noteId === task.noteId && busyTask.ordinal === task.ordinal;
                        return (
                          <li key={task.noteId + ":" + task.ordinal}>
                            <div className="tasks-item">
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
                                disabled={busyTask !== null}
                                onClick={() => onToggleTask(task)}
                              >
                                {isBusy ? (
                                  <LoaderCircle size={15} aria-hidden="true" />
                                ) : task.done ? (
                                  <Check size={15} aria-hidden="true" />
                                ) : (
                                  <Circle size={15} aria-hidden="true" />
                                )}
                              </button>
                              <button
                                type="button"
                                className="tasks-item-copy"
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
            </div>
          ) : (
            <div className="tasks-empty">
              <ListTodo size={22} aria-hidden="true" />
              <p>没有匹配的任务</p>
            </div>
          )}
        </div>
        <FloatingScrollbar
          scrollTargetRef={listRef}
          controlsId="tasks-scroll-region"
          ariaLabel="任务列表滚动条"
          placement="right"
        />
      </div>
      {contextMenu}
    </section>
  );
}
