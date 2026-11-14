import { useCallback, useRef, useState } from "react";
import type { CreateNoteCommand } from "../command-parser";
import { ApiError, api } from "../api";
import type { Note, NoteView, Notebook } from "../../shared/types";
import { errorMessage } from "./helpers";

type CreationTarget = { view: NoteView; notebookId?: string };

export function useWorkspaceNoteCreation({
  view,
  notebookId,
  notebooks,
  revealCreatedNote,
  flushEditorDraft,
  refreshNotebooks,
  notifyError,
  navigate,
}: {
  view: NoteView;
  notebookId?: string;
  notebooks: Notebook[];
  revealCreatedNote: (note: Note, target: CreationTarget) => void;
  flushEditorDraft: () => void;
  refreshNotebooks: () => Promise<void>;
  notifyError: (message: string) => void;
  navigate: (path: string, options?: { replace?: boolean }) => void;
}) {
  const noteCreationRef = useRef(false);
  const [creatingNote, setCreatingNote] = useState(false);

  const createNoteWithLock = useCallback(
    async (
      payload: Parameters<typeof api.createNote>[0],
      target: (note: Note) => CreationTarget,
    ) => {
      if (noteCreationRef.current) return null;
      noteCreationRef.current = true;
      setCreatingNote(true);
      flushEditorDraft();
      try {
        const result = await api.createNote(payload);
        revealCreatedNote(result.note, target(result.note));
        void refreshNotebooks();
        return result.note;
      } catch (reason) {
        if (reason instanceof ApiError && reason.status === 401)
          navigate(`/login${window.location.search}`, { replace: true });
        notifyError(errorMessage(reason, "创建笔记失败，请稍后重试"));
        return null;
      } finally {
        noteCreationRef.current = false;
        setCreatingNote(false);
      }
    },
    [flushEditorDraft, navigate, notifyError, refreshNotebooks, revealCreatedNote],
  );

  const createNoteHere = useCallback(async () => {
    const currentNotebook = notebookId
      ? notebooks.find((notebook) => notebook.id === notebookId)
      : undefined;
    const inbox = notebooks.find((notebook) => notebook.isSystem);
    const staysInView = Boolean(currentNotebook) || view === "all" || view === "inbox";
    return await createNoteWithLock(
      currentNotebook ? { notebookId: currentNotebook.id } : { notebookId: inbox?.id },
      () => ({
        view: currentNotebook || !staysInView ? "all" : view,
        notebookId: currentNotebook?.id,
      }),
    );
  }, [createNoteWithLock, notebookId, notebooks, view]);

  const createNoteInInbox = useCallback(async () => {
    const inbox = notebooks.find((notebook) => notebook.isSystem);
    return await createNoteWithLock(inbox ? { notebookId: inbox.id } : {}, (note) => ({
      view: "inbox",
      notebookId: note.notebookId,
    }));
  }, [createNoteWithLock, notebooks]);

  const createNoteInNotebook = useCallback(
    async (commandToCreate: CreateNoteCommand) =>
      await createNoteWithLock(
        {
          notebookId: commandToCreate.notebookId,
          title: commandToCreate.title,
        },
        () => ({ view: "all", notebookId: commandToCreate.notebookId }),
      ),
    [createNoteWithLock],
  );

  return { creatingNote, createNoteHere, createNoteInInbox, createNoteInNotebook };
}
