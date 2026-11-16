import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { Note, Notebook, NoteView } from "../../shared/types";
import { api } from "../api";
import { createUuid } from "../uuid";
import { noteMetadataSnapshot } from "./helpers";
import type { useMobileNavigation } from "./use-mobile-navigation";
type Setter<T> = Dispatch<SetStateAction<T>>;
export function useWorkspaceNotebookEditor({
  editingNotebook,
  setEditingNotebook,
  setNotebooks,
  selectedRef,
  setSelectedNote,
  setNotebookId,
  setView,
  openMobileList,
}: {
  editingNotebook: Notebook | null | undefined;
  setEditingNotebook: Setter<Notebook | null | undefined>;
  setNotebooks: Setter<Notebook[]>;
  selectedRef: { current: Note | null };
  setSelectedNote: Setter<Note | null>;
  setNotebookId: Setter<string | undefined>;
  setView: Setter<NoteView>;
  openMobileList: ReturnType<typeof useMobileNavigation>["openMobileList"];
}) {
  const createNotebook = useCallback(() => setEditingNotebook(null), []);
  const saveNotebook = useCallback(
    (saved: Notebook) => {
      setNotebooks((current) => {
        const exists = current.some((nb) => nb.id === saved.id);
        return exists
          ? current.map((nb) => (nb.id === saved.id ? { ...nb, ...saved } : nb))
          : [...current, saved];
      });
      if (editingNotebook) {
        const current = selectedRef.current;
        if (current?.notebookId === saved.id) {
          const next = { ...current, notebookName: saved.name };
          selectedRef.current = next;
          setSelectedNote(noteMetadataSnapshot(next));
        }
      } else {
        setNotebookId(saved.id);
        setView("all");
        openMobileList({ view: "all", notebookId: saved.id, query: "", searchOrigin: null });
      }
      setEditingNotebook(undefined);
    },
    [openMobileList, editingNotebook],
  );
  const saveNotebookDraft = useCallback(
    async (draft: { name: string; color: string; icon: string }) => {
      const existing = editingNotebook ?? undefined;
      const timestamp = Math.floor(Date.now() / 1000);
      const notebook: Notebook = existing
        ? { ...existing, name: draft.name, color: draft.color, icon: draft.icon }
        : {
            id: createUuid(),
            name: draft.name,
            color: draft.color,
            icon: draft.icon,
            isSystem: false,
            count: 0,
            updatedAt: timestamp,
          };
      const result = existing
        ? await api.updateNotebook(notebook.id, {
            name: notebook.name,
            color: notebook.color,
            icon: notebook.icon,
            expectedUpdatedAt: existing.updatedAt,
          })
        : await api.createNotebook({
            name: notebook.name,
            color: notebook.color,
            icon: notebook.icon,
          });
      return result.notebook;
    },
    [editingNotebook],
  );
  return { createNotebook, saveNotebook, saveNotebookDraft };
}
