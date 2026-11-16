import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { Note, NoteSummary, NoteView, TaskSummary } from "../../shared/types";
import { resolveTaskOrdinal } from "../../shared/tasks";
import { ApiError, api } from "../api";
import { errorMessage, noteMetadataSnapshot, toNoteSummary } from "./helpers";
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
  setTaskMutationNoteId,
  setTaskMutationOrdinal,
  flushPendingSaves,
  hasUnsavedWork,
  notifyWarning,
  notifyError,
  setSelectedNote,
  setNoteReloadToken,
  setSplitSelectedNote,
  setSplitNoteReloadToken,
  notesRef,
  replaceList,
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
  setTaskMutationNoteId: Tasks["setTaskMutationNoteId"];
  setTaskMutationOrdinal: Tasks["setTaskMutationOrdinal"];
  flushPendingSaves: Queue["flushPendingSaves"];
  hasUnsavedWork: Queue["hasUnsavedWork"];
  notifyWarning: (message: string) => void;
  notifyError: (message: string) => void;
  setSelectedNote: Setter<Note | null>;
  setNoteReloadToken: Setter<number>;
  setSplitSelectedNote: Setter<Note | null>;
  setSplitNoteReloadToken: Setter<number>;
  notesRef: Ref<NoteSummary[]>;
  replaceList: (notes: NoteSummary[]) => void;
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
      if (taskMutationsInFlightRef.current.size > 0) return;
      taskMutationsInFlightRef.current.add(task.noteId);
      setTaskMutationNoteId(task.noteId);
      setTaskMutationOrdinal(task.ordinal);
      try {
        flushEditorDraftRef.current();
        flushSecondaryDraft();
        await flushPendingSaves("now");
        if (hasUnsavedWork()) {
          notifyWarning("笔记仍有内容未保存，请保存成功后再切换任务状态");
          return;
        }

        const { note: latestNote } = await api.getNote(task.noteId, {});
        if (latestNote.version !== task.version) {
          setTaskRefreshToken((value) => value + 1);
          notifyWarning("笔记内容刚刚保存，任务列表已刷新，请再点一次");
          return;
        }

        const { note } = await api.toggleTask({
          noteId: task.noteId,
          version: task.version,
          ordinal: task.ordinal,
          text: task.text,
          completed: task.done,
        });

        if (selectedRef.current?.id === note.id) {
          selectedRef.current = note;
          setSelectedNote(noteMetadataSnapshot(note));
          setNoteReloadToken((value) => value + 1);
        }
        if (splitSelectedRef.current?.id === note.id) {
          splitSelectedRef.current = note;
          setSplitSelectedNote(noteMetadataSnapshot(note));
          setSplitNoteReloadToken((value) => value + 1);
        }
        replaceList(
          notesRef.current.map((item) => (item.id === note.id ? toNoteSummary(note) : item)),
        );
        setTaskRefreshToken((value) => value + 1);
      } catch (error) {
        if (error instanceof ApiError && error.code === "VERSION_CONFLICT") {
          notifyWarning("笔记已在其他位置修改，请重新加载后再切换任务状态");
          setTaskRefreshToken((value) => value + 1);
        } else {
          notifyError(errorMessage(error, "切换任务状态失败"));
        }
      } finally {
        taskMutationsInFlightRef.current.delete(task.noteId);
        setTaskMutationNoteId(null);
        setTaskMutationOrdinal(null);
      }
    },
    [
      flushPendingSaves,
      flushSecondaryDraft,
      hasUnsavedWork,
      notifyError,
      notifyWarning,
      replaceList,
    ],
  );
  const handleTaskNavigationMissing = useCallback(() => {
    setTaskNavigation(null);
    setTaskRefreshToken((value) => value + 1);
  }, []);
  return { selectTask, handleToggleTask, handleTaskNavigationMissing };
}
