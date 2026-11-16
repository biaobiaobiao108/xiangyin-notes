import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { Note } from "../../shared/types";
import { parseTagQuery } from "../../shared/tags";
import type { useMobileNavigation } from "./use-mobile-navigation";
type Setter<T> = Dispatch<SetStateAction<T>>;
type Result = { id: string; query: string; token: number } | null;
export function useWorkspaceSearch({
  setCommandOpen,
  setCommandInitialQuery,
  selectedRef,
  notifyWarning,
  setResultSearch,
  setInNoteSearchQuery,
  changeQuery,
  setSidebarCollapsed,
  setCardEditingNoteId,
  openMobileList,
  deferredQuery,
  resultSearchTokenRef,
}: {
  setCommandOpen: Setter<boolean>;
  setCommandInitialQuery: Setter<string>;
  selectedRef: { current: Note | null };
  notifyWarning: (message: string) => void;
  setResultSearch: Setter<Result>;
  setInNoteSearchQuery: Setter<string>;
  changeQuery: (query: string) => void;
  setSidebarCollapsed: Setter<boolean>;
  setCardEditingNoteId: Setter<string | null>;
  openMobileList: ReturnType<typeof useMobileNavigation>["openMobileList"];
  deferredQuery: string;
  resultSearchTokenRef: { current: number };
}) {
  const closeCommandMenu = useCallback(() => {
    setCommandOpen(false);
    setCommandInitialQuery("");
  }, []);
  const handleSearchInCurrentNote = useCallback((term: string) => {
    const normalized = term.trim();
    if (!normalized) return;
    if (!selectedRef.current) {
      notifyWarning("当前未打开笔记，无法在单篇笔记内查找");
      return;
    }
    setResultSearch(null);
    setInNoteSearchQuery(normalized);
  }, []);
  const handleSearchGlobal = useCallback(
    (term: string) => {
      const normalized = term.trim();
      if (!normalized) return;
      setInNoteSearchQuery("");
      setResultSearch(null);
      changeQuery(normalized);
      setSidebarCollapsed(false);
      setCardEditingNoteId(null);
      openMobileList();
      closeCommandMenu();
    },
    [changeQuery, closeCommandMenu, openMobileList],
  );
  const handleClearInNoteSearch = useCallback(() => {
    setInNoteSearchQuery("");
    setResultSearch(null);
  }, []);
  const locateSearchResult = useCallback(
    (id: string) => {
      const term = deferredQuery.trim();
      setInNoteSearchQuery("");
      setResultSearch(
        term && !parseTagQuery(term)
          ? { id, query: term, token: ++resultSearchTokenRef.current }
          : null,
      );
    },
    [deferredQuery],
  );
  return {
    closeCommandMenu,
    handleSearchInCurrentNote,
    handleSearchGlobal,
    handleClearInNoteSearch,
    locateSearchResult,
  };
}
