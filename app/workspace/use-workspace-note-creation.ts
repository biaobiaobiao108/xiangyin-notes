import { useCallback, useRef, useState } from "react";
import type { CreateNoteCommand } from "../command-parser";
import { ApiError, api } from "../api";
import type { Note, NoteView, Notebook } from "../../shared/types";
import { errorMessage, type NoteDraft } from "./helpers";

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

  const createRecoveredNote = useCallback(
    async (draft: NoteDraft) => {
      // Reuse the deleted note's ID so retries after a lost response or reload stay idempotent.
      const id = draft.id;
      const notebookId = notebooks.find((notebook) => notebook.id === draft.notebookId)?.id;
      const payload = { id, title: draft.title, contentMarkdown: draft.contentMarkdown };
      const create = async () => {
        try {
          return await api.createNote({ ...payload, notebookId });
        } catch (error) {
          if (notebookId && error instanceof ApiError && error.code === "NOTEBOOK_NOT_FOUND")
            return api.createNote(payload);
          throw error;
        }
      };
      try {
        const { note } = await create();
        return note;
      } catch (error) {
        if (error instanceof ApiError && error.code === "NOTE_EXISTS") {
          const { note } = await api.getNote(id);
          if (
            note.deletedAt === null &&
            note.title === (draft.title.trim() ? draft.title : "") &&
            note.contentMarkdown === draft.contentMarkdown
          )
            return note;
        }
        if (error instanceof ApiError && error.code === "INVALID_ASSET")
          throw new Error("草稿中的图片附件已不可用。请移除相关引用后另存，或先复制 Markdown。");
        throw error;
      }
    },
    [notebooks],
  );

  return {
    creatingNote,
    createNoteHere,
    createNoteInInbox,
    createNoteInNotebook,
    createRecoveredNote,
  };
}
