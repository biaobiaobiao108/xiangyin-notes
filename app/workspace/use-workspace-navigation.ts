import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { NoteView } from "../../shared/types";
import type { useMobileNavigation } from "./use-mobile-navigation";
import type { useNoteSaveQueue } from "./use-note-save-queue";
import type { ViewLayout } from "./use-workspace-preferences";

type Ref<T> = { current: T };
type Setter<T> = Dispatch<SetStateAction<T>>;
type Mobile = ReturnType<typeof useMobileNavigation>;
type Queue = ReturnType<typeof useNoteSaveQueue>;
export function useWorkspaceNavigation({
  view,
  notebookId,
  query,
  queryDraft,
  navigationIntentRef,
  setView,
  setNotebookId,
  setQuery,
  setQueryDraft,
  setTasksOpen,
  setKanbanOpen,
  setMemosOpen,
  setCardEditingNoteId,
  kanbanReturnRef,
  searchOriginRef,
  requestListTransition,
  openMobileList,
  openMobileTasks,
  openMobileKanban,
  openMobileMemos,
  openMobileNote,
  flushSecondaryDraft,
  flushPendingSaves,
  hasUnsavedWork,
  notifyWarning,
  flushEditorDraftRef,
  splitNoteId,
  closeSplit,
  viewLayout,
  selectNote,
}: {
  view: NoteView;
  notebookId?: string;
  query: string;
  queryDraft: string;
  navigationIntentRef: Ref<number>;
  setView: Setter<NoteView>;
  setNotebookId: Setter<string | undefined>;
  setQuery: (value: string) => void;
  setQueryDraft: Setter<string>;
  setTasksOpen: Setter<boolean>;
  setKanbanOpen: Setter<boolean>;
  setMemosOpen: Setter<boolean>;
  setCardEditingNoteId: Setter<string | null>;
  kanbanReturnRef: Ref<boolean>;
  searchOriginRef: Ref<{ view: NoteView; notebookId?: string } | null>;
  requestListTransition: () => void;
  openMobileList: Mobile["openMobileList"];
  openMobileTasks: Mobile["openMobileTasks"];
  openMobileKanban: Mobile["openMobileKanban"];
  openMobileMemos: Mobile["openMobileMemos"];
  openMobileNote: Mobile["openMobileNote"];
  flushSecondaryDraft: () => void;
  flushPendingSaves: Queue["flushPendingSaves"];
  hasUnsavedWork: Queue["hasUnsavedWork"];
  notifyWarning: (message: string) => void;
  flushEditorDraftRef: Ref<() => void>;
  splitNoteId: string | null;
  closeSplit: () => void;
  viewLayout: ViewLayout;
  selectNote: (id: string | null) => void;
}) {
  const selectView = useCallback(
    (next: NoteView) => {
      navigationIntentRef.current += 1;
      setTasksOpen(false);
      setKanbanOpen(false);
      setMemosOpen(false);
      kanbanReturnRef.current = false;
      if (view !== next || notebookId || query) requestListTransition();
      searchOriginRef.current = null;
      setQuery("");
      setView(next);
      setNotebookId(undefined);
      setCardEditingNoteId(null);
      openMobileList({ view: next, notebookId: undefined, query: "", searchOrigin: null });
    },
    [openMobileList, notebookId, query, requestListTransition, view],
  );
  const openCollection = useCallback(
    async (collection: "tasks" | "kanban" | "memos") => {
      const intent = ++navigationIntentRef.current;
      flushSecondaryDraft();
      await flushPendingSaves("now");
      if (intent !== navigationIntentRef.current) return;
      if (hasUnsavedWork()) {
        const label = { tasks: "任务", kanban: "看板", memos: "随记" }[collection];
        notifyWarning(`仍有内容未保存，请保存成功后再查看${label}`);
        return;
      }
      setQuery("");
      setView("all");
      setNotebookId(undefined);
      setTasksOpen(collection === "tasks");
      setKanbanOpen(collection === "kanban");
      setMemosOpen(collection === "memos");
      kanbanReturnRef.current = false;
      const openMobile = {
        tasks: openMobileTasks,
        kanban: openMobileKanban,
        memos: openMobileMemos,
      };
      openMobile[collection]({ view: "all", notebookId: undefined, query: "", searchOrigin: null });
    },
    [
      flushPendingSaves,
      flushSecondaryDraft,
      hasUnsavedWork,
      kanbanReturnRef,
      navigationIntentRef,
      notifyWarning,
      openMobileTasks,
      openMobileKanban,
      openMobileMemos,
      setQuery,
    ],
  );
  const openTasks = useCallback(() => openCollection("tasks"), [openCollection]);
  const openKanban = useCallback(() => openCollection("kanban"), [openCollection]);
  const openMemos = useCallback(() => openCollection("memos"), [openCollection]);
  const openKanbanNote = useCallback(
    (noteId: string) => {
      navigationIntentRef.current += 1;
      flushEditorDraftRef.current();
      flushSecondaryDraft();
      kanbanReturnRef.current = true;
      setKanbanOpen(false);
      setQuery("");
      setView("all");
      setNotebookId(undefined);
      if (splitNoteId) closeSplit();
      if (viewLayout === "cards") {
        setCardEditingNoteId(noteId);
      } else {
        setCardEditingNoteId(null);
      }
      selectNote(noteId);
      openMobileNote({ view: "all", notebookId: undefined, query: "", noteId });
    },
    [closeSplit, flushSecondaryDraft, openMobileNote, selectNote, splitNoteId, viewLayout],
  );
  const selectNotebook = useCallback(
    (notebookIdToSelect: string) => {
      navigationIntentRef.current += 1;
      setTasksOpen(false);
      setKanbanOpen(false);
      setMemosOpen(false);
      kanbanReturnRef.current = false;
      if (notebookId !== notebookIdToSelect || view !== "all" || query) requestListTransition();
      searchOriginRef.current = null;
      setQuery("");
      setNotebookId(notebookIdToSelect);
      setView("all");
      setCardEditingNoteId(null);
      openMobileList({
        view: "all",
        notebookId: notebookIdToSelect,
        query: "",
        searchOrigin: null,
      });
    },
    [openMobileList, notebookId, query, requestListTransition, view],
  );
  const changeQuery = useCallback(
    (next: string) => {
      navigationIntentRef.current += 1;
      setTasksOpen(false);
      setKanbanOpen(false);
      setMemosOpen(false);
      kanbanReturnRef.current = false;
      if (next) {
        if (!query) {
          requestListTransition();
          searchOriginRef.current = { view, notebookId };
        }
        setQuery(next);
        setView("all");
        setNotebookId(undefined);
        openMobileList({
          view: "all",
          notebookId: undefined,
          query: next,
          searchOrigin: searchOriginRef.current,
        });
        return;
      }
      if (query) requestListTransition();
      const origin = searchOriginRef.current;
      searchOriginRef.current = null;
      setQuery("");
      setView(origin?.view ?? "all");
      setNotebookId(origin?.notebookId);
    },
    [notebookId, openMobileList, query, requestListTransition, view],
  );
  const handleQueryDraftChange = useCallback(
    (next: string) => {
      setQueryDraft(next);
      if (!next) changeQuery("");
    },
    [changeQuery],
  );
  const submitQuery = useCallback(() => {
    changeQuery(queryDraft.trim());
  }, [changeQuery, queryDraft]);
  return {
    selectView,
    openTasks,
    openKanban,
    openMemos,
    openKanbanNote,
    selectNotebook,
    changeQuery,
    handleQueryDraftChange,
    submitQuery,
  };
}
