import { useCallback, useRef, type Dispatch, type SetStateAction } from "react";
import { normalizeLinkTitle } from "../../shared/wiki-links";
import type { NoteSummary, NoteView, Notebook } from "../../shared/types";
import { api } from "../api";
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
  const pendingWikiCreationsRef = useRef<Map<string, Promise<NoteSummary | null>>>(new Map());

  const ensureWikiNoteExists = useCallback(
    async (title: string): Promise<NoteSummary | null> => {
      const cleanTitle = title.replace(/^(?:\[\[|【【)\s*|\s*(?:\]\]|】】)$/g, "").trim();
      const normalized = normalizeLinkTitle(cleanTitle);
      if (!normalized) return null;
      const inFlight = pendingWikiCreationsRef.current.get(normalized);
      if (inFlight) return await inFlight;
      const defaultNotebook = notebookId
        ? notebooks.find((notebook) => notebook.id === notebookId)
        : (notebooks.find((notebook) => notebook.isSystem) ?? notebooks[0]);
      if (!defaultNotebook) return null;
      const scope = listScopeRef.current;
      const creationPromise = (async () => {
        try {
          const result = await api.ensureWikiNote({
            title: cleanTitle,
            notebookId: defaultNotebook.id,
          });
          const summary = toNoteSummary(result.note);

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
              if (result.created && merged.length > currentNotes.length)
                setTotalNotes((prev) => prev + 1);
            }
          }
          if (result.created) void refreshNotebooks();
          return summary;
        } catch {
          return null;
        } finally {
          pendingWikiCreationsRef.current.delete(normalized);
        }
      })();

      pendingWikiCreationsRef.current.set(normalized, creationPromise);
      return await creationPromise;
    },
    [
      deferredQuery,
      listScopeRef,
      notebookId,
      notebooks,
      notesRef,
      refreshNotebooks,
      replaceList,
      setTotalNotes,
      view,
    ],
  );

  const handleNavigateWikiLinkPrimary = useCallback(
    async (targetTitle: string) => {
      const note = await ensureWikiNoteExists(targetTitle);
      if (!note) {
        notifyError("打开或创建笔记失败，请重试");
        return;
      }
      if (splitNoteId === note.id) {
        setActivePane("secondary");
        return;
      }
      selectNote(note.id);
    },
    [ensureWikiNoteExists, notifyError, selectNote, setActivePane, splitNoteId],
  );

  const handleNavigateWikiLinkSplit = useCallback(
    async (targetTitle: string) => {
      const note = await ensureWikiNoteExists(targetTitle);
      if (!note) {
        notifyError("打开或创建笔记失败，请重试");
        return;
      }
      if (selectedId === note.id) {
        setActivePane("primary");
        return;
      }
      if (splitNoteId && splitNoteId !== note.id) flushSecondaryDraft();
      setSplitNoteId(note.id);
      setActivePane("secondary");
    },
    [
      ensureWikiNoteExists,
      flushSecondaryDraft,
      notifyError,
      selectedId,
      setActivePane,
      setSplitNoteId,
      splitNoteId,
    ],
  );

  const handleCreateAndLinkNote = useCallback(
    async (title: string) => {
      await ensureWikiNoteExists(title);
    },
    [ensureWikiNoteExists],
  );

  return { handleNavigateWikiLinkPrimary, handleNavigateWikiLinkSplit, handleCreateAndLinkNote };
}
