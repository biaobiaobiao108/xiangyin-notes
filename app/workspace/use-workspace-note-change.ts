import { useCallback } from "react";
import type { Note, NoteSummary } from "../../shared/types";
import { noteMetadataSnapshot, type NoteDraft } from "./helpers";

type EditorPatch = { title?: string; contentMarkdown?: string };

export function useWorkspaceNoteChange({
  selectedRef,
  notesRef,
  trashOperationsRef,
  replaceList,
  setSelectedNote,
  persist,
}: {
  selectedRef: React.MutableRefObject<Note | null>;
  notesRef: React.MutableRefObject<NoteSummary[]>;
  trashOperationsRef: React.MutableRefObject<Set<string>>;
  replaceList: (notes: NoteSummary[]) => void;
  setSelectedNote: (note: Note | null) => void;
  persist: (note: Note | NoteDraft, fields: (keyof EditorPatch)[]) => void;
}) {
  return useCallback(
    (noteId: string, patch: EditorPatch) => {
      const current = selectedRef.current;
      if (!current || current.id !== noteId || trashOperationsRef.current.has(noteId)) return;
      const { title = current.title, contentMarkdown = current.contentMarkdown } = patch;
      if (title === current.title && contentMarkdown === current.contentMarkdown) return;

      const next = { ...current, title, contentMarkdown };
      selectedRef.current = next;
      const fields: (keyof EditorPatch)[] = [];
      if (title !== current.title) {
        fields.push("title");
        setSelectedNote(noteMetadataSnapshot(next));
        replaceList(
          notesRef.current.map((note) => (note.id === current.id ? { ...note, title } : note)),
        );
      }
      if (contentMarkdown !== current.contentMarkdown) fields.push("contentMarkdown");
      persist(next, fields);
    },
    [notesRef, persist, replaceList, selectedRef, setSelectedNote, trashOperationsRef],
  );
}
