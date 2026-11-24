import { useCallback, useEffect } from "react";
import type { Note } from "../../shared/types";
import { ApiError, api } from "../api";
import {
  clearDraftRecovery,
  noteMatchesDraft,
  readDraftRecovery,
  readMissingNoteDraft,
} from "./draft-recovery";
import { noteMetadataSnapshot, toNoteDraft, type NoteDraft } from "./helpers";
import { latestSelectedNoteSnapshot } from "./selected-note-sync";
import { isMissingNoteError, noteSaveFailureState, type SaveState } from "./use-note-save-queue";

export function useSelectedNoteLoader({
  ready,
  selectedId,
  selectedRef,
  activeNoteIdRef,
  noteLoadRequestRef,
  noteAbortRef,
  noteOpeningRef,
  pendingSavesRef,
  failedSavesRef,
  markNoteMissing,
  trashOperationsRef,
  persistRef,
  flushEditorDraftRef,
  setEditorFocusNoteId,
  setIsNoteLoading,
  setSaveState,
  setSelectedNote,
  setSelectedId,
  setCardEditingNoteId,
  notifyWarning,
  notifyError,
  navigate,
}: {
  ready: boolean;
  selectedId: string | null;
  selectedRef: React.MutableRefObject<Note | null>;
  activeNoteIdRef: React.MutableRefObject<string | null>;
  noteLoadRequestRef: React.MutableRefObject<number>;
  noteAbortRef: React.MutableRefObject<AbortController | null>;
  noteOpeningRef: React.MutableRefObject<Promise<void> | null>;
  pendingSavesRef: React.MutableRefObject<Map<string, NoteDraft>>;
  failedSavesRef: React.MutableRefObject<Map<string, unknown>>;
  markNoteMissing: (noteId: string, reason: ApiError) => void;
  trashOperationsRef: React.MutableRefObject<Set<string>>;
  persistRef: React.MutableRefObject<(note: Note | NoteDraft) => void>;
  flushEditorDraftRef: React.MutableRefObject<() => void>;
  setEditorFocusNoteId: React.Dispatch<React.SetStateAction<string | null>>;
  setIsNoteLoading: React.Dispatch<React.SetStateAction<boolean>>;
  setSaveState: React.Dispatch<React.SetStateAction<SaveState>>;
  setSelectedNote: (note: Note | null) => void;
  setSelectedId: React.Dispatch<React.SetStateAction<string | null>>;
  setCardEditingNoteId: React.Dispatch<React.SetStateAction<string | null>>;
  notifyWarning: (message: string) => void;
  notifyError: (message: string) => void;
  navigate: (path: string, options?: { replace?: boolean }) => void;
}) {
  const loadSelectedNote = useCallback(
    async (id: string) => {
      noteAbortRef.current?.abort();
      const controller = new AbortController();
      noteAbortRef.current = controller;
      setEditorFocusNoteId((current) => (current === id ? current : null));
      const requestId = ++noteLoadRequestRef.current;
      let previousNote = selectedRef.current;
      if (previousNote?.id !== id) {
        flushEditorDraftRef.current();
        previousNote = selectedRef.current;
      }
      const pendingNote = pendingSavesRef.current.get(id);
      const failedSave = failedSavesRef.current.get(id);
      activeNoteIdRef.current = id;
      setIsNoteLoading(true);
      setSaveState(failedSave ? noteSaveFailureState(failedSave) : pendingNote ? "saving" : "idle");
      try {
        const result = await api.getNote(id, { signal: controller.signal });
        if (requestId !== noteLoadRequestRef.current || activeNoteIdRef.current !== id) return;
        let loadedNote = latestSelectedNoteSnapshot(result.note, selectedRef.current);
        // The load can outlive a queued save; do not recover the same draft after
        // that save has already succeeded and started clearing its recovery copy.
        if (!pendingNote && !pendingSavesRef.current.has(id)) {
          const recoveredDraft = await readDraftRecovery(id);
          if (requestId !== noteLoadRequestRef.current || activeNoteIdRef.current !== id) return;
          loadedNote = latestSelectedNoteSnapshot(loadedNote, selectedRef.current);
          if (recoveredDraft && noteMatchesDraft(result.note, recoveredDraft)) {
            clearDraftRecovery(id, recoveredDraft);
          } else if (recoveredDraft && !pendingSavesRef.current.has(id)) {
            pendingSavesRef.current.set(id, recoveredDraft);
            if (recoveredDraft.version === loadedNote.version) {
              notifyWarning("已恢复一份未保存草稿");
            } else {
              failedSavesRef.current.set(
                id,
                new ApiError(409, "VERSION_CONFLICT", "恢复的草稿与服务器版本不同"),
              );
              setSaveState("conflict");
              notifyWarning("已保留未保存草稿；服务器版本已变化，请先复制需要的修改再重新载入");
            }
          }
        }
        const latestPendingNote = pendingSavesRef.current.get(id);
        loadedNote = latestSelectedNoteSnapshot(loadedNote, selectedRef.current);
        const nextNote = latestPendingNote ? { ...loadedNote, ...latestPendingNote } : loadedNote;
        if (selectedRef.current?.id !== id) flushEditorDraftRef.current();
        selectedRef.current = nextNote;
        setSelectedNote(noteMetadataSnapshot(nextNote));
        setIsNoteLoading(false);
        // A draft kept from an earlier failure or a note switch is retried instead of staying stuck on "saving".
        const retryDraft = latestPendingNote;
        if (retryDraft && !failedSavesRef.current.has(id) && !trashOperationsRef.current.has(id))
          persistRef.current(retryDraft);
      } catch (reason) {
        if (requestId !== noteLoadRequestRef.current || activeNoteIdRef.current !== id) return;
        if (reason instanceof Error && reason.name === "AbortError") return;
        if (isMissingNoteError(reason)) {
          const draft = await readMissingNoteDraft(
            id,
            pendingSavesRef.current.get(id),
            selectedRef.current,
          );
          if (requestId !== noteLoadRequestRef.current || activeNoteIdRef.current !== id) return;
          if (draft) {
            if (selectedRef.current?.id !== id) flushEditorDraftRef.current();
            pendingSavesRef.current.set(id, toNoteDraft(draft));
            selectedRef.current = draft;
            setSelectedNote(noteMetadataSnapshot(draft));
            markNoteMissing(id, reason);
            setIsNoteLoading(false);
            return;
          }
        }
        setIsNoteLoading(false);
        if (reason instanceof ApiError && reason.status === 401) {
          navigate(`/login${window.location.search}`, { replace: true });
          return;
        }
        if (previousNote) {
          const restoredNote = previousNote;
          const previousFailure = failedSavesRef.current.get(restoredNote.id);
          setSaveState(
            previousFailure
              ? noteSaveFailureState(previousFailure)
              : pendingSavesRef.current.has(restoredNote.id)
                ? "saving"
                : "idle",
          );
          activeNoteIdRef.current = restoredNote.id;
          selectedRef.current = restoredNote;
          setSelectedId(restoredNote.id);
          setSelectedNote(noteMetadataSnapshot(restoredNote));
          setCardEditingNoteId((current) => (current === id ? restoredNote.id : current));
        } else {
          activeNoteIdRef.current = null;
          selectedRef.current = null;
          setSelectedId(null);
          setSelectedNote(null);
        }
        notifyError("无法打开这篇笔记");
      } finally {
        if (noteAbortRef.current === controller) noteAbortRef.current = null;
      }
    },
    [
      activeNoteIdRef,
      failedSavesRef,
      flushEditorDraftRef,
      markNoteMissing,
      navigate,
      noteAbortRef,
      noteLoadRequestRef,
      notifyError,
      notifyWarning,
      pendingSavesRef,
      persistRef,
      selectedRef,
      setCardEditingNoteId,
      setEditorFocusNoteId,
      setIsNoteLoading,
      setSaveState,
      setSelectedId,
      setSelectedNote,
      trashOperationsRef,
    ],
  );

  useEffect(() => {
    if (!ready || !selectedId) {
      flushEditorDraftRef.current();
      noteAbortRef.current?.abort();
      noteOpeningRef.current = null;
      activeNoteIdRef.current = null;
      selectedRef.current = null;
      setIsNoteLoading(false);
      setSelectedNote(null);
      return;
    }
    const opening = loadSelectedNote(selectedId);
    noteOpeningRef.current = opening;
    void opening.finally(() => {
      if (noteOpeningRef.current === opening) noteOpeningRef.current = null;
    });
  }, [
    activeNoteIdRef,
    flushEditorDraftRef,
    loadSelectedNote,
    noteAbortRef,
    noteOpeningRef,
    ready,
    selectedId,
    selectedRef,
    setIsNoteLoading,
    setSelectedNote,
  ]);

  return loadSelectedNote;
}
