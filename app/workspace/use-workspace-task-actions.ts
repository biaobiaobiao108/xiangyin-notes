import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { Note, NoteView, TaskSummary } from "../../shared/types";
import { resolveTaskOrdinal } from "../../shared/tasks";
import { ApiError } from "../api";
import { errorMessage } from "./helpers";
import type { useWorkspaceTaskData } from "./use-workspace-task-data";
import type { useNoteSaveQueue } from "./use-note-save-queue";
import type { useMobileNavigation } from "./use-mobile-navigation";
import type { ViewLayout } from "./use-workspace-preferences";

type Ref<T> = { current: T };
type Setter<T> = Dispatch<SetStateAction<T>>;
type Tasks = ReturnType<typeof useWorkspaceTaskData>;
type Queue = ReturnType<typeof useNoteSaveQueue>;

export function useWorkspaceTaskActions({
  flushEditorDraftRef,
  flushSecondaryDraft,
  selectedRef,
  splitSelectedRef,
  setQuery,
  setView,
  setNotebookId,
  splitNoteId,
  closeSplit,
  setCardEditingNoteId,
  viewLayout,
  selectNote,
  setTaskNavigation,
  setTaskRefreshToken,
  taskNavigationTokenRef,
  openMobileNote,
  taskMutationsInFlightRef,
  setTaskBusy,
  applyTaskToggle,
  flushPendingSaves,
  hasUnsavedWork,
  toggleNoteTask,
  notifyWarning,
  notifyError,
}: {
  flushEditorDraftRef: Ref<() => void>;
  flushSecondaryDraft: () => void;
  selectedRef: Ref<Note | null>;
  splitSelectedRef: Ref<Note | null>;
  setQuery: (value: string) => void;
  setView: Setter<NoteView>;
  setNotebookId: Setter<string | undefined>;
  splitNoteId: string | null;
  closeSplit: () => void;
  setCardEditingNoteId: Setter<string | null>;
  viewLayout: ViewLayout;
  selectNote: (id: string | null) => void;
  setTaskNavigation: Tasks["setTaskNavigation"];
  setTaskRefreshToken: Tasks["setTaskRefreshToken"];
  taskNavigationTokenRef: Tasks["taskNavigationTokenRef"];
  openMobileNote: ReturnType<typeof useMobileNavigation>["openMobileNote"];
  taskMutationsInFlightRef: Tasks["taskMutationsInFlightRef"];
  setTaskBusy: Tasks["setTaskBusy"];
  applyTaskToggle: Tasks["applyTaskToggle"];
  flushPendingSaves: Queue["flushPendingSaves"];
  hasUnsavedWork: Queue["hasUnsavedWork"];
  toggleNoteTask: Queue["toggleNoteTask"];
  notifyWarning: (message: string) => void;
  notifyError: (message: string) => void;
}) {
  const selectTask = useCallback(
    (task: TaskSummary) => {
      flushEditorDraftRef.current();
      flushSecondaryDraft();
      const currentTaskNote =
        selectedRef.current?.id === task.noteId
          ? selectedRef.current
          : splitSelectedRef.current?.id === task.noteId
            ? splitSelectedRef.current
            : null;
      const ordinal = currentTaskNote
        ? resolveTaskOrdinal(currentTaskNote.contentMarkdown, task.ordinal, task.text)
        : task.ordinal;
      setQuery("");
      setView("all");
      setNotebookId(undefined);
      if (splitNoteId) closeSplit();
      setCardEditingNoteId(viewLayout === "cards" ? task.noteId : null);
      selectNote(task.noteId);
      if (ordinal === null) {
        setTaskNavigation(null);
        setTaskRefreshToken((value) => value + 1);
      } else {
        setTaskNavigation({
          noteId: task.noteId,
          ordinal,
          text: task.text,
          token: ++taskNavigationTokenRef.current,
        });
      }
      openMobileNote({ view: "all", notebookId: undefined, query: "", noteId: task.noteId });
    },
    [closeSplit, flushSecondaryDraft, openMobileNote, selectNote, splitNoteId, viewLayout],
  );
  const handleToggleTask = useCallback(
    async (task: TaskSummary) => {
      if (taskMutationsInFlightRef.current.has(task.noteId)) return;
      setTaskBusy(task.noteId, task.ordinal);
      try {
        await flushPendingSaves("now", task.noteId);
        if (hasUnsavedWork(task.noteId)) {
          notifyWarning("这篇笔记仍有内容未保存，请保存成功后再切换任务状态");
          return;
        }

        applyTaskToggle(task, await toggleNoteTask(task));
      } catch (error) {
        if (error instanceof ApiError && error.code === "VERSION_CONFLICT") {
          notifyWarning("笔记已在其他位置修改，请重新加载后再切换任务状态");
          setTaskRefreshToken((value) => value + 1);
        } else {
          notifyError(errorMessage(error, "切换任务状态失败"));
        }
      } finally {
        setTaskBusy(task.noteId, null);
      }
    },
    [
      applyTaskToggle,
      setTaskBusy,
      flushPendingSaves,
      hasUnsavedWork,
      notifyError,
      notifyWarning,
      setTaskRefreshToken,
      taskMutationsInFlightRef,
      toggleNoteTask,
    ],
  );
  const handleTaskNavigationMissing = useCallback(() => {
    setTaskNavigation(null);
    setTaskRefreshToken((value) => value + 1);
  }, []);
  return { selectTask, handleToggleTask, handleTaskNavigationMissing };
}
