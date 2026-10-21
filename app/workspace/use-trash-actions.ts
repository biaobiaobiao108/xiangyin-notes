import { useCallback } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { Note, NoteSummary, NoteView, Notebook } from "../../shared/types";
import type { NoteSort, NoteDraft } from "./helpers";
import { errorMessage, sortNotes, toNoteDraft } from "./helpers";
import { ApiError, api } from "../api";
import type { ConfirmRequest } from "./dialogs";
import type { NoteSelectionState } from "./note-list-selection";
import type { NoteSwipeAction } from "./swipe-actions";
import type { useNoteSaveQueue } from "./use-note-save-queue";

type SaveQueue = ReturnType<typeof useNoteSaveQueue>;

type UseTrashActionsOptions = {
  state: {
    view: NoteView;
    noteSort: NoteSort;
    totalNotes: number;
    pendingTrashCount: number;
  };
  refs: {
    selectedRef: MutableRefObject<Note | null>;
    notesRef: MutableRefObject<NoteSummary[]>;
    noteSelectionRef: MutableRefObject<NoteSelectionState>;
    listScopeRef: MutableRefObject<string>;
    pendingSavesRef: MutableRefObject<Map<string, NoteDraft>>;
    trashOperationsRef: MutableRefObject<Set<string>>;
    emptyingTrashRef: MutableRefObject<boolean>;
    flushEditorDraftRef: MutableRefObject<() => void>;
  };
  saveQueue: Pick<SaveQueue, "runSave" | "saveImmediately" | "clearPendingForNote">;
  list: {
    invalidateCollections: () => void;
    removeFromList: (noteId: string) => void;
    removeManyFromList: (noteIds: string[]) => void;
    replaceList: (notes: NoteSummary[]) => void;
    selectNote: (noteId: string | null) => void;
    reloadNotes: () => void;
    refreshNotebooks: () => Promise<void>;
  };
  ui: {
    setPendingTrashCount: Dispatch<SetStateAction<number>>;
    setEmptyingTrash: Dispatch<SetStateAction<boolean>>;
    setNotebooks: Dispatch<SetStateAction<Notebook[]>>;
    requestConfirm: (request: Omit<ConfirmRequest, "id">) => void;
    notifyError: (message: string) => void;
  };
};

export function useTrashActions(options: UseTrashActionsOptions) {
  const { state, refs, saveQueue, list, ui } = options;
  const { view, noteSort, totalNotes, pendingTrashCount } = state;
  const {
    selectedRef,
    notesRef,
    noteSelectionRef,
    listScopeRef,
    pendingSavesRef,
    trashOperationsRef,
    emptyingTrashRef,
    flushEditorDraftRef,
  } = refs;
  const { runSave, saveImmediately, clearPendingForNote } = saveQueue;
  const { invalidateCollections, removeFromList, removeManyFromList, replaceList, selectNote, reloadNotes, refreshNotebooks } = list;
  const { setPendingTrashCount, setEmptyingTrash, setNotebooks, requestConfirm, notifyError } = ui;

  const finishTrashOperation = useCallback((noteId: string) => {
    trashOperationsRef.current.delete(noteId);
    setPendingTrashCount(trashOperationsRef.current.size);
    invalidateCollections();
    if (!trashOperationsRef.current.size) { void refreshNotebooks(); reloadNotes(); }
  }, [invalidateCollections, refreshNotebooks, reloadNotes, setPendingTrashCount, trashOperationsRef]);

  const changeDeletedState = useCallback(async (deleted: boolean) => {
    flushEditorDraftRef.current();
    const current = selectedRef.current;
    if (!current || Boolean(current.deletedAt) === deleted || trashOperationsRef.current.has(current.id) || emptyingTrashRef.current) return;
    const scope = listScopeRef.current;
    const next = { ...current, deletedAt: deleted ? Math.floor(Date.now() / 1000) : null };
    trashOperationsRef.current.add(current.id);
    setPendingTrashCount(trashOperationsRef.current.size);
    invalidateCollections();
    setNotebooks((items) => items.map((notebook) => notebook.id === current.notebookId ? { ...notebook, count: Math.max(0, notebook.count + (deleted ? -1 : 1)) } : notebook));
    try {
      await saveImmediately(next, false, ["deleted"]);
      if (scope === listScopeRef.current) removeFromList(current.id);
    } catch (reason) {
      pendingSavesRef.current.set(current.id, toNoteDraft(current));
      setNotebooks((items) => items.map((notebook) => notebook.id === current.notebookId ? { ...notebook, count: Math.max(0, notebook.count + (deleted ? 1 : -1)) } : notebook));
      notifyError(reason instanceof ApiError && reason.code === "VERSION_CONFLICT" ? "这篇笔记已在别处更新，操作未完成，本地草稿已保留" : errorMessage(reason, deleted ? "移入回收站失败，请重试" : "恢复笔记失败，请重试"));
    } finally { finishTrashOperation(current.id); }
  }, [emptyingTrashRef, finishTrashOperation, flushEditorDraftRef, invalidateCollections, listScopeRef, pendingSavesRef, removeFromList, saveImmediately, selectedRef, setNotebooks, setPendingTrashCount, trashOperationsRef, notifyError]);

  const moveToTrash = useCallback(() => { void changeDeletedState(true); }, [changeDeletedState]);
  const restoreFromTrash = useCallback(() => { void changeDeletedState(false); }, [changeDeletedState]);
  const discardNoteDraft = useCallback((noteId: string) => clearPendingForNote(noteId), [clearPendingForNote]);
  const getBatchEntries = useCallback((noteIds: string[]) => {
    const selected = new Set(noteIds);
    return sortNotes(notesRef.current, noteSort)
      .filter((note) => selected.has(note.id))
      .map((note) => ({ id: note.id, version: note.version }));
  }, [noteSort, notesRef]);

  const performBatchDelete = useCallback(async (noteIds: string[], permanent: boolean) => {
    flushEditorDraftRef.current();
    const ids = [...new Set(noteIds)];
    if (!ids.length) return;
    if (emptyingTrashRef.current || trashOperationsRef.current.size) throw new ApiError(409, "TRASH_BUSY", "回收站正在处理其他操作，请稍后重试");

    ids.forEach((id) => trashOperationsRef.current.add(id));
    setPendingTrashCount(trashOperationsRef.current.size);
    invalidateCollections();
    try {
      await Promise.all(ids.map((id) => runSave(id)));
      const entries = getBatchEntries(ids);
      if (entries.length !== ids.length) throw new ApiError(409, "NOTE_SELECTION_STALE", "选中的笔记已不在当前列表，请重新选择");
      const result = permanent ? await api.deleteNotes(entries) : await api.moveNotesToTrash(entries);
      for (const id of result.deletedIds) discardNoteDraft(id);
      removeManyFromList(result.deletedIds);
    } finally {
      ids.forEach((id) => trashOperationsRef.current.delete(id));
      setPendingTrashCount(trashOperationsRef.current.size);
      invalidateCollections();
      void refreshNotebooks();
      reloadNotes();
    }
  }, [discardNoteDraft, emptyingTrashRef, flushEditorDraftRef, getBatchEntries, invalidateCollections, refreshNotebooks, reloadNotes, removeManyFromList, runSave, setPendingTrashCount, trashOperationsRef]);

  const performBatchRestore = useCallback(async (noteIds: string[]) => {
    flushEditorDraftRef.current();
    const ids = [...new Set(noteIds)];
    if (!ids.length) return;
    if (emptyingTrashRef.current || trashOperationsRef.current.size) throw new ApiError(409, "TRASH_BUSY", "回收站正在处理其他操作，请稍后重试");

    ids.forEach((id) => trashOperationsRef.current.add(id));
    setPendingTrashCount(trashOperationsRef.current.size);
    invalidateCollections();
    try {
      await Promise.all(ids.map((id) => runSave(id)));
      const entries = getBatchEntries(ids);
      if (entries.length !== ids.length) throw new ApiError(409, "NOTE_SELECTION_STALE", "选中的笔记已不在当前列表，请重新选择");
      const result = await api.restoreNotes(entries);
      for (const id of result.restoredIds) discardNoteDraft(id);
      removeManyFromList(result.restoredIds);
    } finally {
      ids.forEach((id) => trashOperationsRef.current.delete(id));
      setPendingTrashCount(trashOperationsRef.current.size);
      invalidateCollections();
      void refreshNotebooks();
      reloadNotes();
    }
  }, [discardNoteDraft, emptyingTrashRef, flushEditorDraftRef, getBatchEntries, invalidateCollections, refreshNotebooks, reloadNotes, removeManyFromList, runSave, setPendingTrashCount, trashOperationsRef]);

  const showBatchDeleteError = useCallback((reason: unknown) => {
    notifyError(reason instanceof ApiError && reason.code === "VERSION_CONFLICT" ? "选中的笔记已发生变化，请重新选择后重试" : errorMessage(reason, "批量删除失败，请重试"));
  }, [notifyError]);
  const showBatchRestoreError = useCallback((reason: unknown) => {
    notifyError(reason instanceof ApiError && reason.code === "VERSION_CONFLICT" ? "选中的笔记已发生变化，请重新选择后重试" : errorMessage(reason, "批量恢复失败，请重试"));
  }, [notifyError]);

  const deleteSelectedNotes = useCallback(() => {
    const ids = [...noteSelectionRef.current.ids];
    if (!ids.length || pendingTrashCount > 0 || emptyingTrashRef.current) return;
    if (view === "trash") {
      requestConfirm({
        eyebrow: "不可撤销",
        title: `彻底删除 ${ids.length} 篇笔记？`,
        description: "这些笔记会从数据库永久移除，回收站不再保留。",
        confirmLabel: "彻底删除",
        danger: true,
        onConfirm: () => performBatchDelete(ids, true),
      });
      return;
    }
    void performBatchDelete(ids, false).catch(showBatchDeleteError);
  }, [emptyingTrashRef, noteSelectionRef, pendingTrashCount, performBatchDelete, requestConfirm, showBatchDeleteError, view]);

  const restoreSelectedNotes = useCallback(() => {
    const ids = [...noteSelectionRef.current.ids];
    if (view !== "trash" || ids.length < 2 || pendingTrashCount > 0 || emptyingTrashRef.current) return;
    void performBatchRestore(ids).catch(showBatchRestoreError);
  }, [emptyingTrashRef, noteSelectionRef, pendingTrashCount, performBatchRestore, showBatchRestoreError, view]);

  const performPermanentDelete = useCallback(async (noteId: string, expectedVersion: number) => {
    if (trashOperationsRef.current.has(noteId) || emptyingTrashRef.current) throw new ApiError(409, "TRASH_BUSY", "回收站正在处理其他操作，请稍后重试");
    flushEditorDraftRef.current();
    trashOperationsRef.current.add(noteId);
    setPendingTrashCount(trashOperationsRef.current.size);
    invalidateCollections();
    try {
      const savedVersion = await runSave(noteId);
      await api.deleteNote(noteId, savedVersion ?? expectedVersion);
      removeFromList(noteId);
      discardNoteDraft(noteId);
    } finally { finishTrashOperation(noteId); }
  }, [discardNoteDraft, emptyingTrashRef, finishTrashOperation, flushEditorDraftRef, invalidateCollections, removeFromList, runSave, setPendingTrashCount, trashOperationsRef]);

  const permanentDeleteNote = useCallback(async () => {
    flushEditorDraftRef.current();
    const current = selectedRef.current;
    if (!current) return;
    requestConfirm({
      eyebrow: "不可撤销",
      title: `彻底删除“${current.title.trim() || "未命名笔记"}”？`,
      description: "这篇笔记会从数据库中永久移除，回收站不再保留。",
      confirmLabel: "彻底删除",
      danger: true,
      onConfirm: () => performPermanentDelete(current.id, current.version),
    });
  }, [flushEditorDraftRef, performPermanentDelete, requestConfirm, selectedRef]);

  const restoreNoteFromList = useCallback(async (noteId: string) => {
    if (emptyingTrashRef.current || trashOperationsRef.current.size > 0) throw new ApiError(409, "TRASH_BUSY", "回收站正在处理其他操作，请稍后重试");
    flushEditorDraftRef.current();
    trashOperationsRef.current.add(noteId);
    setPendingTrashCount(trashOperationsRef.current.size);
    invalidateCollections();
    try {
      await runSave(noteId);
      const current = notesRef.current.find((note) => note.id === noteId);
      if (!current || !current.deletedAt) throw new ApiError(409, "NOTE_SELECTION_STALE", "这篇笔记已不在回收站，请刷新后重试");
      await api.updateNote(noteId, { version: current.version, deleted: false }, { response: "summary" });
      removeFromList(noteId);
      discardNoteDraft(noteId);
    } finally { finishTrashOperation(noteId); }
  }, [discardNoteDraft, emptyingTrashRef, finishTrashOperation, flushEditorDraftRef, invalidateCollections, notesRef, removeFromList, runSave, setPendingTrashCount, trashOperationsRef]);

  const handleNoteSwipeAction = useCallback((note: NoteSummary, action: NoteSwipeAction) => {
    if (pendingTrashCount > 0 || emptyingTrashRef.current) return;
    if (action === "trash") {
      void performBatchDelete([note.id], false).catch(showBatchDeleteError);
    } else if (action === "restore") {
      void restoreNoteFromList(note.id).catch((reason) => notifyError(reason instanceof ApiError && reason.code === "VERSION_CONFLICT" ? "这篇笔记已在别处更新，恢复未完成，请刷新后重试" : errorMessage(reason, "恢复笔记失败，请重试")));
    } else {
      requestConfirm({
        eyebrow: "不可撤销",
        title: `彻底删除“${note.title.trim() || "未命名笔记"}”？`,
        description: "这篇笔记会从数据库中永久移除，回收站不再保留。",
        confirmLabel: "彻底删除",
        danger: true,
        onConfirm: () => performPermanentDelete(note.id, note.version),
      });
    }
  }, [emptyingTrashRef, notifyError, pendingTrashCount, performBatchDelete, performPermanentDelete, requestConfirm, restoreNoteFromList, showBatchDeleteError]);

  const performEmptyTrash = useCallback(async () => {
    if (emptyingTrashRef.current || trashOperationsRef.current.size) throw new ApiError(409, "TRASH_BUSY", "回收站正在处理其他操作，请稍后重试");
    flushEditorDraftRef.current();
    const scope = listScopeRef.current;
    const pendingTrash = [...pendingSavesRef.current.values()].filter((note) => note.deletedAt);
    const localTrashIds = new Set([
      ...pendingTrash.map((note) => note.id),
      ...notesRef.current.filter((note) => note.deletedAt).map((note) => note.id),
      ...(selectedRef.current?.deletedAt ? [selectedRef.current.id] : []),
    ]);
    emptyingTrashRef.current = true;
    setEmptyingTrash(true);
    invalidateCollections();
    try {
      await Promise.all(pendingTrash.map((note) => runSave(note.id)));
      await api.emptyTrash();
      for (const id of localTrashIds) discardNoteDraft(id);
      if (scope === listScopeRef.current) { replaceList([]); selectNote(null); }
    } finally {
      emptyingTrashRef.current = false;
      setEmptyingTrash(false);
      invalidateCollections();
      void refreshNotebooks();
      reloadNotes();
    }
  }, [discardNoteDraft, emptyingTrashRef, flushEditorDraftRef, invalidateCollections, listScopeRef, notesRef, pendingSavesRef, refreshNotebooks, reloadNotes, replaceList, runSave, selectNote, selectedRef, setEmptyingTrash, trashOperationsRef]);

  const emptyTrash = useCallback(() => {
    if (!totalNotes || pendingTrashCount || emptyingTrashRef.current) return;
    requestConfirm({
      eyebrow: "不可撤销",
      title: "清空回收站？",
      description: `将永久删除回收站中的全部笔记（当前共 ${totalNotes} 篇），包括列表尚未显示的笔记。删除后无法恢复。`,
      confirmLabel: "清空回收站",
      danger: true,
      onConfirm: performEmptyTrash,
    });
  }, [emptyingTrashRef, pendingTrashCount, performEmptyTrash, requestConfirm, totalNotes]);

  return { moveToTrash, restoreFromTrash, deleteSelectedNotes, restoreSelectedNotes, permanentDeleteNote, handleNoteSwipeAction, emptyTrash };
}
