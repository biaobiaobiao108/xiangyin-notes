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
  setTaskBusy,
  applyTaskToggle,
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
  setTaskBusy: Tasks["setTaskBusy"];
  applyTaskToggle: Tasks["applyTaskToggle"];
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
      if (taskMutationsInFlightRef.current.has(task.noteId)) return;
      setTaskBusy(task.noteId, task.ordinal);
      try {
        if (splitSelectedRef.current?.id === task.noteId) flushSecondaryDraft();
        await flushPendingSaves("now", task.noteId);
        if (hasUnsavedWork(task.noteId)) {
          notifyWarning("这篇笔记仍有内容未保存，请保存成功后再切换任务状态");
          return;
        }

        const { note } = await api.toggleTask({
          noteId: task.noteId,
          version: task.version,
          ordinal: task.ordinal,
          text: task.text,
          completed: task.done,
        });

        if (selectedRef.current?.id === note.id && selectedRef.current.version < note.version) {
          selectedRef.current = note;
          setSelectedNote(noteMetadataSnapshot(note));
          setNoteReloadToken((value) => value + 1);
        }
        if (
          splitSelectedRef.current?.id === note.id &&
          splitSelectedRef.current.version < note.version
        ) {
          splitSelectedRef.current = note;
          setSplitSelectedNote(noteMetadataSnapshot(note));
          setSplitNoteReloadToken((value) => value + 1);
        }
        replaceList(
          notesRef.current.map((item) =>
            item.id === note.id && item.version < note.version ? toNoteSummary(note) : item,
          ),
        );
        applyTaskToggle(task, note.version);
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
