import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { NoteSummary, Notebook, NoteView } from "../../shared/types";
import { ApiError, api } from "../api";
import {
  mergeRemoteSummary,
  shouldKeepActiveNoteInList,
  sortNotes,
  type NoteSort,
} from "./helpers";
type Ref<T> = { current: T };
type Setter<T> = Dispatch<SetStateAction<T>>;

function focusNoteRowAfterRemoval(noteId: string) {
  requestAnimationFrame(() => {
    const row = document.querySelector<HTMLButtonElement>(
      `[data-note-id="${CSS.escape(noteId)}"] .note-row`,
    );
    if (row) {
      row.focus();
      return;
    }
    document.getElementById("note-list-scroll-region")?.focus();
  });
}

export function useWorkspaceListChanges({
  notesRef,
  noteSort,
  replaceList,
  setTotalNotes,
  activeNoteIdRef,
  selectNote,
  setCardEditingNoteId,
  splitNoteIdRef,
  closeSplitRef,
  listScopeRef,
  notebooks,
  view,
  deferredQuery,
  notebookId,
  clearNoteSelection,
}: {
  notesRef: Ref<NoteSummary[]>;
  noteSort: NoteSort;
  replaceList: (notes: NoteSummary[]) => void;
  setTotalNotes: Setter<number>;
  activeNoteIdRef: Ref<string | null>;
  selectNote: (id: string | null) => void;
  setCardEditingNoteId: Setter<string | null>;
  splitNoteIdRef: Ref<string | null>;
  closeSplitRef: Ref<() => void>;
  listScopeRef: Ref<string>;
  notebooks: Notebook[];
  view: NoteView;
  deferredQuery: string;
  notebookId?: string;
  clearNoteSelection: () => void;
}) {
  const removeFromList = useCallback(
    (noteId: string) => {
      const restoreFocus =
        document.activeElement instanceof Element &&
        Boolean(document.activeElement.closest(".note-list-panel"));
      const ordered = sortNotes(notesRef.current, noteSort);
      const index = ordered.findIndex((note) => note.id === noteId);
      if (index === -1) return;
      replaceList(notesRef.current.filter((note) => note.id !== noteId));
      setTotalNotes((value) => Math.max(0, value - 1));
      if (activeNoteIdRef.current === noteId) {
        const nextId = ordered[index + 1]?.id ?? ordered[index - 1]?.id ?? null;
        selectNote(nextId);
        setCardEditingNoteId((current) => (current === noteId ? nextId : current));
        if (restoreFocus && nextId) focusNoteRowAfterRemoval(nextId);
      }
      if (splitNoteIdRef.current === noteId) {
        closeSplitRef.current();
      }
    },
    [noteSort, replaceList, selectNote],
  );
  // Realtime updates for a single note refresh only that row, so a remote save
  // never collapses the loaded pages back to the first page.
  const patchNoteFromRemote = useCallback(
    async (noteId: string) => {
      const scope = listScopeRef.current;
      if (!notesRef.current.some((note) => note.id === noteId)) return;
      try {
        const summary = (await api.getNoteSummary(noteId)).note;
        if (scope !== listScopeRef.current) return;
        const current = notesRef.current.find((note) => note.id === noteId);
        if (!current || current.version > summary.version) return;
        if (!shouldKeepActiveNoteInList(summary, notebooks, view, deferredQuery, notebookId)) {
          removeFromList(noteId);
          return;
        }
        const merged = mergeRemoteSummary(notesRef.current, summary, noteSort);
        if (merged) replaceList(merged);
      } catch (reason) {
        if (scope !== listScopeRef.current) return;
        if (reason instanceof ApiError && reason.status === 404) removeFromList(noteId);
      }
    },
    [deferredQuery, noteSort, notebookId, notebooks, removeFromList, replaceList, view],
  );
  const removeManyFromList = useCallback(
    (noteIds: string[]) => {
      const restoreFocus =
        document.activeElement instanceof Element &&
        Boolean(document.activeElement.closest(".note-list-panel"));
      const deletedIds = new Set(noteIds);
      const currentList = notesRef.current;
      const ordered = sortNotes(currentList, noteSort);
      const visibleDeletedCount = currentList.filter((note) => deletedIds.has(note.id)).length;
      const activeId = activeNoteIdRef.current;
      const activeIndex = activeId ? ordered.findIndex((note) => note.id === activeId) : -1;
      const activeWasDeleted = Boolean(activeId && deletedIds.has(activeId));
      const nextActiveId =
        activeWasDeleted && activeIndex >= 0
          ? (ordered.slice(activeIndex + 1).find((note) => !deletedIds.has(note.id))?.id ??
            ordered
              .slice(0, activeIndex)
              .reverse()
              .find((note) => !deletedIds.has(note.id))?.id ??
            null)
          : null;

      replaceList(currentList.filter((note) => !deletedIds.has(note.id)));
      setTotalNotes((value) => Math.max(0, value - visibleDeletedCount));
      clearNoteSelection();
      if (splitNoteIdRef.current && deletedIds.has(splitNoteIdRef.current)) {
        closeSplitRef.current();
      }
      if (activeWasDeleted) {
        selectNote(nextActiveId);
        setCardEditingNoteId((current) =>
          current && deletedIds.has(current) ? nextActiveId : current,
        );
        if (restoreFocus && nextActiveId) focusNoteRowAfterRemoval(nextActiveId);
      }
    },
    [clearNoteSelection, noteSort, replaceList, selectNote],
  );
  return { removeFromList, patchNoteFromRemote, removeManyFromList };
}
