import {
  useCallback,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { Note, NoteSummary, NoteView, Notebook } from "../../shared/types";
import { ApiError } from "../api";
import type { ConfirmRequest } from "./dialogs";
import { errorMessage, noteMetadataSnapshot, toNoteSummary, type NoteDraft } from "./helpers";
import { moveSelectedNotes } from "./move-selected-notes";
import { isMissingNoteError, type useNoteSaveQueue } from "./use-note-save-queue";

export type UseWorkspaceCollectionActionsOptions = {
  view: NoteView;
  notebookId: string | undefined;
  notebooks: Notebook[];
  kanbanOpen: boolean;
  tasksOpen: boolean;
  selectedRef: MutableRefObject<Note | null>;
  splitSelectedRef: MutableRefObject<Note | null>;
  activeNoteIdRef: MutableRefObject<string | null>;
  splitNoteIdRef: MutableRefObject<string | null>;
  listScopeRef: MutableRefObject<string>;
  trashOperationsRef: MutableRefObject<Set<string>>;
  pendingSavesRef: MutableRefObject<Map<string, NoteDraft>>;
  failedSavesRef: MutableRefObject<Map<string, unknown>>;
  flushEditorDraftRef: MutableRefObject<() => void>;
  searchOriginRef: MutableRefObject<{ view: NoteView; notebookId?: string } | null>;
  closeSplitRef: MutableRefObject<() => void>;
  setNotebooks: Dispatch<SetStateAction<Notebook[]>>;
  setNotebookId: Dispatch<SetStateAction<string | undefined>>;
  setView: Dispatch<SetStateAction<NoteView>>;
  setQuery: (next: string) => void;
  setTotalNotes: Dispatch<SetStateAction<number>>;
  setSelectedNote: (note: Note | null) => void;
  setEditingNotebook: Dispatch<SetStateAction<Notebook | null | undefined>>;
  setKanbanRefreshToken: Dispatch<SetStateAction<number>>;
  setTaskRefreshToken: Dispatch<SetStateAction<number>>;
  replaceList: (notes: NoteSummary[]) => void;
  removeFromList: (noteId: string) => void;
  removeManyFromList: (noteIds: string[]) => void;
  clearNoteSelection: () => void;
  requestListTransition: () => void;
  invalidateCollections: () => void;
  refreshNotebooks: () => Promise<void>;
  reloadNotes: () => void;
  loadNotes: () => Promise<void>;
  refreshSelectedNoteFromRemote: (noteId: string) => Promise<void>;
  refreshSplitNoteFromRemote: (noteId: string) => Promise<void>;
  persist: (
    draft: Note | NoteDraft,
    changedFields?: Array<"title" | "contentMarkdown" | "notebookId" | "isFavorite" | "deleted">,
  ) => void;
  runSave: (noteId: string, keepalive?: boolean) => Promise<number | undefined>;
  saveImmediately: (
    draft: Note | NoteDraft,
    keepalive?: boolean,
    changedFields?: Array<"title" | "contentMarkdown" | "notebookId" | "isFavorite" | "deleted">,
  ) => Promise<number | undefined>;
  saveFavorite: (noteId: string, isFavorite: boolean) => Promise<void>;
  moveNoteToNotebook: (id: string, notebookId: string) => Promise<boolean>;
  deleteNotebookAndMoveNotes: ReturnType<typeof useNoteSaveQueue>["deleteNotebookAndMoveNotes"];
  clearPendingForNote: (noteId: string, savedDraft?: NoteDraft) => void;
  createRecoveredNote: (draft: NoteDraft) => Promise<Note>;
  revealCreatedNote: (note: Note, target: { view: NoteView; notebookId?: string }) => void;
  trashNotes: (ids: string[]) => Promise<void>;
  requestConfirm: (request: Omit<ConfirmRequest, "id">) => void;
  notifyInfo: (message: string) => void;
  notifyError: (message: string) => void;
};

export function useWorkspaceCollectionActions({
  view,
  notebookId,
  notebooks,
  kanbanOpen,
  tasksOpen,
  selectedRef,
  splitSelectedRef,
  activeNoteIdRef,
  splitNoteIdRef,
  listScopeRef,
  trashOperationsRef,
  pendingSavesRef,
  failedSavesRef,
  flushEditorDraftRef,
  searchOriginRef,
  closeSplitRef,
  setNotebooks,
  setNotebookId,
  setView,
  setQuery,
  setTotalNotes,
  setSelectedNote,
  setEditingNotebook,
  setKanbanRefreshToken,
  setTaskRefreshToken,
  replaceList,
  removeFromList,
  removeManyFromList,
  clearNoteSelection,
  requestListTransition,
  invalidateCollections,
  refreshNotebooks,
  reloadNotes,
  loadNotes,
  refreshSelectedNoteFromRemote,
  refreshSplitNoteFromRemote,
  persist,
  runSave,
  saveImmediately,
  saveFavorite,
  moveNoteToNotebook,
  deleteNotebookAndMoveNotes,
  clearPendingForNote,
  createRecoveredNote,
  revealCreatedNote,
  trashNotes,
  requestConfirm,
  notifyInfo,
  notifyError,
}: UseWorkspaceCollectionActionsOptions) {
  const movingNoteIdsRef = useRef(new Set<string>());

  const requestDraftRecovery = useCallback(
    (noteId: string) => {
      if (!isMissingNoteError(failedSavesRef.current.get(noteId))) return;
      requestConfirm({
        title: "另存为新笔记？",
        description: "原笔记已被永久删除。将此设备上的草稿保存为一篇新笔记。",
        confirmLabel: "另存为新笔记",
        onConfirm: async () => {
          flushEditorDraftRef.current();
          const draft = pendingSavesRef.current.get(noteId);
          if (!draft) throw new Error("找不到本地草稿");
          const saved = await createRecoveredNote(draft);
          if (splitNoteIdRef.current === noteId) closeSplitRef.current();
          revealCreatedNote(saved, { view: "all", notebookId: saved.notebookId });
          clearPendingForNote(noteId, draft);
          removeFromList(noteId);
          void refreshNotebooks();
          notifyInfo("草稿已另存为新笔记");
        },
      });
    },
    [
      clearPendingForNote,
      closeSplitRef,
      createRecoveredNote,
      failedSavesRef,
      flushEditorDraftRef,
      notifyInfo,
      pendingSavesRef,
      refreshNotebooks,
      removeFromList,
      requestConfirm,
      revealCreatedNote,
      splitNoteIdRef,
    ],
  );

  const deleteNotebook = useCallback(
    async (id: string) => {
      const target = notebooks.find((notebook) => notebook.id === id);
      if (!target || target.isSystem) throw new Error("无法删除此笔记本");
      const inbox = notebooks.find((notebook) => notebook.isSystem);
      if (!inbox) throw new Error("找不到收件箱");
      try {
        await deleteNotebookAndMoveNotes(id, target.totalCount, inbox);
      } catch (reason) {
        if (reason instanceof ApiError && reason.code === "NOTEBOOK_COUNT_MISMATCH")
          void refreshNotebooks();
        throw reason;
      }
      const activeNote = selectedRef.current;
      const splitNote = splitSelectedRef.current;
      await Promise.all([
        activeNote?.notebookId === id ? refreshSelectedNoteFromRemote(activeNote.id) : null,
        splitNote?.notebookId === id ? refreshSplitNoteFromRemote(splitNote.id) : null,
      ]);
      setNotebooks((current) => current.filter((notebook) => notebook.id !== id));
      if (notebookId === id) setNotebookId(undefined);
      void refreshNotebooks();
      void loadNotes();
      setEditingNotebook(undefined);
    },
    [
      deleteNotebookAndMoveNotes,
      loadNotes,
      notebookId,
      notebooks,
      refreshNotebooks,
      refreshSelectedNoteFromRemote,
      refreshSplitNoteFromRemote,
      selectedRef,
      splitSelectedRef,
      setEditingNotebook,
      setNotebookId,
      setNotebooks,
    ],
  );

  const toggleFavorite = useCallback(() => {
    const current = selectedRef.current;
    if (!current) return;
    const next = { ...current, isFavorite: !current.isFavorite };
    selectedRef.current = next;
    setSelectedNote(noteMetadataSnapshot(next));
    if (view !== "favorites" || next.isFavorite) {
      persist(next);
      return;
    }

    const scope = listScopeRef.current;
    void saveImmediately(next, false, ["isFavorite"])
      .then(() => {
        if (scope === listScopeRef.current) removeFromList(current.id);
      })
      .catch(() => undefined);
  }, [listScopeRef, persist, removeFromList, saveImmediately, selectedRef, setSelectedNote, view]);

  const handleToggleFavoriteNote = useCallback(
    async (target: NoteSummary) => {
      const isFavorite = !target.isFavorite;
      try {
        await saveFavorite(target.id, isFavorite);
        if (view === "favorites" && !isFavorite) removeFromList(target.id);
      } catch (reason) {
        notifyError(errorMessage(reason, "操作失败"));
      }
    },
    [notifyError, removeFromList, saveFavorite, view],
  );

  const handleMoveNotesToNotebook = useCallback(
    async (ids: string[], targetNotebookId: string, followNote = false) => {
      const movers = movingNoteIdsRef.current;
      const targets = [...new Set(ids)];
      if (!targets.length) return;
      if (targets.some((id) => movers.has(id) || trashOperationsRef.current.has(id))) {
        notifyInfo("正在处理这篇笔记，请稍后重试");
        return;
      }
      const target = notebooks.find((notebook) => notebook.id === targetNotebookId);
      if (!target) {
        notifyError("找不到目标笔记本");
        return;
      }

      const scope = listScopeRef.current;
      targets.forEach((id) => movers.add(id));
      try {
        const { movedIds, failures } = await moveSelectedNotes(targets, {
          flushEditorDraft: () => flushEditorDraftRef.current(),
          saveNote: runSave,
          moveNote: (id) => moveNoteToNotebook(id, target.id),
        });

        if (movedIds.length || failures.length) {
          invalidateCollections();
          void refreshNotebooks();
          reloadNotes();
          if (movedIds.length && kanbanOpen) setKanbanRefreshToken((value) => value + 1);
          if (movedIds.length && tasksOpen) setTaskRefreshToken((value) => value + 1);
        }
        if (scope === listScopeRef.current && movedIds.length) {
          const current = selectedRef.current;
          if (
            followNote &&
            current &&
            movedIds.includes(current.id) &&
            activeNoteIdRef.current === current.id
          ) {
            searchOriginRef.current = null;
            setQuery("");
            requestListTransition();
            setView(target.isSystem ? "inbox" : "all");
            setNotebookId(target.isSystem ? undefined : target.id);
            replaceList([toNoteSummary(current)]);
            setTotalNotes(target.count + 1);
          } else if (notebookId ? notebookId !== target.id : view === "inbox" && !target.isSystem) {
            removeManyFromList(movedIds);
          } else if (!failures.length) {
            clearNoteSelection();
          }
        }

        if (failures.length) {
          const message = errorMessage(failures[0], "移动笔记失败，请重试");
          notifyError(
            movedIds.length
              ? `已移动 ${movedIds.length} 篇，${failures.length} 篇未移动。${message}`
              : message,
          );
        } else if (movedIds.length) {
          notifyInfo(`已将 ${movedIds.length} 篇笔记移至「${target.name}」`);
        } else {
          notifyInfo(`笔记已在「${target.name}」`);
        }
      } finally {
        targets.forEach((id) => movers.delete(id));
      }
    },
    [
      activeNoteIdRef,
      clearNoteSelection,
      flushEditorDraftRef,
      invalidateCollections,
      kanbanOpen,
      listScopeRef,
      moveNoteToNotebook,
      notebookId,
      notebooks,
      notifyError,
      notifyInfo,
      refreshNotebooks,
      reloadNotes,
      removeManyFromList,
      replaceList,
      requestListTransition,
      runSave,
      searchOriginRef,
      selectedRef,
      setKanbanRefreshToken,
      setNotebookId,
      setQuery,
      setTaskRefreshToken,
      setTotalNotes,
      setView,
      tasksOpen,
      trashOperationsRef,
      view,
    ],
  );

  const handleTrashNotes = useCallback(
    async (ids: string[]) => {
      if (ids.some((id) => movingNoteIdsRef.current.has(id))) {
        notifyInfo("笔记正在移动，请稍后重试");
        return;
      }
      await trashNotes(ids);
    },
    [notifyInfo, trashNotes],
  );

  return {
    requestDraftRecovery,
    deleteNotebook,
    toggleFavorite,
    handleToggleFavoriteNote,
    handleMoveNotesToNotebook,
    handleTrashNotes,
  };
}
