import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { Note, NoteSummary, Notebook, NoteView } from "../../shared/types";
import { ApiError, api } from "../api";
import {
  errorMessage,
  preserveNewerNoteSummaries,
  shouldKeepActiveNoteInList,
  sortNotes,
  toNoteSummary,
  type NoteSort,
  type NoteUpdatedPosition,
} from "./helpers";

type Ref<T> = { current: T };
type Options = {
  view: NoteView;
  notebookId?: string;
  deferredQuery: string;
  noteSort: NoteSort;
  listScope: string;
  notebooks: Notebook[];
  notesReloadToken: number;
  pendingLinkedNoteRef: Ref<string | null>;
  nextNotesCursorRef: Ref<string | null>;
  listRequestRef: Ref<number>;
  listAbortRef: Ref<AbortController | null>;
  listScopeRef: Ref<string>;
  trashOperationsRef: Ref<Set<string>>;
  emptyingTrashRef: Ref<boolean>;
  selectedRef: Ref<Note | null>;
  selectedIdRef: Ref<string | null>;
  isMissingDraft: (noteId: string) => boolean;
  notesRef: Ref<NoteSummary[]>;
  setHasMoreNotes: Dispatch<SetStateAction<boolean>>;
  setTotalNotes: Dispatch<SetStateAction<number>>;
  setSelectedId: Dispatch<SetStateAction<string | null>>;
  setNotesReloadToken: Dispatch<SetStateAction<number>>;
  replaceList: (notes: NoteSummary[]) => void;
  pruneNoteSelectionTo: (ids: string[]) => void;
  playPendingListTransition: () => void;
  notifyError: (message: string) => void;
  navigate: (path: string, options?: { replace?: boolean }) => void;
};

export function useWorkspaceNoteList({
  view,
  notebookId,
  deferredQuery,
  noteSort,
  listScope,
  notebooks,
  notesReloadToken,
  pendingLinkedNoteRef,
  nextNotesCursorRef,
  listRequestRef,
  listAbortRef,
  listScopeRef,
  trashOperationsRef,
  emptyingTrashRef,
  selectedRef,
  selectedIdRef,
  isMissingDraft,
  notesRef,
  setHasMoreNotes,
  setTotalNotes,
  setSelectedId,
  setNotesReloadToken,
  replaceList,
  pruneNoteSelectionTo,
  playPendingListTransition,
  notifyError,
  navigate,
}: Options) {
  const updatedPageBoundaryRef = useRef<NoteUpdatedPosition | null>(null);
  const loadNotes = useCallback(async () => {
    if (pendingLinkedNoteRef.current) return;
    nextNotesCursorRef.current = null;
    setHasMoreNotes(false);
    const requestId = ++listRequestRef.current;
    listAbortRef.current?.abort();
    const controller = new AbortController();
    listAbortRef.current = controller;
    try {
      const result = await api.listNotes(
        {
          view,
          query: deferredQuery,
          notebookId,
          sort: noteSort,
          includeTotal: true,
        },
        { signal: controller.signal },
      );
      if (
        requestId !== listRequestRef.current ||
        listScope !== listScopeRef.current ||
        trashOperationsRef.current.size ||
        emptyingTrashRef.current
      )
        return;
      const active = selectedRef.current;
      const latestNotes = preserveNewerNoteSummaries(result.notes, notesRef.current).filter(
        (note) =>
          deferredQuery.trim() ||
          shouldKeepActiveNoteInList(note, notebooks, view, deferredQuery, notebookId),
      );
      const notesToDisplay =
        active &&
        !latestNotes.some((note) => note.id === active.id) &&
        (isMissingDraft(active.id) ||
          shouldKeepActiveNoteInList(active, notebooks, view, deferredQuery, notebookId))
          ? [toNoteSummary(active), ...latestNotes]
          : latestNotes;
      const orderedNotes =
        noteSort === "title" ? sortNotes(notesToDisplay, noteSort) : notesToDisplay;
      replaceList(orderedNotes);
      setTotalNotes(Math.max(result.total ?? 0, orderedNotes.length));
      setHasMoreNotes(Boolean(result.hasMore));
      nextNotesCursorRef.current = result.nextCursor ?? null;
      updatedPageBoundaryRef.current = result.notes.at(-1) ?? null;
      const currentSelectedId = selectedIdRef.current;
      const nextSelectedId =
        currentSelectedId && orderedNotes.some((note) => note.id === currentSelectedId)
          ? currentSelectedId
          : (orderedNotes[0]?.id ?? null);
      setSelectedId(nextSelectedId);
      pruneNoteSelectionTo(sortNotes(orderedNotes, noteSort).map((note) => note.id));
      playPendingListTransition();
    } catch (reason) {
      if (controller.signal.aborted || requestId !== listRequestRef.current) return;
      if (reason instanceof Error && reason.name === "AbortError") return;
      if (reason instanceof ApiError && reason.status === 401)
        navigate(`/login${window.location.search}`, { replace: true });
      else notifyError(errorMessage(reason, "加载笔记列表失败，请重试"));
    } finally {
      if (listAbortRef.current === controller) listAbortRef.current = null;
    }
  }, [
    deferredQuery,
    isMissingDraft,
    listScope,
    navigate,
    noteSort,
    notifyError,
    notebookId,
    notebooks,
    notesReloadToken,
    playPendingListTransition,
    replaceList,
    pruneNoteSelectionTo,
    view,
  ]);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const loadMoreInFlightRef = useRef(false);
  const loadMoreNotes = useCallback(async () => {
    const cursor = nextNotesCursorRef.current;
    if (loadMoreInFlightRef.current || !cursor) return;
    loadMoreInFlightRef.current = true;
    const requestId = listRequestRef.current;
    const scope = listScopeRef.current;
    setIsLoadingMore(true);
    try {
      const result = await api.listNotes({
        view,
        query: deferredQuery,
        notebookId,
        sort: noteSort,
        cursor,
        includeTotal: false,
      });
      if (
        requestId !== listRequestRef.current ||
        scope !== listScopeRef.current ||
        trashOperationsRef.current.size ||
        emptyingTrashRef.current
      )
        return;
      const currentList = notesRef.current;
      const existingIds = new Set(currentList.map((note) => note.id));
      const nextNotes = result.notes.filter((note) => !existingIds.has(note.id));
      const merged = [...currentList, ...nextNotes];
      replaceList(noteSort === "title" ? sortNotes(merged, noteSort) : merged);
      if (result.total !== undefined) setTotalNotes(Math.max(result.total, merged.length));
      setHasMoreNotes(Boolean(result.hasMore));
      nextNotesCursorRef.current = result.nextCursor ?? null;
      updatedPageBoundaryRef.current = result.notes.at(-1) ?? null;
    } catch {
      if (requestId !== listRequestRef.current || scope !== listScopeRef.current) return;
      notifyError("加载更多笔记失败，请重试");
    } finally {
      loadMoreInFlightRef.current = false;
      setIsLoadingMore(false);
    }
  }, [deferredQuery, noteSort, notebookId, replaceList, view]);
  const reloadNotes = useCallback(() => setNotesReloadToken((value) => value + 1), []);
  return { loadNotes, loadMoreNotes, isLoadingMore, reloadNotes, updatedPageBoundaryRef };
}
