import { useCallback, useEffect, type Dispatch, type SetStateAction } from "react";
import type { Note, NoteSummary, Notebook } from "../../shared/types";
import { ApiError, api } from "../api";
import { readDraftRecovery, readMissingNoteDraft } from "./draft-recovery";
import { latestSelectedNoteSnapshot } from "./selected-note-sync";
import { noteMetadataSnapshot, toNoteDraft } from "./helpers";
import type { ConfirmRequest } from "./dialogs";
import {
  isMissingNoteError,
  noteSaveFailureState,
  type useNoteSaveQueue,
  type SaveState,
} from "./use-note-save-queue";
import type { ViewLayout } from "./use-workspace-preferences";

type Ref<T> = { current: T };
type Setter<T> = Dispatch<SetStateAction<T>>;
type Queue = ReturnType<typeof useNoteSaveQueue>;
type SearchResult = { id: string; query: string; token: number } | null;

type Options = {
  ready: boolean;
  splitNoteId: string | null;
  splitNoteIdRef: Ref<string | null>;
  splitSelectedRef: Ref<Note | null>;
  splitLoadRequestRef: Ref<number>;
  splitNoteOpeningRef: Ref<Promise<void> | null>;
  splitAbortRef: Ref<AbortController | null>;
  splitMarkdownReaderRef: Ref<((noteId: string) => string | null) | null>;
  closeSplitRef: Ref<() => void>;
  pendingSavesRef: Queue["pendingSavesRef"];
  failedSavesRef: Queue["failedSavesRef"];
  markNoteMissing: Queue["markNoteMissing"];
  clearPendingForNote: Queue["clearPendingForNote"];
  persistRef: Ref<Queue["persist"]>;
  persist: Queue["persist"];
  trashOperationsRef: Ref<Set<string>>;
  notesRef: Ref<NoteSummary[]>;
  notebooks: Notebook[];
  setSplitIsNoteLoading: Setter<boolean>;
  setSplitSaveState: Setter<SaveState>;
  setSplitNoteId: Setter<string | null>;
  setSplitSelectedNote: Setter<Note | null>;
  setSplitNoteReloadToken: Setter<number>;
  setActivePane: Setter<"primary" | "secondary">;
  setResultSearch: Setter<SearchResult>;
  requestConfirm: (request: Omit<ConfirmRequest, "id">) => void;
  notifyWarning: (message: string) => void;
  isMobileViewport: boolean;
  viewLayout: ViewLayout;
  cardEditingNoteId: string | null;
  selectedId: string | null;
  setCardEditingNoteId: Setter<string | null>;
  selectNote: (id: string | null) => void;
  setSplitPickerOpen: Setter<boolean>;
  setEditorFocusNoteId: Setter<string | null>;
  setSidebarCollapsed: Setter<boolean>;
  replaceList: (notes: NoteSummary[]) => void;
};

export function useWorkspaceSplit({
  ready,
  splitNoteId,
  splitNoteIdRef,
  splitSelectedRef,
  splitLoadRequestRef,
  splitNoteOpeningRef,
  splitAbortRef,
  splitMarkdownReaderRef,
  closeSplitRef,
  pendingSavesRef,
  failedSavesRef,
  markNoteMissing,
  clearPendingForNote,
  persistRef,
  persist,
  trashOperationsRef,
  notesRef,
  notebooks,
  setSplitIsNoteLoading,
  setSplitSaveState,
  setSplitNoteId,
  setSplitSelectedNote,
  setSplitNoteReloadToken,
  setActivePane,
  setResultSearch,
  requestConfirm,
  notifyWarning,
  isMobileViewport,
  viewLayout,
  cardEditingNoteId,
  selectedId,
  setCardEditingNoteId,
  selectNote,
  setSplitPickerOpen,
  setEditorFocusNoteId,
  setSidebarCollapsed,
  replaceList,
}: Options) {
  const flushSecondaryDraft = useCallback(() => {
    const split = splitSelectedRef.current;
    if (split && !trashOperationsRef.current.has(split.id)) {
      const md = splitMarkdownReaderRef.current?.(split.id);
      if (md != null && md !== split.contentMarkdown) {
        const next = { ...split, contentMarkdown: md };
        splitSelectedRef.current = next;
        persistRef.current(next, ["contentMarkdown"]);
      }
    }
  }, []);

  const fetchSplitNote = useCallback(
    async (id: string, discardRecovery = false) => {
      if (splitNoteIdRef.current !== id) return;
      splitAbortRef.current?.abort();
      const controller = new AbortController();
      splitAbortRef.current = controller;
      splitLoadRequestRef.current += 1;
      const requestId = splitLoadRequestRef.current;
      setSplitIsNoteLoading(true);
      const pendingNote = pendingSavesRef.current.get(id);
      const failedSave = failedSavesRef.current.get(id);
      setSplitSaveState(
        failedSave ? noteSaveFailureState(failedSave) : pendingNote ? "saving" : "idle",
      );
      try {
        const result = await api.getNote(id, { signal: controller.signal });
        if (requestId !== splitLoadRequestRef.current || splitNoteIdRef.current !== id) return;
        let loadedNote = discardRecovery
          ? result.note
          : latestSelectedNoteSnapshot(result.note, splitSelectedRef.current);
        if (discardRecovery) {
          clearPendingForNote(id);
        } else if (!pendingNote && !pendingSavesRef.current.has(id)) {
          const recoveredDraft = await readDraftRecovery(id);
          if (requestId !== splitLoadRequestRef.current || splitNoteIdRef.current !== id) return;
          loadedNote = latestSelectedNoteSnapshot(loadedNote, splitSelectedRef.current);
          if (recoveredDraft && !pendingSavesRef.current.has(id)) {
            pendingSavesRef.current.set(id, recoveredDraft);
            if (recoveredDraft.version === loadedNote.version) {
              notifyWarning("已恢复一份未保存草稿");
            } else {
              failedSavesRef.current.set(
                id,
                new ApiError(409, "VERSION_CONFLICT", "恢复的草稿与服务器版本不同"),
              );
              setSplitSaveState("conflict");
              notifyWarning("已保留未保存草稿；服务器版本已变化，请先复制需要的修改再重新载入");
            }
          }
        }
        const latestPendingNote = pendingSavesRef.current.get(id);
        if (!discardRecovery)
          loadedNote = latestSelectedNoteSnapshot(loadedNote, splitSelectedRef.current);
        if (latestPendingNote) loadedNote = { ...loadedNote, ...latestPendingNote };
        if (splitSelectedRef.current?.id !== id) flushSecondaryDraft();
        splitSelectedRef.current = loadedNote;
        setSplitSelectedNote(noteMetadataSnapshot(loadedNote));
        setSplitIsNoteLoading(false);
        if (discardRecovery) {
          setSplitSaveState("idle");
          setSplitNoteReloadToken((value) => value + 1);
        }
        if (
          latestPendingNote &&
          !failedSavesRef.current.has(id) &&
          !trashOperationsRef.current.has(id)
        )
          persistRef.current(latestPendingNote);
      } catch (reason) {
        if (requestId !== splitLoadRequestRef.current) return;
        if (reason instanceof Error && reason.name === "AbortError") return;
        if (isMissingNoteError(reason)) {
          const draft = await readMissingNoteDraft(
            id,
            pendingSavesRef.current.get(id),
            splitSelectedRef.current,
          );
          if (requestId !== splitLoadRequestRef.current || splitNoteIdRef.current !== id) return;
          if (draft) {
            if (splitSelectedRef.current?.id !== id) flushSecondaryDraft();
            pendingSavesRef.current.set(id, toNoteDraft(draft));
            splitSelectedRef.current = draft;
            setSplitSelectedNote(noteMetadataSnapshot(draft));
            markNoteMissing(id, reason);
            setSplitIsNoteLoading(false);
            return;
          }
        }
        flushSecondaryDraft();
        setSplitIsNoteLoading(false);
        setSplitNoteId(null);
        setSplitSelectedNote(null);
        splitSelectedRef.current = null;
        setActivePane("primary");
      }
    },
    [
      clearPendingForNote,
      failedSavesRef,
      flushSecondaryDraft,
      markNoteMissing,
      notifyWarning,
      pendingSavesRef,
      setSplitSaveState,
    ],
  );
  const loadSplitNote = useCallback(
    async (id: string, discardRecovery = false) => {
      const opening = fetchSplitNote(id, discardRecovery);
      splitNoteOpeningRef.current = opening;
      try {
        await opening;
      } finally {
        if (splitNoteOpeningRef.current === opening) splitNoteOpeningRef.current = null;
      }
    },
    [fetchSplitNote, splitNoteOpeningRef],
  );
  const requestSplitConflictReload = useCallback(
    (noteId: string) => {
      if (splitSelectedRef.current?.id !== noteId) return;
      requestConfirm({
        eyebrow: "版本冲突",
        title: "重新载入最新版本？",
        description: "重新载入会使用服务器上的最新内容替换分栏中的内容，本地尚未保存的修改将丢失。",
        confirmLabel: "重新载入",
        onConfirm: () => void loadSplitNote(noteId, true),
      });
    },
    [loadSplitNote, requestConfirm],
  );

  useEffect(() => {
    if (!ready || !splitNoteId) {
      splitLoadRequestRef.current += 1;
      splitAbortRef.current?.abort();
      setSplitIsNoteLoading(false);
      setSplitSelectedNote(null);
      splitSelectedRef.current = null;
      setSplitSaveState("idle");
      return;
    }
    void loadSplitNote(splitNoteId);
  }, [loadSplitNote, ready, splitNoteId]);

  const closeSplit = useCallback(() => {
    flushSecondaryDraft();
    splitLoadRequestRef.current += 1;
    splitAbortRef.current?.abort();
    setResultSearch((current) => (current?.id === splitNoteIdRef.current ? null : current));
    setSplitNoteId(null);
    setSplitSelectedNote(null);
    splitSelectedRef.current = null;
    setSplitSaveState("idle");
    setActivePane("primary");
  }, [flushSecondaryDraft]);
  closeSplitRef.current = closeSplit;

  const openInSplit = useCallback(
    (noteId: string) => {
      if (isMobileViewport || viewLayout !== "cards") return;
      if (cardEditingNoteId === null) {
        if (selectedId && selectedId !== noteId) {
          setCardEditingNoteId(selectedId);
          if (splitNoteId && splitNoteId !== noteId) flushSecondaryDraft();
          setSplitNoteId(noteId);
          setActivePane("secondary");
          return;
        }
        selectNote(noteId);
        setCardEditingNoteId(noteId);
        setSplitPickerOpen(true);
        return;
      }
      if (noteId === selectedId) {
        setActivePane("primary");
        setEditorFocusNoteId(noteId);
        return;
      }
      if (noteId === splitNoteId) {
        setActivePane("secondary");
        return;
      }
      if (window.innerWidth < 1200) {
        setSidebarCollapsed(true);
      }
      if (splitNoteId && splitNoteId !== noteId) flushSecondaryDraft();
      setSplitNoteId(noteId);
      setActivePane("secondary");
    },
    [
      cardEditingNoteId,
      flushSecondaryDraft,
      isMobileViewport,
      selectNote,
      selectedId,
      splitNoteId,
      viewLayout,
    ],
  );

  const handleToggleSplit = useCallback(() => {
    if (splitNoteId) {
      closeSplit();
    } else {
      setSplitPickerOpen(true);
    }
  }, [closeSplit, splitNoteId]);

  const handleSelectSplitNote = useCallback(
    (noteId: string) => {
      setSplitPickerOpen(false);
      if (viewLayout !== "cards") return;
      if (cardEditingNoteId === null) {
        const primaryId = selectedId ?? noteId;
        setCardEditingNoteId(primaryId);
        if (primaryId === noteId) return;
      }
      if (noteId === selectedId) {
        setActivePane("primary");
        setEditorFocusNoteId(noteId);
        return;
      }
      if (window.innerWidth < 1200) {
        setSidebarCollapsed(true);
      }
      if (splitNoteId && splitNoteId !== noteId) flushSecondaryDraft();
      setSplitNoteId(noteId);
      setActivePane("secondary");
    },
    [cardEditingNoteId, flushSecondaryDraft, selectedId, splitNoteId, viewLayout],
  );

  const onSplitNoteChange = useCallback(
    (noteId: string, patch: { title?: string; contentMarkdown?: string; notebookId?: string }) => {
      const current = splitSelectedRef.current;
      if (!current || current.id !== noteId || trashOperationsRef.current.has(noteId)) return;
      if (
        (patch.title === undefined || patch.title === current.title) &&
        (patch.contentMarkdown === undefined ||
          patch.contentMarkdown === current.contentMarkdown) &&
        (patch.notebookId === undefined || patch.notebookId === current.notebookId)
      )
        return;
      const targetNotebook = patch.notebookId
        ? notebooks.find((nb) => nb.id === patch.notebookId)
        : undefined;
      const next = {
        ...current,
        ...patch,
        ...(targetNotebook ? { notebookName: targetNotebook.name } : {}),
      };
      splitSelectedRef.current = next;
      const contentOnlyChange =
        patch.contentMarkdown !== undefined &&
        patch.title === undefined &&
        patch.notebookId === undefined;
      if (!contentOnlyChange) {
        setSplitSelectedNote(noteMetadataSnapshot(next));
        const summaryPatch: Partial<NoteSummary> = {
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.notebookId !== undefined ? { notebookId: patch.notebookId } : {}),
          ...(targetNotebook ? { notebookName: targetNotebook.name } : {}),
        };
        replaceList(
          notesRef.current.map((note) =>
            note.id === current.id ? { ...note, ...summaryPatch } : note,
          ),
        );
      }
      persist(next, Object.keys(patch) as Array<"title" | "contentMarkdown" | "notebookId">);
    },
    [notebooks, persist, replaceList],
  );

  return {
    requestSplitConflictReload,
    flushSecondaryDraft,
    closeSplit,
    openInSplit,
    handleToggleSplit,
    handleSelectSplitNote,
    onSplitNoteChange,
  };
}
