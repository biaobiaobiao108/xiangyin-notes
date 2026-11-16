import {
  useCallback,
  type MouseEvent as ReactMouseEvent,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { NoteSummary } from "../../shared/types";
import { resolveNoteClickAction, type NoteSelectionClick } from "./note-list-selection";
import { sortNotes, type NoteSort } from "./helpers";
import type { useNoteSelection } from "./use-note-selection";
import type { useMobileNavigation } from "./use-mobile-navigation";
type Ref<T> = { current: T };
type Setter<T> = Dispatch<SetStateAction<T>>;
type Selection = ReturnType<typeof useNoteSelection>;

export function useWorkspaceNoteInteractions({
  isMobileViewport,
  openInSplit,
  locateSearchResult,
  notesRef,
  noteSort,
  noteSelectionRef,
  toggleNoteSelection,
  splitNoteId,
  activePane,
  selectedId,
  setActivePane,
  setEditorFocusNoteId,
  flushSecondaryDraft,
  setSplitNoteId,
  selectNote,
  setNoteSelectionAnchor,
  openMobileNote,
  setCardEditingNoteId,
}: {
  isMobileViewport: boolean;
  openInSplit: (id: string) => void;
  locateSearchResult: (id: string) => void;
  notesRef: Ref<NoteSummary[]>;
  noteSort: NoteSort;
  noteSelectionRef: Selection["noteSelectionRef"];
  toggleNoteSelection: Selection["toggleNoteSelection"];
  splitNoteId: string | null;
  activePane: "primary" | "secondary";
  selectedId: string | null;
  setActivePane: Setter<"primary" | "secondary">;
  setEditorFocusNoteId: Setter<string | null>;
  flushSecondaryDraft: () => void;
  setSplitNoteId: Setter<string | null>;
  selectNote: (id: string | null) => void;
  setNoteSelectionAnchor: Selection["setNoteSelectionAnchor"];
  openMobileNote: ReturnType<typeof useMobileNavigation>["openMobileNote"];
  setCardEditingNoteId: Setter<string | null>;
}) {
  const handleSelectListNote = useCallback(
    (id: string, event: ReactMouseEvent<HTMLButtonElement>) => {
      if (event.altKey && !isMobileViewport) {
        event.preventDefault();
        openInSplit(id);
        locateSearchResult(id);
        return;
      }
      const orderedIds = sortNotes(notesRef.current, noteSort).map((note) => note.id);
      const intent = resolveNoteClickAction(event, {
        hasSelectionActive: noteSelectionRef.current.ids.size > 0,
      });
      if (intent.action === "toggle") {
        toggleNoteSelection(orderedIds, id, intent.modifiers);
        return;
      }
      if (splitNoteId && !isMobileViewport) {
        if (activePane === "secondary") {
          if (id === selectedId) {
            setActivePane("primary");
            setEditorFocusNoteId(id);
            locateSearchResult(id);
            return;
          }
          if (splitNoteId && splitNoteId !== id) {
            flushSecondaryDraft();
          }
          setSplitNoteId(id);
          locateSearchResult(id);
          return;
        } else {
          if (id === splitNoteId) {
            setActivePane("secondary");
            locateSearchResult(id);
            return;
          }
          selectNote(id);
          locateSearchResult(id);
          setNoteSelectionAnchor(id);
          return;
        }
      }
      selectNote(id);
      locateSearchResult(id);
      setNoteSelectionAnchor(id);
      openMobileNote({ noteId: id });
    },
    [
      activePane,
      isMobileViewport,
      locateSearchResult,
      noteSort,
      openInSplit,
      openMobileNote,
      selectNote,
      selectedId,
      setNoteSelectionAnchor,
      splitNoteId,
      toggleNoteSelection,
    ],
  );
  const handleOpenCardNote = useCallback(
    (id: string) => {
      selectNote(id);
      locateSearchResult(id);
      setNoteSelectionAnchor(id);
      setCardEditingNoteId(id);
      openMobileNote({ noteId: id });
    },
    [locateSearchResult, openMobileNote, selectNote, setNoteSelectionAnchor],
  );
  const handleToggleCardSelection = useCallback(
    (id: string, modifiers: Pick<NoteSelectionClick, "metaKey" | "ctrlKey" | "shiftKey">) => {
      toggleNoteSelection(
        sortNotes(notesRef.current, noteSort).map((note) => note.id),
        id,
        modifiers,
      );
    },
    [noteSort, toggleNoteSelection],
  );
  return { handleSelectListNote, handleOpenCardNote, handleToggleCardSelection };
}
