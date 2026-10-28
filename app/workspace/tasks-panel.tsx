import { Check, ChevronLeft, Circle, ListTodo } from "lucide-react";
import { useMemo, useRef } from "react";
import type { Notebook, TaskSummary } from "../../shared/types";
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
  onBack?: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
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

  return (
    <section className="note-list-panel tasks-panel" aria-labelledby="tasks-heading">
      <header className="note-list-header tasks-header">
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
          <label className="tasks-notebook-filter">
            <span className="visually-hidden">按笔记本筛选任务</span>
            <select value={notebookId} onChange={(event) => onNotebookChange(event.target.value)}>
              <option value="">全部笔记本</option>
              {notebooks.map((notebook) => (
                <option key={notebook.id} value={notebook.id}>
                  {notebook.name}
                </option>
              ))}
            </select>
          </label>
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
                      {firstTask.noteTitle}
                      {notebookNames.has(firstTask.notebookId) ? (
                        <small>{notebookNames.get(firstTask.notebookId)}</small>
                      ) : null}
                    </h2>
                    <ul>
                      {group.map((task) => (
                        <li key={task.noteId + ":" + task.ordinal}>
                          <button
                            type="button"
                            className="tasks-item"
                            onClick={() => onSelectTask(task)}
                            aria-label={
                              (task.done ? "已完成" : "未完成") +
                              "：" +
                              task.text +
                              "，打开笔记 " +
                              task.noteTitle
                            }
                          >
                            <span
                              className={"tasks-check" + (task.done ? " is-done" : "")}
                              aria-hidden="true"
                            >
                              {task.done ? <Check size={15} /> : <Circle size={15} />}
                            </span>
                            <span className="tasks-item-copy">
                              <span className={task.done ? "is-done" : ""}>{task.text}</span>
                            </span>
                          </button>
                        </li>
                      ))}
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
    </section>
  );
}
