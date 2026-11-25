import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { TaskSummary } from "../../shared/types";
import { reloadTaskPages } from "./task-pages";

export function useWorkspaceTaskData(tasksOpen: boolean) {
  const [taskStatus, setTaskStatus] = useState<"open" | "done" | "all">("open");
  const [taskNotebookId, setTaskNotebookId] = useState("");
  const [taskSnapshot, setTaskSnapshot] = useState<{
    queryKey: string;
    status: "open" | "done" | "all";
    tasks: TaskSummary[];
    total: number;
    nextCursor: string | null;
  } | null>(null);
  const taskSnapshotRef = useRef(taskSnapshot);
  const taskRequestGenerationRef = useRef(0);
  const taskMoreInFlightRef = useRef(false);
  const [tasksMoreLoading, setTasksMoreLoading] = useState(false);
  const [tasksMoreError, setTasksMoreError] = useState<string | null>(null);
  const [taskLoadError, setTaskLoadError] = useState<{
    queryKey: string;
    message: string;
  } | null>(null);
  const taskQueryKey = JSON.stringify([taskStatus, taskNotebookId]);
  const currentTaskSnapshot = taskSnapshot?.queryKey === taskQueryKey ? taskSnapshot : null;
  const hasTaskSnapshot = currentTaskSnapshot !== null;
  const tasks = currentTaskSnapshot?.tasks ?? [];
  const tasksLoading = tasksOpen && !hasTaskSnapshot && taskLoadError?.queryKey !== taskQueryKey;
  const tasksError = taskLoadError?.queryKey === taskQueryKey ? taskLoadError.message : null;
  const [taskRefreshToken, setTaskRefreshToken] = useState(0);
  const [taskNavigation, setTaskNavigation] = useState<{
    noteId: string;
    ordinal: number;
    text: string;
    token: number;
  } | null>(null);
  const taskNavigationTokenRef = useRef(0);
  const [busyTasks, setBusyTasks] = useState<ReadonlyMap<string, number>>(() => new Map());
  const taskMutationsInFlightRef = useRef(new Map<string, number>());
  const setTaskBusy = useCallback((noteId: string, ordinal: number | null) => {
    const pending = taskMutationsInFlightRef.current;
    if (ordinal === null) pending.delete(noteId);
    else pending.set(noteId, ordinal);
    setBusyTasks(new Map(pending));
  }, []);
  const applyTaskToggle = useCallback((task: TaskSummary, version: number) => {
    // An older list response may have been requested before this write.
    taskRequestGenerationRef.current += 1;
    const current = taskSnapshotRef.current;
    if (current) {
      let removed = 0;
      const updated = current.tasks.flatMap((row) => {
        if (row.noteId !== task.noteId || row.version !== task.version) return [row];
        if (row.ordinal !== task.ordinal) return [{ ...row, version }];
        if (current.status === "all") return [{ ...row, version, done: !task.done }];
        removed += 1;
        return [];
      });
      const next = { ...current, tasks: updated, total: current.total - removed };
      taskSnapshotRef.current = next;
      setTaskSnapshot(next);
    }
    setTaskRefreshToken((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!tasksOpen) return;
    const controller = new AbortController();
    const requestGeneration = ++taskRequestGenerationRef.current;
    const queryKey = JSON.stringify([taskStatus, taskNotebookId]);
    taskMoreInFlightRef.current = false;
    setTasksMoreLoading(false);
    setTasksMoreError(null);
    setTaskLoadError((current) => (current?.queryKey === queryKey ? null : current));
    const previous = taskSnapshotRef.current;
    const loadedCount = previous?.queryKey === queryKey ? previous.tasks.length : 0;
    void reloadTaskPages(
      (cursor, limit) =>
        api.listTasks(
          { status: taskStatus, notebookId: taskNotebookId || undefined, cursor, limit },
          { signal: controller.signal },
        ),
      loadedCount,
    )
      .then((result) => {
        if (controller.signal.aborted || taskRequestGenerationRef.current !== requestGeneration)
          return;
        const snapshot = {
          queryKey,
          status: taskStatus,
          tasks: result.tasks,
          total: result.total ?? result.tasks.length,
          nextCursor: result.nextCursor,
        };
        taskSnapshotRef.current = snapshot;
        setTaskSnapshot(snapshot);
      })
      .catch((reason: unknown) => {
        if (reason instanceof Error && reason.name === "AbortError") return;
        if (controller.signal.aborted || taskRequestGenerationRef.current !== requestGeneration)
          return;
        setTaskLoadError({ queryKey, message: "加载任务失败，请重试" });
      });
    return () => controller.abort();
  }, [taskNotebookId, taskRefreshToken, taskStatus, tasksOpen]);

  const loadMoreTasks = useCallback(() => {
    const snapshot = taskSnapshotRef.current;
    if (
      !tasksOpen ||
      !snapshot ||
      snapshot.queryKey !== taskQueryKey ||
      !snapshot.nextCursor ||
      taskMoreInFlightRef.current
    )
      return;

    const requestGeneration = taskRequestGenerationRef.current;
    taskMoreInFlightRef.current = true;
    setTasksMoreLoading(true);
    setTasksMoreError(null);
    void api
      .listTasks({
        status: taskStatus,
        notebookId: taskNotebookId || undefined,
        cursor: snapshot.nextCursor,
      })
      .then((result) => {
        if (taskRequestGenerationRef.current !== requestGeneration) return;
        const current = taskSnapshotRef.current;
        if (!current || current.queryKey !== snapshot.queryKey) return;
        const known = new Set(current.tasks.map((task) => `${task.noteId}:${task.ordinal}`));
        const next = {
          ...current,
          tasks: [
            ...current.tasks,
            ...result.tasks.filter((task) => !known.has(`${task.noteId}:${task.ordinal}`)),
          ],
          nextCursor: result.nextCursor,
        };
        taskSnapshotRef.current = next;
        setTaskSnapshot(next);
      })
      .catch((reason: unknown) => {
        if (reason instanceof Error && reason.name === "AbortError") return;
        if (taskRequestGenerationRef.current === requestGeneration)
          setTasksMoreError("加载更多任务失败，请重试");
      })
      .finally(() => {
        if (taskRequestGenerationRef.current !== requestGeneration) return;
        taskMoreInFlightRef.current = false;
        setTasksMoreLoading(false);
      });
  }, [taskNotebookId, taskQueryKey, taskStatus, tasksOpen]);

  return {
    taskStatus,
    setTaskStatus,
    taskNotebookId,
    setTaskNotebookId,
    currentTaskSnapshot,
    tasks,
    tasksLoading,
    tasksError,
    tasksMoreLoading,
    tasksMoreError,
    loadMoreTasks,
    taskRefreshToken,
    setTaskRefreshToken,
    taskNavigation,
    setTaskNavigation,
    taskNavigationTokenRef,
    busyTasks,
    setTaskBusy,
    applyTaskToggle,
    taskMutationsInFlightRef,
  };
}
