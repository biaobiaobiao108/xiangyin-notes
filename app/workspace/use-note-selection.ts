import { useCallback, useEffect, useRef, useState } from "react";
import { NOTE_BATCH_LIMIT } from "../../shared/types";
import {
  applyNoteSelectionClick,
  noteSelectionAnchor,
  pruneNoteSelection,
  type NoteSelectionClick,
  type NoteSelectionState,
} from "./note-list-selection";

export function useNoteSelection(listScope: string) {
  const [selectedNoteIds, setSelectedNoteIds] = useState<ReadonlySet<string>>(() => new Set());
  const noteSelectionRef = useRef<NoteSelectionState>({ ids: new Set(), anchorId: null });

  const updateNoteSelection = useCallback((next: NoteSelectionState) => {
    const normalized = { ids: new Set(next.ids), anchorId: next.anchorId };
    noteSelectionRef.current = normalized;
    setSelectedNoteIds(normalized.ids);
  }, []);
  const clearNoteSelection = useCallback(() => {
    updateNoteSelection({ ids: new Set(), anchorId: null });
  }, [updateNoteSelection]);
  const setNoteSelectionAnchor = useCallback(
    (id: string) => {
      updateNoteSelection(noteSelectionAnchor(id));
    },
    [updateNoteSelection],
  );
  const toggleNoteSelection = useCallback(
    (
      orderedIds: readonly string[],
      id: string,
      modifiers: Pick<NoteSelectionClick, "metaKey" | "ctrlKey" | "shiftKey">,
    ) => {
      const next = applyNoteSelectionClick(noteSelectionRef.current, orderedIds, {
        id,
        ...modifiers,
      });
      if (next.ids.size > NOTE_BATCH_LIMIT) return false;
      updateNoteSelection(next);
      return true;
    },
    [updateNoteSelection],
  );
  const pruneNoteSelectionTo = useCallback(
    (validIds: readonly string[]) => {
      updateNoteSelection(pruneNoteSelection(noteSelectionRef.current, validIds));
    },
    [updateNoteSelection],
  );

  const previousListScopeRef = useRef(listScope);
  useEffect(() => {
    if (previousListScopeRef.current === listScope) return;
    previousListScopeRef.current = listScope;
    clearNoteSelection();
  }, [clearNoteSelection, listScope]);

  return {
    selectedNoteIds,
    noteSelectionRef,
    updateNoteSelection,
    clearNoteSelection,
    setNoteSelectionAnchor,
    toggleNoteSelection,
    pruneNoteSelectionTo,
  };
}
