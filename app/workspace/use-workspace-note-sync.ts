import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { Note, NoteSummary, NoteView } from "../../shared/types";
import { ApiError, api } from "../api";
import type { ConfirmRequest } from "./dialogs";
import { readMissingNoteDraft } from "./draft-recovery";
import {
  errorMessage,
  noteMetadataSnapshot,
  toNoteDraft,
  toNoteSummary,
  type NoteDraft,
} from "./helpers";
import { refreshSelectedNote } from "./selected-note-sync";
import { isMissingNoteError, type SaveState } from "./use-note-save-queue";
import type { MobileListContext } from "./use-mobile-navigation";

export type UseWorkspaceNoteSyncOptions = {
  ready: boolean;
  initialLinkedNoteId: string | null;
  pendingLinkedNoteRef: MutableRefObject<string | null>;
  selectedRef: MutableRefObject<Note | null>;
  activeNoteIdRef: MutableRefObject<string | null>;
  noteAbortRef: MutableRefObject<AbortController | null>;
  noteOpeningRef: MutableRefObject<Promise<void> | null>;
  noteLoadRequestRef: MutableRefObject<number>;
  splitSelectedRef: MutableRefObject<Note | null>;
  splitNoteIdRef: MutableRefObject<string | null>;
  splitAbortRef: MutableRefObject<AbortController | null>;
  splitNoteOpeningRef: MutableRefObject<Promise<void> | null>;
  splitLoadRequestRef: MutableRefObject<number>;
  pendingSavesRef: MutableRefObject<Map<string, NoteDraft>>;
  failedSavesRef: MutableRefObject<Map<string, unknown>>;
  editorMarkdownDirtyNoteRef: MutableRefObject<string | null>;
  splitMarkdownDirtyNoteRef: MutableRefObject<string | null>;
  notesRef: MutableRefObject<NoteSummary[]>;
  replaceList: (notes: NoteSummary[]) => void;
  setSelectedNote: (note: Note | null) => void;
  setSplitSelectedNote: (note: Note | null) => void;
  setNoteReloadToken: Dispatch<SetStateAction<number>>;
  setSplitNoteReloadToken: Dispatch<SetStateAction<number>>;
  setSaveState: Dispatch<SetStateAction<SaveState>>;
  setSplitSaveState: Dispatch<SetStateAction<SaveState>>;
  setIsNoteLoading: Dispatch<SetStateAction<boolean>>;
  setView: Dispatch<SetStateAction<NoteView>>;
  setNotebookId: Dispatch<SetStateAction<string | undefined>>;
  setQuery: (next: string) => void;
  setCardEditingNoteId: Dispatch<SetStateAction<string | null>>;
  selectNote: (id: string | null) => void;
  openMobileNote: (context: MobileListContext) => void;
  closeSplitRef: MutableRefObject<() => void>;
  markNoteMissing: (noteId: string, reason: ApiError) => void;
  clearPendingForNote: (noteId: string, savedDraft?: NoteDraft) => void;
  removeFromList: (noteId: string) => void;
  invalidateCollections: () => void;
  reloadNotes: () => void;
  requestConfirm: (request: Omit<ConfirmRequest, "id">) => void;
  notifyWarning: (message: string) => void;
  notifyError: (message: string) => void;
  navigate: (to: string, options?: { replace?: boolean }) => void;
};

export function useWorkspaceNoteSync({
  ready,
  initialLinkedNoteId,
  pendingLinkedNoteRef,
  selectedRef,
  activeNoteIdRef,
  noteAbortRef,
  noteOpeningRef,
  noteLoadRequestRef,
  splitSelectedRef,
  splitNoteIdRef,
  splitAbortRef,
  splitNoteOpeningRef,
  splitLoadRequestRef,
  pendingSavesRef,
  failedSavesRef,
  editorMarkdownDirtyNoteRef,
  splitMarkdownDirtyNoteRef,
  notesRef,
  replaceList,
  setSelectedNote,
  setSplitSelectedNote,
  setNoteReloadToken,
  setSplitNoteReloadToken,
  setSaveState,
  setSplitSaveState,
  setIsNoteLoading,
  setView,
  setNotebookId,
  setQuery,
  setCardEditingNoteId,
  selectNote,
  openMobileNote,
  closeSplitRef,
  markNoteMissing,
  clearPendingForNote,
  removeFromList,
  invalidateCollections,
  reloadNotes,
  requestConfirm,
  notifyWarning,
  notifyError,
  navigate,
}: UseWorkspaceNoteSyncOptions) {
  const deepLinkActionsRef = useRef({
    invalidateCollections,
    markNoteMissing,
    notifyError,
    openMobileNote,
    reloadNotes,
    selectNote,
  });
  deepLinkActionsRef.current = {
    invalidateCollections,
    markNoteMissing,
    notifyError,
    openMobileNote,
    reloadNotes,
    selectNote,
  };

  useEffect(() => {
    if (!ready || !initialLinkedNoteId || !pendingLinkedNoteRef.current) return;
    const controller = new AbortController();
    // Consume the link before creating page entries so returning to the list
    // and refreshing does not reopen the linked note.
    const linkedUrl = new URL(window.location.href);
    linkedUrl.searchParams.delete("note");
    window.history.replaceState(
      window.history.state,
      "",
      `${linkedUrl.pathname}${linkedUrl.search}${linkedUrl.hash}`,
    );
    void api
      .getNote(initialLinkedNoteId, { signal: controller.signal })
      .catch(async (error) => {
        if (!isMissingNoteError(error) || controller.signal.aborted) throw error;
        const note = await readMissingNoteDraft(initialLinkedNoteId);
        if (!note || controller.signal.aborted) throw error;
        pendingSavesRef.current.set(note.id, toNoteDraft(note));
        deepLinkActionsRef.current.markNoteMissing(note.id, error);
        return { note };
      })
      .then(({ note }) => {
        if (controller.signal.aborted) return;
        deepLinkActionsRef.current.invalidateCollections();
        selectedRef.current = note;
        setSelectedNote(noteMetadataSnapshot(note));
        setView(note.deletedAt !== null ? "trash" : "all");
        setNotebookId(note.deletedAt !== null ? undefined : note.notebookId);
        setQuery("");
        deepLinkActionsRef.current.selectNote(note.id);
        setCardEditingNoteId(note.id);
        deepLinkActionsRef.current.openMobileNote({
          view: note.deletedAt !== null ? "trash" : "all",
          notebookId: note.deletedAt !== null ? undefined : note.notebookId,
          query: "",
          noteId: note.id,
          searchOrigin: null,
        });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          deepLinkActionsRef.current.notifyError(errorMessage(error, "无法打开链接中的笔记"));
      })
      .finally(() => {
        if (controller.signal.aborted) return;
        pendingLinkedNoteRef.current = null;
        const url = new URL(window.location.href);
        url.searchParams.delete("note");
        window.history.replaceState(
          window.history.state,
          "",
          `${url.pathname}${url.search}${url.hash}`,
        );
        deepLinkActionsRef.current.reloadNotes();
      });
    return () => controller.abort();
  }, [
    initialLinkedNoteId,
    pendingLinkedNoteRef,
    pendingSavesRef,
    ready,
    selectedRef,
    setCardEditingNoteId,
    setNotebookId,
    setQuery,
    setSelectedNote,
    setView,
  ]);

  const refreshSelectedNoteFromRemote = useCallback(
    (noteId: string) =>
      refreshSelectedNote(noteId, {
        selectedRef,
        activeNoteIdRef,
        noteAbortRef,
        noteOpeningRef,
        noteLoadRequestRef,
        hasPendingWork: (id) =>
          pendingSavesRef.current.has(id) ||
          failedSavesRef.current.has(id) ||
          editorMarkdownDirtyNoteRef.current === id,
        onConflict: () => {
          setSaveState("conflict");
          notifyWarning("当前笔记已在其他设备更新，请先保存或重新载入");
        },
        onMissingWithDraft: markNoteMissing,
        onUpdated: (note, reloadEditor = true) => {
          setSelectedNote(noteMetadataSnapshot(note));
          replaceList(
            notesRef.current.map((n) => (n.id === noteId ? { ...n, ...toNoteSummary(note) } : n)),
          );
          if (reloadEditor) {
            setNoteReloadToken((value) => value + 1);
            setSaveState("idle");
          }
        },
        onUnauthorized: () => navigate(`/login${window.location.search}`, { replace: true }),
        onNotFound: (id) => {
          if (notesRef.current.some((note) => note.id === id)) removeFromList(id);
          else if (activeNoteIdRef.current === id) selectNote(null);
        },
        onError: () => notifyError("同步当前笔记失败，请稍后重试"),
      }),
    [
      activeNoteIdRef,
      editorMarkdownDirtyNoteRef,
      failedSavesRef,
      markNoteMissing,
      navigate,
      noteAbortRef,
      noteLoadRequestRef,
      noteOpeningRef,
      notesRef,
      notifyError,
      notifyWarning,
      pendingSavesRef,
      removeFromList,
      replaceList,
      selectNote,
      selectedRef,
      setNoteReloadToken,
      setSaveState,
      setSelectedNote,
    ],
  );

  const refreshSplitNoteFromRemote = useCallback(
    (noteId: string) =>
      refreshSelectedNote(noteId, {
        selectedRef: splitSelectedRef,
        activeNoteIdRef: splitNoteIdRef,
        noteAbortRef: splitAbortRef,
        noteOpeningRef: splitNoteOpeningRef,
        noteLoadRequestRef: splitLoadRequestRef,
        hasPendingWork: (id) =>
          pendingSavesRef.current.has(id) ||
          failedSavesRef.current.has(id) ||
          splitMarkdownDirtyNoteRef.current === id,
        onConflict: () => {
          setSplitSaveState("conflict");
          notifyWarning("分栏中的笔记已在其他设备更新，请先保存或重新载入");
        },
        onMissingWithDraft: markNoteMissing,
        onUpdated: (note, reloadEditor = true) => {
          setSplitSelectedNote(noteMetadataSnapshot(note));
          replaceList(
            notesRef.current.map((n) => (n.id === noteId ? { ...n, ...toNoteSummary(note) } : n)),
          );
          if (reloadEditor) {
            setSplitNoteReloadToken((value) => value + 1);
            setSplitSaveState("idle");
          }
        },
        onUnauthorized: () => navigate(`/login${window.location.search}`, { replace: true }),
        onNotFound: () => {
          if (splitNoteIdRef.current === noteId) closeSplitRef.current();
        },
        onError: () => notifyError("同步分栏笔记失败，请稍后重试"),
      }),
    [
      closeSplitRef,
      failedSavesRef,
      markNoteMissing,
      navigate,
      notesRef,
      notifyError,
      notifyWarning,
      pendingSavesRef,
      replaceList,
      setSplitNoteReloadToken,
      setSplitSaveState,
      setSplitSelectedNote,
      splitAbortRef,
      splitLoadRequestRef,
      splitMarkdownDirtyNoteRef,
      splitNoteIdRef,
      splitNoteOpeningRef,
      splitSelectedRef,
    ],
  );

  const reloadSelectedNote = useCallback(async () => {
    const current = selectedRef.current;
    if (!current) return;
    setIsNoteLoading(true);
    try {
      const result = await api.getNote(current.id);
      if (selectedRef.current?.id !== result.note.id) return;
      clearPendingForNote(current.id);
      selectedRef.current = result.note;
      setSelectedNote(noteMetadataSnapshot(result.note));
      setNoteReloadToken((value) => value + 1);
      setSaveState("idle");
    } catch {
      notifyError("重新载入失败，请重试");
    } finally {
      setIsNoteLoading(false);
    }
  }, [
    clearPendingForNote,
    notifyError,
    selectedRef,
    setIsNoteLoading,
    setNoteReloadToken,
    setSaveState,
    setSelectedNote,
  ]);

  const requestConflictReload = useCallback(() => {
    requestConfirm({
      eyebrow: "版本冲突",
      title: "重新载入最新版本？",
      description:
        "这篇笔记已在别处更新。重新载入会使用服务器上的最新内容替换当前编辑，本地尚未保存的修改将丢失。",
      confirmLabel: "重新载入",
      onConfirm: () => void reloadSelectedNote(),
    });
  }, [reloadSelectedNote, requestConfirm]);

  return {
    refreshSelectedNoteFromRemote,
    refreshSplitNoteFromRemote,
    reloadSelectedNote,
    requestConflictReload,
  };
}
