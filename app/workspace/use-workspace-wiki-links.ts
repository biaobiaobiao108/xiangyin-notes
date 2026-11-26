import { useCallback, useRef, type Dispatch, type SetStateAction } from "react";
import type { NoteSummary, NoteView, Notebook } from "../../shared/types";
import { api, ApiError } from "../api";
import { mergeWikiNoteSummary, toNoteSummary } from "./helpers";

export function useWorkspaceWikiLinks({
  view,
  notebookId,
  notebooks,
  deferredQuery,
  listScopeRef,
  notesRef,
  replaceList,
  setTotalNotes,
  refreshNotebooks,
  selectedId,
  splitNoteId,
  selectNote,
  setActivePane,
  setSplitNoteId,
  flushSecondaryDraft,
  notifyError,
}: {
  view: NoteView;
  notebookId?: string;
  notebooks: Notebook[];
  deferredQuery: string;
  listScopeRef: { current: string };
  notesRef: { current: NoteSummary[] };
  replaceList: (notes: NoteSummary[]) => void;
  setTotalNotes: Dispatch<SetStateAction<number>>;
  refreshNotebooks: () => Promise<void>;
  selectedId: string | null;
  splitNoteId: string | null;
  selectNote: (id: string) => void;
  setActivePane: (pane: "primary" | "secondary") => void;
  setSplitNoteId: (id: string) => void;
  flushSecondaryDraft: () => void;
  notifyError: (message: string) => void;
}) {
  const latestNavigationRef = useRef(0);
  const openLinkedNote = useCallback(
    async (id: string, open: () => void) => {
      const navigation = ++latestNavigationRef.current;
      try {
        const { note } = await api.getNoteSummary(id);
        if (navigation !== latestNavigationRef.current) return;
        if (!note.deletedAt) {
          open();
          return;
        }
      } catch (error) {
        if (navigation !== latestNavigationRef.current) return;
        if (!(error instanceof ApiError) || error.status !== 404) {
          notifyError("打开链接笔记失败，请重试");
          return;
        }
      }
      notifyError("链接的笔记已删除或不存在");
    },
    [notifyError],
  );

  const handleNavigateWikiLinkPrimary = useCallback(
    (id: string) =>
      openLinkedNote(id, () => {
        if (splitNoteId === id) setActivePane("secondary");
        else selectNote(id);
      }),
    [openLinkedNote, selectNote, setActivePane, splitNoteId],
  );

  const handleNavigateWikiLinkSplit = useCallback(
    (id: string) =>
      openLinkedNote(id, () => {
        if (selectedId === id) {
          setActivePane("primary");
          return;
        }
        if (splitNoteId && splitNoteId !== id) flushSecondaryDraft();
        setSplitNoteId(id);
        setActivePane("secondary");
      }),
    [openLinkedNote, flushSecondaryDraft, selectedId, setActivePane, setSplitNoteId, splitNoteId],
  );

  const handleCreateAndLinkNote = useCallback(
    async (title: string): Promise<NoteSummary | null> => {
      const defaultNotebook = notebookId
        ? notebooks.find((notebook) => notebook.id === notebookId)
        : (notebooks.find((notebook) => notebook.isSystem) ?? notebooks[0]);
      if (!defaultNotebook) {
        notifyError("找不到用于创建笔记的笔记本");
        return null;
      }
      const scope = listScopeRef.current;
      try {
        const { note } = await api.createNote({ title, notebookId: defaultNotebook.id });
        const summary = toNoteSummary(note);
        if (scope === listScopeRef.current) {
          const currentNotes = notesRef.current;
          const merged = mergeWikiNoteSummary(
            currentNotes,
            summary,
            notebooks,
            view,
            deferredQuery,
            notebookId,
          );
          if (merged) {
            replaceList(merged);
            if (merged.length > currentNotes.length) setTotalNotes((prev) => prev + 1);
          }
        }
        void refreshNotebooks();
        return summary;
      } catch {
        notifyError("创建链接笔记失败，请重试");
        return null;
      }
    },
    [
      deferredQuery,
      listScopeRef,
      notebookId,
      notebooks,
      notesRef,
      notifyError,
      refreshNotebooks,
      replaceList,
      setTotalNotes,
      view,
    ],
  );

  return { handleNavigateWikiLinkPrimary, handleNavigateWikiLinkSplit, handleCreateAndLinkNote };
}
