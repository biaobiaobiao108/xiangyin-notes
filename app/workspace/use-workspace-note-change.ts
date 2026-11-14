import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { Note, NoteSummary, NoteView, Notebook } from "../../shared/types";
import { noteMetadataSnapshot, toNoteSummary, type NoteDraft } from "./helpers";

type SaveField = "title" | "contentMarkdown" | "notebookId" | "isFavorite" | "deleted";

export function useWorkspaceNoteChange({
  selectedRef,
  notesRef,
  notebooks,
  trashOperationsRef,
  replaceList,
  setSelectedNote,
  setNotebooks,
  setView,
  setNotebookId,
  setQuery,
  setTotalNotes,
  searchOriginRef,
  invalidateCollections,
  requestListTransition,
  saveImmediately,
  persist,
  refreshNotebooks,
  reloadNotes,
}: {
  selectedRef: React.MutableRefObject<Note | null>;
  notesRef: React.MutableRefObject<NoteSummary[]>;
  notebooks: Notebook[];
  trashOperationsRef: React.MutableRefObject<Set<string>>;
  replaceList: (notes: NoteSummary[]) => void;
  setSelectedNote: (note: Note | null) => void;
  setNotebooks: Dispatch<SetStateAction<Notebook[]>>;
  setView: Dispatch<SetStateAction<NoteView>>;
  setNotebookId: Dispatch<SetStateAction<string | undefined>>;
  setQuery: (query: string) => void;
  setTotalNotes: Dispatch<SetStateAction<number>>;
  searchOriginRef: React.MutableRefObject<{ view: NoteView; notebookId?: string } | null>;
  invalidateCollections: () => void;
  requestListTransition: () => void;
  saveImmediately: (
    note: Note | NoteDraft,
    keepalive?: boolean,
    fields?: SaveField[],
  ) => Promise<unknown>;
  persist: (note: Note | NoteDraft, fields?: SaveField[]) => void;
  refreshNotebooks: () => Promise<void>;
  reloadNotes: () => void;
}) {
  return useCallback(
    (patch: { title?: string; contentMarkdown?: string; notebookId?: string }) => {
      const current = selectedRef.current;
      if (!current || trashOperationsRef.current.has(current.id)) return;
      if (
        (patch.title === undefined || patch.title === current.title) &&
        (patch.contentMarkdown === undefined ||
          patch.contentMarkdown === current.contentMarkdown) &&
        (patch.notebookId === undefined || patch.notebookId === current.notebookId)
      )
        return;
      const targetNotebook = patch.notebookId
        ? notebooks.find((notebook) => notebook.id === patch.notebookId)
        : undefined;
      const next = {
        ...current,
        ...patch,
        ...(targetNotebook ? { notebookName: targetNotebook.name } : {}),
      };
      selectedRef.current = next;
      const contentOnlyChange =
        patch.contentMarkdown !== undefined &&
        patch.title === undefined &&
        patch.notebookId === undefined;
      if (!contentOnlyChange) {
        setSelectedNote(noteMetadataSnapshot(next));
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

      if (patch.notebookId && patch.notebookId !== current.notebookId) {
        if (targetNotebook) {
          invalidateCollections();
          searchOriginRef.current = null;
          setQuery("");
          const targetView: NoteView = targetNotebook.isSystem ? "inbox" : "all";
          const targetNotebookId = targetNotebook.isSystem ? undefined : targetNotebook.id;
          requestListTransition();
          setView(targetView);
          setNotebookId(targetNotebookId);
          replaceList([toNoteSummary(next)]);
          setTotalNotes(Math.max(1, targetNotebook.count + 1));
          setNotebooks((items) =>
            items.map((notebook) => {
              if (notebook.id === current.notebookId)
                return { ...notebook, count: Math.max(0, notebook.count - 1) };
              if (notebook.id === targetNotebook.id)
                return { ...notebook, count: notebook.count + 1 };
              return notebook;
            }),
          );
        }
        void saveImmediately(next, false, ["notebookId"])
          .then(() => {
            refreshNotebooks();
            reloadNotes();
          })
          .catch(() => {
            refreshNotebooks();
            reloadNotes();
          });
      } else {
        persist(next, Object.keys(patch) as SaveField[]);
      }
    },
    [
      invalidateCollections,
      notebooks,
      notesRef,
      persist,
      refreshNotebooks,
      reloadNotes,
      replaceList,
      requestListTransition,
      saveImmediately,
      searchOriginRef,
      selectedRef,
      setNotebookId,
      setNotebooks,
      setQuery,
      setSelectedNote,
      setTotalNotes,
      setView,
      trashOperationsRef,
    ],
  );
}
