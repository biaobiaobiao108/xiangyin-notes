import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useNavigate } from "react-router";
import { useContextMenu } from "./context-menu";
import { copyPlainText } from "./editor/code-block-copy";
import { moveSelectedNotes } from "./workspace/move-selected-notes";
import { ApiError, api } from "./api";
import { createUuid } from "./uuid";
import { CommandId, CommandMenu } from "./command-menu";
import { applyPwaUpdate, installPwa, subscribePwa, type PwaState } from "./pwa";
import type { WorkspaceChangeMessage } from "../shared/realtime";
import type { Note, NoteSummary, NoteView, Notebook } from "../shared/types";
import { useOutlineState } from "./workspace/use-outline-state";
import { ConfirmDialog, NotebookDialog, type ConfirmRequest } from "./workspace/dialogs";
import { SplitResizer, DEFAULT_SPLIT_RATIO } from "./workspace/split-resizer";
import { SplitNoteDialog } from "./workspace/split-note-dialog";
import { EmptyEditor, NoteListPanel, NoteLoadingState, Sidebar } from "./workspace/panels";
import { NoteCardGridPanel } from "./workspace/note-card-grid";
import { TasksPanel } from "./workspace/tasks-panel";
import { KanbanPanel } from "./workspace/kanban-panel";
import { registerDragOverGuard } from "./workspace/note-drag-drop";
import { ErrorBoundary, EditorErrorFallback } from "./error-boundary";
import {
  errorMessage,
  mergeRemoteSummary,
  noteMetadataSnapshot,
  shouldKeepActiveNoteInList,
  sortNotes,
  toNoteSummary,
  type NoteSort,
} from "./workspace/helpers";
import { resolveNoteClickAction, type NoteSelectionClick } from "./workspace/note-list-selection";
import { useNoteSelection } from "./workspace/use-note-selection";
import { useNoteSaveQueue, type SaveState } from "./workspace/use-note-save-queue";
import { useWorkspaceRealtime } from "./workspace/use-realtime";
import {
  accumulateRealtimeRefresh,
  emptyRealtimeRefreshPlan,
  type RealtimeRefreshPlan,
} from "./workspace/realtime-refresh";
import { refreshSelectedNote } from "./workspace/selected-note-sync";
import { useWorkspaceShortcuts } from "./workspace/use-workspace-shortcuts";
import { useTrashActions } from "./workspace/use-trash-actions";
import {
  useMobileNavigation,
  shouldShowTasksPanel,
  shouldShowKanbanPanel,
  shouldShowMemoPage,
  type MobileListContext,
  type MobilePage,
} from "./workspace/use-mobile-navigation";
import { useMobileViewport } from "./workspace/use-mobile-viewport";
import { useNotices } from "./workspace/use-notices";
import { SystemNotices } from "./workspace/system-notices";
import { MobileNotebookHome, MobileBottomBar } from "./workspace/mobile-panels";
import { viewLabel } from "./workspace/helpers";
import { parseTagQuery } from "../shared/tags";
import { useThemePreference } from "./theme";
import { createWorkspaceContextMenuHandler } from "./workspace/workspace-context-menu";
import { useWorkspacePreferences } from "./workspace/use-workspace-preferences";
import { useWorkspaceTaskData } from "./workspace/use-workspace-task-data";
import { useWorkspaceKanbanData } from "./workspace/use-workspace-kanban-data";
import { useWorkspaceNotebookData } from "./workspace/use-workspace-notebook-data";
import { useWorkspaceExport } from "./workspace/use-workspace-export";
import { MemoWorkspaceProvider } from "./memos/memo-workspace";
import { useWorkspaceSession } from "./workspace/use-workspace-session";
import { useWorkspaceNoteCreation } from "./workspace/use-workspace-note-creation";
import { useWorkspaceWikiLinks } from "./workspace/use-workspace-wiki-links";
import { useSelectedNoteLoader } from "./workspace/use-selected-note-loader";
import { useWorkspaceTaskActions } from "./workspace/use-workspace-task-actions";
import { useWorkspaceSplit } from "./workspace/use-workspace-split";
import { useWorkspaceNoteList } from "./workspace/use-workspace-note-list";
import { useWorkspaceNoteChange } from "./workspace/use-workspace-note-change";

export type { ViewLayout } from "./workspace/use-workspace-preferences";

const LazyImageExportDialog = lazy(() =>
  import("./image-export/dialog").then(({ ImageExportDialog }) => ({ default: ImageExportDialog })),
);

const LazyNoteEditor = lazy(() =>
  import("./editor").then(({ NoteEditor }) => ({ default: memo(NoteEditor) })),
);

const LazyMemoPage = lazy(() =>
  import("./memos/memo-page").then(({ MemoPage }) => ({ default: MemoPage })),
);

function focusNoteRowAfterRemoval(noteId: string) {
  requestAnimationFrame(() => {
    const row = document.querySelector<HTMLButtonElement>(
      `[data-note-id="${CSS.escape(noteId)}"] .note-row`,
    );
    if (row) {
      row.focus();
      return;
    }
    document.getElementById("note-list-scroll-region")?.focus();
  });
}

export function Workspace() {
  const navigate = useNavigate();
  const { ready, currentUserKey, handleUnauthorized, connectionError, retry } =
    useWorkspaceSession();
  const { openMenu: openWorkspaceMenu, menu: workspaceMenu } = useContextMenu();
  const [initialLinkedNoteId] = useState(() =>
    new URLSearchParams(window.location.search).get("note"),
  );
  const pendingLinkedNoteRef = useRef(initialLinkedNoteId);
  const { preference: themePreference, setPreference: setThemePreference } = useThemePreference();
  const [view, setView] = useState<NoteView>("all");
  const [notebookId, setNotebookId] = useState<string>();
  const [query, setQueryState] = useState("");
  const [queryDraft, setQueryDraft] = useState("");
  const deferredQuery = useDeferredValue(query);
  const setQuery = useCallback((next: string) => {
    setQueryDraft(next);
    setQueryState(next);
  }, []);
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [noteSort, setNoteSort] = useState<NoteSort>("updated");
  const [totalNotes, setTotalNotes] = useState(0);
  const [hasMoreNotes, setHasMoreNotes] = useState(false);
  const [notesReloadToken, setNotesReloadToken] = useState(0);
  const [listTransitionToken, setListTransitionToken] = useState(0);

  useEffect(() => {
    return registerDragOverGuard();
  }, []);
  const listTransitionIntentRef = useRef(0);
  const listTransitionConsumedRef = useRef(0);
  const playListTransition = useCallback(() => {
    listTransitionConsumedRef.current = listTransitionIntentRef.current;
    setListTransitionToken((value) => value + 1);
  }, []);
  const editorMarkdownReaderRef = useRef<(() => string | null) | null>(null);
  const editorMarkdownDirtyNoteRef = useRef<string | null>(null);
  const flushEditorDraftRef = useRef<() => void>(() => undefined);
  const notesRef = useRef<NoteSummary[]>([]);
  const listRequestRef = useRef(0);
  const listAbortRef = useRef<AbortController | null>(null);
  const nextNotesCursorRef = useRef<string | null>(null);
  const trashOperationsRef = useRef(new Set<string>());
  const [pendingTrashCount, setPendingTrashCount] = useState(0);
  const emptyingTrashRef = useRef(false);
  const [emptyingTrash, setEmptyingTrash] = useState(false);
  const listScope = JSON.stringify([view, notebookId, deferredQuery, noteSort]);
  const listScopeRef = useRef(listScope);
  if (listScopeRef.current !== listScope) nextNotesCursorRef.current = null;
  listScopeRef.current = listScope;
  const {
    selectedNoteIds,
    noteSelectionRef,
    clearNoteSelection,
    setNoteSelectionAnchor,
    toggleNoteSelection,
    pruneNoteSelectionTo,
  } = useNoteSelection(listScope);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;
  const [selectedNote, setSelectedNote] = useState<Note | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const {
    items: outlineItems,
    activeId: activeOutlineId,
    navigateRef: outlineNavigateRef,
    onItemsChange: handleOutlineItemsChange,
    onActiveChange: handleOutlineActiveChange,
    onNavigationReady: handleOutlineNavigationReady,
    reset: resetOutline,
  } = useOutlineState();
  const [editorFocusNoteId, setEditorFocusNoteId] = useState<string | null>(null);
  const handleEditorFocus = useCallback(() => setEditorFocusNoteId(null), []);
  const selectedRef = useRef<Note | null>(null);
  const activeNoteIdRef = useRef<string | null>(null);
  const noteLoadRequestRef = useRef(0);
  const noteAbortRef = useRef<AbortController | null>(null);
  const noteOpeningRef = useRef<Promise<void> | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const searchOriginRef = useRef<{ view: NoteView; notebookId?: string } | null>(null);
  const [isNoteLoading, setIsNoteLoading] = useState(false);
  const {
    sidebarCollapsed,
    setSidebarCollapsed,
    toggleSidebar,
    focusMode,
    toggleFocusMode,
    exitFocusMode,
    typewriterMode,
    toggleTypewriterMode,
    viewLayout,
    setViewLayout,
  } = useWorkspacePreferences();
  const toggleViewLayout = useCallback(() => {
    if (window.matchMedia("(max-width: 900px)").matches) return;
    setViewLayout((current) => {
      const next = current === "cards" ? "three-column" : "cards";
      if (next !== "cards") {
        closeSplitRef.current();
      }
      try {
        localStorage.setItem("xiangying_view_layout", next);
      } catch {}
      return next;
    });
    playListTransition();
  }, [playListTransition]);
  const [cardEditingNoteId, setCardEditingNoteId] = useState<string | null>(null);
  const cardGridScrollPositionRef = useRef<{ scope: string; top: number }>({ scope: "", top: 0 });
  const mobileEditorVisitedRef = useRef(false);

  const [tasksOpen, setTasksOpen] = useState(false);
  const [kanbanOpen, setKanbanOpen] = useState(false);
  const [memosOpen, setMemosOpen] = useState(false);
  const [memoRefreshToken, setMemoRefreshToken] = useState(0);
  const editorRegionRef = useRef<HTMLElement | null>(null);
  const mobileRestoreRef = useRef<(context: MobileListContext, page: MobilePage) => void>(
    () => undefined,
  );
  const {
    isMobileViewport,
    mobilePage,
    openMobileList,
    openMobileNote,
    openMobileTasks,
    openMobileKanban,
    openMobileMemos,
    backMobilePage,
    openMobileHome,
  } = useMobileNavigation(
    {
      view,
      notebookId,
      query,
      sort: noteSort,
      noteId: selectedId,
      searchOrigin: searchOriginRef.current,
      tasksOpen,
      kanbanOpen,
      memosOpen,
    },
    (context, page) => mobileRestoreRef.current(context, page),
  );
  const toggleOutline = useCallback(() => {
    if (focusMode) return;
    setOutlineOpen((current) => {
      const next = !current;
      return next;
    });
  }, [focusMode]);
  const closeOutline = useCallback(() => setOutlineOpen(false), []);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandInitialQuery, setCommandInitialQuery] = useState("");
  const [inNoteSearchQuery, setInNoteSearchQuery] = useState("");
  const {
    taskStatus,
    setTaskStatus,
    taskNotebookId,
    setTaskNotebookId,
    currentTaskSnapshot,
    tasks,
    tasksLoading,
    tasksError,
    tasksMoreLoading,
    tasksMoreError,
    loadMoreTasks,
    setTaskRefreshToken,
    taskNavigation,
    setTaskNavigation,
    taskNavigationTokenRef,
    taskMutationNoteId,
    setTaskMutationNoteId,
    taskMutationOrdinal,
    setTaskMutationOrdinal,
    taskMutationsInFlightRef,
  } = useWorkspaceTaskData(tasksOpen);
  const [resultSearch, setResultSearch] = useState<{
    id: string;
    query: string;
    token: number;
  } | null>(null);
  const resultSearchTokenRef = useRef(0);
  const [editingNotebook, setEditingNotebook] = useState<Notebook | null | undefined>(undefined);
  const kanbanReturnRef = useRef(false);
  const {
    notice,
    notifyError,
    notifyWarning,
    notifyInfo,
    dismiss: dismissNotice,
    setPaused: pauseNotice,
  } = useNotices();
  const {
    notebooks,
    setNotebooks,
    reorderingNotebooks,
    refreshNotebooks,
    handleReorderNotebooks,
    invalidateNotebookRequests,
  } = useWorkspaceNotebookData({ trashOperationsRef, emptyingTrashRef, notifyError });
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const [noteReloadToken, setNoteReloadToken] = useState(0);
  const setSelectedNoteMetadata = useCallback((note: Note | null) => {
    setSelectedNote(note ? noteMetadataSnapshot(note) : null);
  }, []);
  const [pwaState, setPwaState] = useState<PwaState>({
    standalone: false,
    canInstall: false,
    showIosInstallHint: false,
    updateAvailable: false,
  });
  const realtimeRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRealtimeRefreshRef = useRef<RealtimeRefreshPlan>(emptyRealtimeRefreshPlan());
  const shortcutHandledRef = useRef(false);
  const confirmIdRef = useRef(0);
  const replaceList = useCallback((next: NoteSummary[]) => {
    notesRef.current = next;
    setNotes(next);
  }, []);
  const [splitNoteId, setSplitNoteId] = useState<string | null>(null);
  const splitNoteIdRef = useRef<string | null>(null);
  splitNoteIdRef.current = splitNoteId;
  const [autoReadingMode, setAutoReadingMode] = useState(false);
  const toggleAutoReadingMode = useCallback(() => {
    if (splitNoteIdRef.current || !selectedIdRef.current) return;
    setAutoReadingMode((current) => !current);
  }, []);
  const exitAutoReadingMode = useCallback(() => {
    setAutoReadingMode(false);
  }, []);
  useEffect(() => {
    if (splitNoteId) setAutoReadingMode(false);
  }, [splitNoteId]);
  const closeSplitRef = useRef<() => void>(() => undefined);
  const [splitSelectedNote, setSplitSelectedNote] = useState<Note | null>(null);
  const splitSelectedRef = useRef<Note | null>(null);
  const splitNoteOpeningRef = useRef<Promise<void> | null>(null);
  const [splitIsNoteLoading, setSplitIsNoteLoading] = useState(false);
  const [splitSaveState, setSplitSaveState] = useState<SaveState>("idle");
  const [splitNoteReloadToken, setSplitNoteReloadToken] = useState(0);
  const [replaceRequest, setReplaceRequest] = useState<{
    noteId: string;
    token: number;
    query: string;
  } | null>(null);
  const [activePane, setActivePane] = useState<"primary" | "secondary">("primary");
  const [splitRatio, setSplitRatio] = useState(DEFAULT_SPLIT_RATIO);
  const {
    items: splitOutlineItems,
    activeId: splitActiveOutlineId,
    navigateRef: splitOutlineNavigateRef,
    onItemsChange: handleSplitOutlineItemsChange,
    onActiveChange: handleSplitOutlineActiveChange,
    onNavigationReady: handleSplitOutlineNavigationReady,
  } = useOutlineState();
  const splitLoadRequestRef = useRef(0);
  const splitAbortRef = useRef<AbortController | null>(null);
  const splitMarkdownReaderRef = useRef<(() => string | null) | null>(null);
  const splitMarkdownDirtyNoteRef = useRef<string | null>(null);
  const [splitEditorFocusNoteId, setSplitEditorFocusNoteId] = useState<string | null>(null);
  const handleSplitEditorFocus = useCallback(() => setSplitEditorFocusNoteId(null), []);
  const setSplitSelectedNoteMetadata = useCallback((note: Note | null) => {
    setSplitSelectedNote(note ? noteMetadataSnapshot(note) : null);
  }, []);
  const [splitPickerOpen, setSplitPickerOpen] = useState(false);
  const handleRewrittenContent = useCallback((noteId: string) => {
    if (activeNoteIdRef.current === noteId) setNoteReloadToken((value) => value + 1);
    if (splitNoteIdRef.current === noteId) setSplitNoteReloadToken((value) => value + 1);
  }, []);
  const {
    saveState,
    setSaveState,
    pendingSavesRef,
    failedSavesRef,
    persist,
    runSave,
    saveImmediately,
    saveFavorite,
    flushNotebookSaves,
    saveNoteNow,
    flushPendingSaves,
    hasUnsavedWork,
    clearPendingForNote,
  } = useNoteSaveQueue({
    selectedRef,
    notesRef,
    activeNoteIdRef,
    trashOperationsRef,
    flushEditorDraftRef,
    replaceList,
    setSelectedNote: setSelectedNoteMetadata,
    setToast: notifyError,
    splitSelectedRef,
    splitNoteIdRef,
    setSplitSelectedNote: setSplitSelectedNoteMetadata,
    setSplitSaveState,
    onRewrittenContent: handleRewrittenContent,
  });
  const {
    imageExportSnapshot,
    handleExportNote,
    handleExportLibrary,
    handleExportImage,
    closeImageExport,
  } = useWorkspaceExport({
    selectedRef,
    isNoteLoading,
    flushEditorDraftRef,
    flushPendingSaves,
    hasUnsavedWork,
    notifyWarning,
    notifyError,
  });
  const taskSaveStateRef = useRef({ saveState, splitSaveState });
  useEffect(() => {
    const previous = taskSaveStateRef.current;
    const didSave =
      (saveState === "saved" && previous.saveState !== "saved") ||
      (splitSaveState === "saved" && previous.splitSaveState !== "saved");
    taskSaveStateRef.current = { saveState, splitSaveState };
    if (tasksOpen && didSave) setTaskRefreshToken((value) => value + 1);
  }, [saveState, splitSaveState, tasksOpen]);
  const persistRef = useRef(persist);
  persistRef.current = persist;

  const requestConfirm = useCallback((request: Omit<ConfirmRequest, "id">) => {
    confirmIdRef.current += 1;
    setConfirmRequest({
      ...request,
      id: confirmIdRef.current,
      returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    });
  }, []);
  useEffect(() => subscribePwa(setPwaState), []);
  const requestListTransition = useCallback(() => {
    listTransitionIntentRef.current += 1;
  }, []);
  const playPendingListTransition = useCallback(() => {
    if (listTransitionIntentRef.current === listTransitionConsumedRef.current) return;
    playListTransition();
  }, [playListTransition]);
  const invalidateCollections = useCallback(() => {
    listRequestRef.current += 1;
    invalidateNotebookRequests();
  }, [invalidateNotebookRequests]);
  const { loadNotes, loadMoreNotes, isLoadingMore, reloadNotes } = useWorkspaceNoteList({
    view,
    notebookId,
    deferredQuery,
    noteSort,
    listScope,
    notebooks,
    notesReloadToken,
    pendingLinkedNoteRef,
    nextNotesCursorRef,
    listRequestRef,
    listAbortRef,
    listScopeRef,
    trashOperationsRef,
    emptyingTrashRef,
    selectedRef,
    selectedIdRef,
    notesRef,
    setHasMoreNotes,
    setTotalNotes,
    setSelectedId,
    setNotesReloadToken,
    replaceList,
    pruneNoteSelectionTo,
    playPendingListTransition,
    notifyError,
    navigate,
  });
  useEffect(() => {
    if (!ready) return;
    void refreshNotebooks();
    reloadNotes();
  }, [ready, refreshNotebooks, reloadNotes]);
  const selectNote = useCallback(
    (id: string | null) => {
      if (id) setMemosOpen(false);
      setInNoteSearchQuery("");
      setResultSearch(null);
      setTaskNavigation(null);
      clearNoteSelection();
      if (activeNoteIdRef.current === id) return;
      flushEditorDraftRef.current();
      noteLoadRequestRef.current += 1;

      activeNoteIdRef.current = id;
      setSelectedId(id);
      setIsNoteLoading(Boolean(id));
      if (!id) {
        selectedRef.current = null;
        setSelectedNote(null);
        setCardEditingNoteId(null);
      }
    },
    [clearNoteSelection],
  );
  mobileRestoreRef.current = (context, page) => {
    flushEditorDraftRef.current();
    setOutlineOpen(false);
    setTasksOpen(page === "tasks");
    setKanbanOpen(page === "kanban");
    setMemosOpen(page === "memos");
    setView(context.view);
    setNotebookId(context.notebookId);
    setQuery(context.query);
    setNoteSort(context.sort);
    searchOriginRef.current = context.searchOrigin;
    if (page === "editor" && context.noteId) selectNote(context.noteId);
  };
  useEffect(() => {
    if (!ready || !initialLinkedNoteId || !pendingLinkedNoteRef.current) return;
    const controller = new AbortController();
    // Consume the link before creating page entries so returning to the list
    // and refreshing does not reopen the linked note.
    const linkedUrl = new URL(window.location.href);
    linkedUrl.searchParams.delete("note");
    window.history.replaceState(
      window.history.state,
      "",
      `${linkedUrl.pathname}${linkedUrl.search}${linkedUrl.hash}`,
    );
    void api
      .getNote(initialLinkedNoteId, { signal: controller.signal })
      .then(({ note }) => {
        if (controller.signal.aborted) return;
        invalidateCollections();
        selectedRef.current = note;
        setSelectedNote(noteMetadataSnapshot(note));
        setView(note.deletedAt !== null ? "trash" : "all");
        setNotebookId(note.deletedAt !== null ? undefined : note.notebookId);
        setQuery("");
        selectNote(note.id);
        setCardEditingNoteId(note.id);
        openMobileNote({
          view: note.deletedAt !== null ? "trash" : "all",
          notebookId: note.deletedAt !== null ? undefined : note.notebookId,
          query: "",
          noteId: note.id,
          searchOrigin: null,
        });
      })
      .catch((error) => {
        if (!controller.signal.aborted) notifyError(errorMessage(error, "无法打开链接中的笔记"));
      })
      .finally(() => {
        if (controller.signal.aborted) return;
        pendingLinkedNoteRef.current = null;
        const url = new URL(window.location.href);
        url.searchParams.delete("note");
        window.history.replaceState(
          window.history.state,
          "",
          `${url.pathname}${url.search}${url.hash}`,
        );
        reloadNotes();
      });
    return () => controller.abort();
  }, [openMobileNote, initialLinkedNoteId, invalidateCollections, ready, reloadNotes, selectNote]);
  useEffect(() => {
    setOutlineOpen(false);
    resetOutline();
    setAutoReadingMode(false);
  }, [resetOutline, selectedId]);
  useEffect(() => {
    if (focusMode || autoReadingMode) {
      setOutlineOpen(false);
    }
  }, [autoReadingMode, focusMode]);
  const removeFromList = useCallback(
    (noteId: string) => {
      const restoreFocus =
        document.activeElement instanceof Element &&
        Boolean(document.activeElement.closest(".note-list-panel"));
      const ordered = sortNotes(notesRef.current, noteSort);
      const index = ordered.findIndex((note) => note.id === noteId);
      if (index === -1) return;
      replaceList(notesRef.current.filter((note) => note.id !== noteId));
      setTotalNotes((value) => Math.max(0, value - 1));
      if (activeNoteIdRef.current === noteId) {
        const nextId = ordered[index + 1]?.id ?? ordered[index - 1]?.id ?? null;
        selectNote(nextId);
        setCardEditingNoteId((current) => (current === noteId ? nextId : current));
        if (restoreFocus && nextId) focusNoteRowAfterRemoval(nextId);
      }
      if (splitNoteIdRef.current === noteId) {
        closeSplitRef.current();
      }
    },
    [noteSort, replaceList, selectNote],
  );
  // Realtime updates for a single note refresh only that row, so a remote save
  // never collapses the loaded pages back to the first page.
  const patchNoteFromRemote = useCallback(
    async (noteId: string) => {
      const scope = listScopeRef.current;
      if (!notesRef.current.some((note) => note.id === noteId)) return;
      try {
        const summary = (await api.getNoteSummary(noteId)).note;
        if (scope !== listScopeRef.current) return;
        const current = notesRef.current.find((note) => note.id === noteId);
        if (!current || current.version > summary.version) return;
        if (!shouldKeepActiveNoteInList(summary, notebooks, view, deferredQuery, notebookId)) {
          removeFromList(noteId);
          return;
        }
        const merged = mergeRemoteSummary(notesRef.current, summary, noteSort);
        if (merged) replaceList(merged);
      } catch (reason) {
        if (scope !== listScopeRef.current) return;
        if (reason instanceof ApiError && reason.status === 404) removeFromList(noteId);
      }
    },
    [deferredQuery, noteSort, notebookId, notebooks, removeFromList, replaceList, view],
  );
  const removeManyFromList = useCallback(
    (noteIds: string[]) => {
      const restoreFocus =
        document.activeElement instanceof Element &&
        Boolean(document.activeElement.closest(".note-list-panel"));
      const deletedIds = new Set(noteIds);
      const currentList = notesRef.current;
      const ordered = sortNotes(currentList, noteSort);
      const visibleDeletedCount = currentList.filter((note) => deletedIds.has(note.id)).length;
      const activeId = activeNoteIdRef.current;
      const activeIndex = activeId ? ordered.findIndex((note) => note.id === activeId) : -1;
      const activeWasDeleted = Boolean(activeId && deletedIds.has(activeId));
      const nextActiveId =
        activeWasDeleted && activeIndex >= 0
          ? (ordered.slice(activeIndex + 1).find((note) => !deletedIds.has(note.id))?.id ??
            ordered
              .slice(0, activeIndex)
              .reverse()
              .find((note) => !deletedIds.has(note.id))?.id ??
            null)
          : null;

      replaceList(currentList.filter((note) => !deletedIds.has(note.id)));
      setTotalNotes((value) => Math.max(0, value - visibleDeletedCount));
      clearNoteSelection();
      if (splitNoteIdRef.current && deletedIds.has(splitNoteIdRef.current)) {
        closeSplitRef.current();
      }
      if (activeWasDeleted) {
        selectNote(nextActiveId);
        setCardEditingNoteId((current) =>
          current && deletedIds.has(current) ? nextActiveId : current,
        );
        if (restoreFocus && nextActiveId) focusNoteRowAfterRemoval(nextActiveId);
      }
    },
    [clearNoteSelection, noteSort, replaceList, selectNote],
  );
  useSelectedNoteLoader({
    ready,
    selectedId,
    selectedRef,
    activeNoteIdRef,
    noteLoadRequestRef,
    noteAbortRef,
    noteOpeningRef,
    pendingSavesRef,
    failedSavesRef,
    trashOperationsRef,
    persistRef,
    flushEditorDraftRef,
    setEditorFocusNoteId,
    setIsNoteLoading,
    setSaveState,
    setSelectedNote,
    setSelectedId,
    setCardEditingNoteId,
    notifyWarning,
    notifyError,
    navigate,
  });
  useEffect(() => {
    if (!ready) return;
    nextNotesCursorRef.current = null;
    setHasMoreNotes(false);
    const timer = setTimeout(() => void loadNotes(), 180);
    return () => {
      clearTimeout(timer);
      listRequestRef.current += 1;
    };
  }, [loadNotes, ready]);
  useEffect(
    () => () => {
      listAbortRef.current?.abort();
      noteLoadRequestRef.current += 1;
      noteAbortRef.current?.abort();
      if (realtimeRefreshTimerRef.current !== null) clearTimeout(realtimeRefreshTimerRef.current);
    },
    [],
  );
  const openCommandMenu = useCallback((initialQuery = "") => {
    setCommandInitialQuery(initialQuery);
    setCommandOpen(true);
  }, []);
  const handleReplaceRequestHandled = useCallback((token: number) => {
    setReplaceRequest((current) => (current?.token === token ? null : current));
  }, []);
  const openReplaceInCurrentNote = useCallback(() => {
    const note =
      activePane === "secondary" && splitNoteId ? splitSelectedRef.current : selectedRef.current;
    if (!note) {
      notifyWarning("当前未打开笔记，无法查找替换");
      return;
    }
    const selection = window.getSelection();
    const selectedText = selection?.anchorNode?.parentElement?.closest(".editor-panel")
      ? selection.toString()
      : "";
    setCommandOpen(false);
    setTasksOpen(false);
    if (!isMobileViewport && viewLayout === "cards" && !splitNoteId) setCardEditingNoteId(note.id);
    setReplaceRequest((current) => ({
      noteId: note.id,
      token: (current?.token ?? 0) + 1,
      query: selectedText.length <= 50 ? selectedText : "",
    }));
  }, [activePane, splitNoteId, isMobileViewport, viewLayout, notifyWarning]);
  useWorkspaceShortcuts({
    focusMode,
    autoReadingMode,
    autoReadingAvailable: !splitNoteId,
    exitAutoReadingMode,
    toggleAutoReadingMode,
    hasModalOpen: Boolean(
      commandOpen ||
      imageExportSnapshot ||
      editingNotebook !== undefined ||
      confirmRequest ||
      splitPickerOpen,
    ),
    // Escape 第 1 层：正文搜索高亮清除优先于退出沉浸模式。
    hasSearchHighlight: Boolean(inNoteSearchQuery.trim() || resultSearch),
    clearSearchHighlight: () => handleClearInNoteSearch(),
    toggleSidebar: () =>
      isMobileViewport ? openMobileHome() : setSidebarCollapsed((value) => !value),
    toggleFocusMode,
    toggleTypewriterMode,
    exitFocusMode,
    openCommandMenu,
    openReplace: openReplaceInCurrentNote,
    toggleViewLayout,
    isCardEditing: !isMobileViewport && viewLayout === "cards" && cardEditingNoteId !== null,
    onExitCardEditing: () => {
      closeSplit();
      setCardEditingNoteId(null);
      if (kanbanReturnRef.current) {
        setKanbanOpen(true);
        kanbanReturnRef.current = false;
      }
    },
    hasSelection: selectedNoteIds.size > 0,
    clearSelection: clearNoteSelection,
    outlineOpen,
    closeOutline,
    returnFocusToList: () => {
      if (kanbanReturnRef.current) {
        setKanbanOpen(true);
        kanbanReturnRef.current = false;
        return;
      }
      if (isMobileViewport) {
        backMobilePage();
        return;
      }
      if (viewLayout === "three-column" && selectedId) {
        const row = document.querySelector<HTMLButtonElement>(
          `[data-note-id="${CSS.escape(selectedId)}"] .note-row`,
        );
        row?.focus();
      }
    },
  });

  const onNoteChange = useWorkspaceNoteChange({
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
  });
  const registerEditorMarkdownReader = useCallback((reader: (() => string | null) | null) => {
    editorMarkdownReaderRef.current = reader;
  }, []);
  const registerEditorMarkdownDirty = useCallback((noteId: string, isDirty: boolean) => {
    if (isDirty) editorMarkdownDirtyNoteRef.current = noteId;
    else if (editorMarkdownDirtyNoteRef.current === noteId)
      editorMarkdownDirtyNoteRef.current = null;
  }, []);
  const flushActiveEditorDraft = useCallback(() => {
    const current = selectedRef.current;
    if (current && !trashOperationsRef.current.has(current.id)) {
      const markdown = editorMarkdownReaderRef.current?.();
      if (markdown != null && markdown !== current.contentMarkdown) {
        const next = { ...current, contentMarkdown: markdown };
        selectedRef.current = next;
        persistRef.current(next, ["contentMarkdown"]);
      }
    }
    const split = splitSelectedRef.current;
    if (split && !trashOperationsRef.current.has(split.id)) {
      const markdown = splitMarkdownReaderRef.current?.();
      if (markdown != null && markdown !== split.contentMarkdown) {
        const next = { ...split, contentMarkdown: markdown };
        splitSelectedRef.current = next;
        persistRef.current(next, ["contentMarkdown"]);
      }
    }
  }, []);
  flushEditorDraftRef.current = flushActiveEditorDraft;
  const revealCreatedNote = useCallback(
    (note: Note, target: { view: NoteView; notebookId?: string }) => {
      flushEditorDraftRef.current();
      setMemosOpen(false);
      invalidateCollections();
      searchOriginRef.current = null;
      setView(target.view);
      setNotebookId(target.notebookId);
      setQuery("");
      replaceList([
        toNoteSummary(note),
        ...notesRef.current.filter((currentNote) => currentNote.id !== note.id),
      ]);
      setTotalNotes((value) => value + 1);
      playListTransition();
      setSelectedNote(noteMetadataSnapshot(note));
      setIsNoteLoading(true);
      selectedRef.current = note;
      activeNoteIdRef.current = note.id;
      clearPendingForNote(note.id);
      setEditorFocusNoteId(note.id);
      setSelectedId(note.id);
      setCardEditingNoteId(note.id);
      openMobileNote({ ...target, query: "", noteId: note.id, searchOrigin: null });
    },
    [openMobileNote, playListTransition],
  );
  const { creatingNote, createNoteHere, createNoteInInbox, createNoteInNotebook } =
    useWorkspaceNoteCreation({
      view,
      notebookId,
      notebooks,
      revealCreatedNote,
      flushEditorDraft: flushActiveEditorDraft,
      refreshNotebooks,
      notifyError,
      navigate,
    });
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
  const refreshSelectedNoteFromRemote = useCallback(
    (noteId: string) =>
      refreshSelectedNote(noteId, {
        selectedRef,
        activeNoteIdRef,
        noteAbortRef,
        noteOpeningRef,
        noteLoadRequestRef,
        hasPendingWork: (id) =>
          pendingSavesRef.current.has(id) ||
          failedSavesRef.current.has(id) ||
          editorMarkdownDirtyNoteRef.current === id,
        onConflict: () => {
          setSaveState("conflict");
          notifyWarning("当前笔记已在其他设备更新，请先保存或重新载入");
        },
        onUpdated: (note, reloadEditor = true) => {
          setSelectedNote(noteMetadataSnapshot(note));
          replaceList(
            notesRef.current.map((n) => (n.id === noteId ? { ...n, ...toNoteSummary(note) } : n)),
          );
          if (reloadEditor) {
            setNoteReloadToken((value) => value + 1);
            setSaveState("idle");
          }
        },
        onUnauthorized: () => navigate(`/login${window.location.search}`, { replace: true }),
        onNotFound: (id) => {
          if (notesRef.current.some((note) => note.id === id)) removeFromList(id);
          else if (activeNoteIdRef.current === id) selectNote(null);
        },
        onError: () => notifyError("同步当前笔记失败，请稍后重试"),
      }),
    [
      failedSavesRef,
      navigate,
      pendingSavesRef,
      removeFromList,
      replaceList,
      selectNote,
      setSaveState,
    ],
  );
  const refreshSplitNoteFromRemote = useCallback(
    (noteId: string) =>
      refreshSelectedNote(noteId, {
        selectedRef: splitSelectedRef,
        activeNoteIdRef: splitNoteIdRef,
        noteAbortRef: splitAbortRef,
        noteOpeningRef: splitNoteOpeningRef,
        noteLoadRequestRef: splitLoadRequestRef,
        hasPendingWork: (id) =>
          pendingSavesRef.current.has(id) ||
          failedSavesRef.current.has(id) ||
          splitMarkdownDirtyNoteRef.current === id,
        onConflict: () => {
          setSplitSaveState("conflict");
          notifyWarning("分栏中的笔记已在其他设备更新，请先保存或重新载入");
        },
        onUpdated: (note, reloadEditor = true) => {
          setSplitSelectedNote(noteMetadataSnapshot(note));
          replaceList(
            notesRef.current.map((n) => (n.id === noteId ? { ...n, ...toNoteSummary(note) } : n)),
          );
          if (reloadEditor) {
            setSplitNoteReloadToken((value) => value + 1);
            setSplitSaveState("idle");
          }
        },
        onUnauthorized: () => navigate(`/login${window.location.search}`, { replace: true }),
        onNotFound: () => {
          if (splitNoteIdRef.current === noteId) closeSplitRef.current();
        },
        onError: () => notifyError("同步分栏笔记失败，请稍后重试"),
      }),
    [failedSavesRef, navigate, pendingSavesRef, replaceList],
  );
  const deleteNotebook = useCallback(
    async (id: string) => {
      const target = notebooks.find((notebook) => notebook.id === id);
      if (!target || target.isSystem) throw new Error("无法删除此笔记本");
      await flushNotebookSaves(id);
      try {
        await api.deleteNotebook(id, target.totalCount);
      } catch (reason) {
        if (reason instanceof ApiError && reason.code === "NOTEBOOK_COUNT_MISMATCH")
          void refreshNotebooks();
        throw reason;
      }
      const activeNote = selectedRef.current;
      if (activeNote?.notebookId === id) await refreshSelectedNoteFromRemote(activeNote.id);
      setNotebooks((current) => current.filter((notebook) => notebook.id !== id));
      if (notebookId === id) setNotebookId(undefined);
      refreshNotebooks();
      void loadNotes();
      setEditingNotebook(undefined);
    },
    [
      flushNotebookSaves,
      loadNotes,
      notebookId,
      notebooks,
      refreshNotebooks,
      refreshSelectedNoteFromRemote,
    ],
  );
  const toggleFavorite = useCallback(() => {
    const current = selectedRef.current;
    if (!current) return;
    const next = { ...current, isFavorite: !current.isFavorite };
    selectedRef.current = next;
    setSelectedNote(noteMetadataSnapshot(next));
    if (view !== "favorites" || next.isFavorite) {
      persist(next);
      return;
    }

    const scope = listScopeRef.current;
    void saveImmediately(next, false, ["isFavorite"])
      .then(() => {
        if (scope === listScopeRef.current) removeFromList(current.id);
      })
      .catch(() => undefined);
  }, [persist, removeFromList, saveImmediately, view]);
  const {
    moveToTrash,
    restoreFromTrash,
    trashNote,
    trashNotes,
    deleteSelectedNotes,
    restoreSelectedNotes,
    permanentDeleteNote,
    handleNoteSwipeAction,
    emptyTrash,
  } = useTrashActions({
    state: { view, noteSort, totalNotes, pendingTrashCount },
    refs: {
      selectedRef,
      notesRef,
      noteSelectionRef,
      listScopeRef,
      pendingSavesRef,
      trashOperationsRef,
      emptyingTrashRef,
      flushEditorDraftRef,
    },
    saveQueue: { runSave, saveImmediately, clearPendingForNote },
    list: {
      invalidateCollections,
      removeFromList,
      removeManyFromList,
      replaceList,
      selectNote,
      reloadNotes,
      refreshNotebooks,
    },
    ui: { setPendingTrashCount, setEmptyingTrash, setNotebooks, requestConfirm, notifyError },
  });
  const handleMoveNotesToNotebook = useCallback(
    async (ids: string[], targetNotebookId: string) => {
      if (!ids.length) return;
      const result = await moveSelectedNotes(ids, {
        flushEditorDraft: () => flushEditorDraftRef.current(),
        saveNote: runSave,
        getVersion: (id) => notesRef.current.find((note) => note.id === id)?.version,
        moveNote: (id, version) =>
          api.updateNote(id, { version, notebookId: targetNotebookId }, { response: "summary" }),
        refresh: () => {
          void loadNotes();
          void refreshNotebooks();
        },
      });
      if ("failed" in result) {
        notifyError(errorMessage(result.error, "移动笔记失败"));
      } else {
        clearNoteSelection();
      }
    },
    [clearNoteSelection, loadNotes, refreshNotebooks, notifyError, runSave],
  );

  const handleTrashNotes = useCallback(
    (ids: string[]) => {
      if (!ids.length) return;
      void trashNotes(ids);
    },
    [trashNotes],
  );

  const handleToggleFavoriteNote = useCallback(
    async (target: NoteSummary) => {
      const isFavorite = !target.isFavorite;
      try {
        await saveFavorite(target.id, isFavorite);
        if (view === "favorites" && !isFavorite) removeFromList(target.id);
      } catch (reason) {
        notifyError(errorMessage(reason, "操作失败"));
      }
    },
    [removeFromList, saveFavorite, notifyError, view],
  );
  const {
    kanbanColumns,
    kanbanColumnsRef,
    kanbanLoading,
    setKanbanRefreshToken,
    loadMoreKanbanColumn,
    handleMoveCard: handleMoveKanbanCard,
    handleRemoveCard: handleRemoveKanbanCard,
    handleTrashCard: handleTrashKanbanCard,
    handleCreateNoteInColumn: handleCreateNoteInKanbanColumn,
    handleAddExistingNote: handleAddExistingNoteToKanban,
    handleToggleFavoriteCard: handleToggleFavoriteKanbanCard,
  } = useWorkspaceKanbanData({
    kanbanOpen,
    notebooks,
    notifyError,
    notifyInfo,
    onTrashCard: trashNote,
    onToggleFavoriteNote: handleToggleFavoriteNote,
  });

  const reloadSelectedNote = useCallback(async () => {
    const current = selectedRef.current;
    if (!current) return;
    setIsNoteLoading(true);
    try {
      const result = await api.getNote(current.id);
      if (selectedRef.current?.id !== result.note.id) return;
      clearPendingForNote(current.id);
      selectedRef.current = result.note;
      setSelectedNote(noteMetadataSnapshot(result.note));
      setNoteReloadToken((value) => value + 1);
      setSaveState("idle");
    } catch {
      notifyError("重新载入失败，请重试");
    } finally {
      setIsNoteLoading(false);
    }
  }, [clearPendingForNote, setSaveState]);
  const requestConflictReload = useCallback(() => {
    requestConfirm({
      eyebrow: "版本冲突",
      title: "重新载入最新版本？",
      description:
        "这篇笔记已在别处更新。重新载入会使用服务器上的最新内容替换当前编辑，本地尚未保存的修改将丢失。",
      confirmLabel: "重新载入",
      onConfirm: () => void reloadSelectedNote(),
    });
  }, [reloadSelectedNote, requestConfirm]);

  const {
    requestSplitConflictReload,
    flushSecondaryDraft,
    closeSplit,
    openInSplit,
    handleToggleSplit,
    handleSelectSplitNote,
    onSplitNoteChange,
  } = useWorkspaceSplit({
    ready,
    splitNoteId,
    splitNoteIdRef,
    splitSelectedRef,
    splitLoadRequestRef,
    splitAbortRef,
    splitMarkdownReaderRef,
    closeSplitRef,
    pendingSavesRef,
    failedSavesRef,
    clearPendingForNote,
    persistRef,
    persist,
    trashOperationsRef,
    notesRef,
    notebooks,
    setSplitIsNoteLoading,
    setSplitSaveState,
    setSplitNoteId,
    setSplitSelectedNote,
    setSplitNoteReloadToken,
    setActivePane,
    setResultSearch,
    requestConfirm,
    notifyWarning,
    isMobileViewport,
    viewLayout,
    cardEditingNoteId,
    selectedId,
    setCardEditingNoteId,
    selectNote,
    setSplitPickerOpen,
    setEditorFocusNoteId,
    setSidebarCollapsed,
    replaceList,
  });

  const handleSplitMoveToTrash = useCallback(() => {
    if (splitSelectedRef.current) {
      handleNoteSwipeAction(toNoteSummary(splitSelectedRef.current), "trash");
      closeSplit();
    }
  }, [closeSplit, handleNoteSwipeAction]);
  const handleSplitRestore = useCallback(() => {
    if (splitSelectedRef.current) {
      handleNoteSwipeAction(toNoteSummary(splitSelectedRef.current), "restore");
    }
  }, [handleNoteSwipeAction]);
  const handleSplitPermanentDelete = useCallback(() => {
    if (splitSelectedRef.current) {
      handleNoteSwipeAction(toNoteSummary(splitSelectedRef.current), "permanent-delete");
      closeSplit();
    }
  }, [closeSplit, handleNoteSwipeAction]);
  const handleRealtimeChange = useCallback(
    (message?: WorkspaceChangeMessage) => {
      accumulateRealtimeRefresh(
        pendingRealtimeRefreshRef.current,
        message,
        Boolean(deferredQuery.trim()),
      );
      if (realtimeRefreshTimerRef.current !== null) return;
      realtimeRefreshTimerRef.current = setTimeout(() => {
        realtimeRefreshTimerRef.current = null;
        const next = pendingRealtimeRefreshRef.current;
        pendingRealtimeRefreshRef.current = emptyRealtimeRefreshPlan();
        if (next.memos && memosOpen) setMemoRefreshToken((value) => value + 1);
        if (next.notes || next.noteIds.size || next.notebooks) {
          if (tasksOpen) setTaskRefreshToken((value) => value + 1);
          if (kanbanOpen) setKanbanRefreshToken((value) => value + 1);
        }
        if (next.notebooks) void refreshNotebooks();
        if (next.notes) {
          reloadNotes();
        }
        const activeId = activeNoteIdRef.current;
        if (activeId && (next.selected || next.noteIds.has(activeId)))
          void refreshSelectedNoteFromRemote(activeId);
        const currentSplitId = splitNoteIdRef.current;
        if (currentSplitId && (next.selected || next.noteIds.has(currentSplitId))) {
          void refreshSplitNoteFromRemote(currentSplitId);
        }
        for (const noteId of next.noteIds) {
          if (!next.notes && noteId !== activeId && noteId !== currentSplitId)
            void patchNoteFromRemote(noteId);
        }
      }, 50);
    },
    [
      deferredQuery,
      memosOpen,
      tasksOpen,
      kanbanOpen,
      patchNoteFromRemote,
      refreshNotebooks,
      refreshSelectedNoteFromRemote,
      refreshSplitNoteFromRemote,
      reloadNotes,
    ],
  );
  useWorkspaceRealtime({ ready, onChange: handleRealtimeChange });
  const selectView = useCallback(
    (next: NoteView) => {
      setTasksOpen(false);
      setKanbanOpen(false);
      setMemosOpen(false);
      kanbanReturnRef.current = false;
      if (view !== next || notebookId || query) requestListTransition();
      searchOriginRef.current = null;
      setQuery("");
      setView(next);
      setNotebookId(undefined);
      setCardEditingNoteId(null);
      openMobileList({ view: next, notebookId: undefined, query: "", searchOrigin: null });
    },
    [openMobileList, notebookId, query, requestListTransition, view],
  );
  const openTasks = useCallback(async () => {
    flushSecondaryDraft();
    await flushPendingSaves("now");
    if (hasUnsavedWork()) {
      notifyWarning("仍有内容未保存，请保存成功后再查看任务");
      return;
    }
    if (query) setQuery("");
    setView("all");
    setNotebookId(undefined);
    setKanbanOpen(false);
    setMemosOpen(false);
    setTasksOpen(true);
    kanbanReturnRef.current = false;
    openMobileTasks({ view: "all", notebookId: undefined, query: "", searchOrigin: null });
  }, [
    flushPendingSaves,
    flushSecondaryDraft,
    hasUnsavedWork,
    notifyWarning,
    openMobileTasks,
    query,
  ]);
  const openKanban = useCallback(async () => {
    flushSecondaryDraft();
    await flushPendingSaves("now");
    if (hasUnsavedWork()) {
      notifyWarning("仍有内容未保存，请保存成功后再查看看板");
      return;
    }
    if (query) setQuery("");
    setView("all");
    setNotebookId(undefined);
    setTasksOpen(false);
    setMemosOpen(false);
    setKanbanOpen(true);
    kanbanReturnRef.current = false;
    openMobileKanban({ view: "all", notebookId: undefined, query: "", searchOrigin: null });
  }, [
    flushPendingSaves,
    flushSecondaryDraft,
    hasUnsavedWork,
    notifyWarning,
    openMobileKanban,
    query,
  ]);
  const openMemos = useCallback(async () => {
    flushSecondaryDraft();
    await flushPendingSaves("now");
    if (hasUnsavedWork()) {
      notifyWarning("仍有内容未保存，请保存成功后再查看随记");
      return;
    }
    if (query) setQuery("");
    setView("all");
    setNotebookId(undefined);
    setTasksOpen(false);
    setKanbanOpen(false);
    setMemosOpen(true);
    kanbanReturnRef.current = false;
    openMobileMemos({ view: "all", notebookId: undefined, query: "", searchOrigin: null });
  }, [
    flushPendingSaves,
    flushSecondaryDraft,
    hasUnsavedWork,
    notifyWarning,
    openMobileMemos,
    query,
  ]);
  const openKanbanNote = useCallback(
    (noteId: string) => {
      flushEditorDraftRef.current();
      flushSecondaryDraft();
      kanbanReturnRef.current = true;
      setKanbanOpen(false);
      setQuery("");
      setView("all");
      setNotebookId(undefined);
      if (splitNoteId) closeSplit();
      if (viewLayout === "cards") {
        setCardEditingNoteId(noteId);
      } else {
        setCardEditingNoteId(null);
      }
      selectNote(noteId);
      openMobileNote({ view: "all", notebookId: undefined, query: "", noteId });
    },
    [closeSplit, flushSecondaryDraft, openMobileNote, selectNote, splitNoteId, viewLayout],
  );
  const { selectTask, handleToggleTask, handleTaskNavigationMissing } = useWorkspaceTaskActions({
    flushEditorDraftRef,
    flushSecondaryDraft,
    selectedRef,
    splitSelectedRef,
    setQuery,
    setView,
    setNotebookId,
    splitNoteId,
    closeSplit,
    setCardEditingNoteId,
    viewLayout,
    selectNote,
    setTaskNavigation,
    setTaskRefreshToken,
    taskNavigationTokenRef,
    openMobileNote,
    taskMutationsInFlightRef,
    setTaskMutationNoteId,
    setTaskMutationOrdinal,
    flushPendingSaves,
    hasUnsavedWork,
    notifyWarning,
    notifyError,
    setSelectedNote,
    setNoteReloadToken,
    setSplitSelectedNote,
    setSplitNoteReloadToken,
    notesRef,
    replaceList,
  });
  const selectNotebook = useCallback(
    (notebookIdToSelect: string) => {
      setTasksOpen(false);
      setKanbanOpen(false);
      setMemosOpen(false);
      kanbanReturnRef.current = false;
      if (notebookId !== notebookIdToSelect || view !== "all" || query) requestListTransition();
      searchOriginRef.current = null;
      setQuery("");
      setNotebookId(notebookIdToSelect);
      setView("all");
      setCardEditingNoteId(null);
      openMobileList({
        view: "all",
        notebookId: notebookIdToSelect,
        query: "",
        searchOrigin: null,
      });
    },
    [openMobileList, notebookId, query, requestListTransition, view],
  );
  const changeQuery = useCallback(
    (next: string) => {
      setTasksOpen(false);
      setKanbanOpen(false);
      setMemosOpen(false);
      kanbanReturnRef.current = false;
      if (next) {
        if (!query) {
          requestListTransition();
          searchOriginRef.current = { view, notebookId };
        }
        setQuery(next);
        setView("all");
        setNotebookId(undefined);
        openMobileList({
          view: "all",
          notebookId: undefined,
          query: next,
          searchOrigin: searchOriginRef.current,
        });
        return;
      }
      if (query) requestListTransition();
      const origin = searchOriginRef.current;
      searchOriginRef.current = null;
      setQuery("");
      setView(origin?.view ?? "all");
      setNotebookId(origin?.notebookId);
    },
    [notebookId, openMobileList, query, requestListTransition, view],
  );
  const handleQueryDraftChange = useCallback(
    (next: string) => {
      setQueryDraft(next);
      if (!next) changeQuery("");
    },
    [changeQuery],
  );
  const submitQuery = useCallback(() => {
    changeQuery(queryDraft.trim());
  }, [changeQuery, queryDraft]);
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
  const copyNoteMarkdown = useCallback(async () => {
    const note = selectedRef.current;
    if (!note) return;
    const markdown = editorMarkdownReaderRef.current?.() ?? note.contentMarkdown;
    try {
      await copyPlainText(markdown);
      notifyInfo("笔记 Markdown 已复制");
    } catch {
      notifyError("复制失败，请检查浏览器剪贴板权限");
    }
  }, []);
  const logout = useCallback(async () => {
    await flushPendingSaves("now");
    if (hasUnsavedWork()) {
      notifyWarning("仍有内容未保存，请稍后再退出");
      return;
    }
    try {
      await api.logout();
    } catch {
      notifyError("退出登录失败，请检查网络后重试");
      return;
    }
    navigate(`/login${window.location.search}`, { replace: true });
  }, [flushPendingSaves, hasUnsavedWork, navigate, notifyError, notifyWarning]);
  const command = useCallback(
    (id: CommandId) => {
      if (id === "logout") void logout();
      if (id === "new-note") void createNoteInInbox();
      if (id === "find-in-note") {
        const selectedText = window.getSelection()?.toString().trim() ?? "";
        const initial = selectedText && selectedText.length <= 50 ? selectedText : "";
        setCommandInitialQuery(initial);
        setCommandOpen(true);
      }
      if (id === "toggle-sidebar") {
        if (isMobileViewport) openMobileHome();
        else setSidebarCollapsed((value) => !value);
      }
      if (id === "toggle-split") handleToggleSplit();
      if (id === "toggle-view-layout") toggleViewLayout();
      if (id === "sort-notes-updated") setNoteSort("updated");
      if (id === "sort-notes-created") setNoteSort("created");
      if (id === "sort-notes-title") setNoteSort("title");
      if (id === "toggle-focus-mode") toggleFocusMode();
      if (id === "toggle-auto-reading") toggleAutoReadingMode();
      if (id === "toggle-typewriter-mode") toggleTypewriterMode();
      if (id === "set-theme-light") setThemePreference("light");
      if (id === "set-theme-dark") setThemePreference("dark");
      if (id === "set-theme-system") setThemePreference("system");
      if (id === "copy-note-markdown") void copyNoteMarkdown();
      if (id === "favorite") toggleFavorite();
      if (id === "open-kanban") void openKanban();
      if (id === "trash") moveToTrash();
      if (id === "restore") restoreFromTrash();
      if (id === "export-image") handleExportImage();
      if (id === "export-note") void handleExportNote();
      if (id === "export-library") void handleExportLibrary();
      if (id === "install-app") {
        if (pwaState.canInstall) void installPwa();
        else if (pwaState.showIosInstallHint && !pwaState.standalone)
          notifyInfo("请在 Safari 中点击分享，再选择“添加到主屏幕”");
      }
    },
    [
      logout,
      copyNoteMarkdown,
      createNoteInInbox,
      handleExportImage,
      handleExportNote,
      handleExportLibrary,
      isMobileViewport,
      moveToTrash,
      openKanban,
      openMobileHome,
      pwaState,
      restoreFromTrash,
      setThemePreference,
      toggleFavorite,
      toggleFocusMode,
      toggleTypewriterMode,
      toggleViewLayout,
    ],
  );
  useEffect(() => {
    if (!ready || shortcutHandledRef.current) return;
    const action = new URLSearchParams(window.location.search).get("action");
    if (action === "new-note") void createNoteInInbox();
    if (action === "search") {
      openMobileList();
      requestAnimationFrame(() => searchRef.current?.focus());
    }
    shortcutHandledRef.current = true;
    if (action)
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${window.location.hash}`,
      );
  }, [createNoteInInbox, openMobileList, ready]);
  const updatePwa = useCallback(async () => {
    await flushPendingSaves("now");
    if (hasUnsavedWork()) {
      notifyWarning("仍有编辑内容未保存，更新已暂缓");
      return;
    }
    applyPwaUpdate();
  }, [flushPendingSaves, hasUnsavedWork]);

  const { handleNavigateWikiLinkPrimary, handleNavigateWikiLinkSplit, handleCreateAndLinkNote } =
    useWorkspaceWikiLinks({
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
    });
  const handleNewNote = useCallback(() => {
    void createNoteHere();
  }, [createNoteHere]);
  const handleNewInboxNote = useCallback(() => {
    void createNoteInInbox();
  }, [createNoteInInbox]);
  const handleCreateNotebook = useCallback(() => {
    createNotebook();
  }, [createNotebook]);
  const handleEditNotebook = useCallback((target: Notebook) => setEditingNotebook(target), []);
  const handleDeleteNotebook = useCallback(
    (target: Notebook) =>
      requestConfirm({
        eyebrow: "删除笔记本",
        title: `删除笔记本“${target.name}”？`,
        description: "笔记本中的笔记会自动移入收件箱，笔记内容不会被删除。",
        confirmLabel: "删除笔记本",
        danger: true,
        onConfirm: () => deleteNotebook(target.id),
      }),
    [deleteNotebook, requestConfirm],
  );
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
  const handleCardGridScrollPositionChange = useCallback((scope: string, top: number) => {
    cardGridScrollPositionRef.current = { scope, top };
  }, []);
  const handleOpenSidebar = useCallback(() => {
    openMobileHome();
  }, [openMobileHome]);
  const handleOpenList = useCallback(() => {
    if (kanbanReturnRef.current) {
      flushEditorDraftRef.current();
      closeOutline();
      setKanbanOpen(true);
      kanbanReturnRef.current = false;
      if (isMobileViewport) backMobilePage();
      else setCardEditingNoteId(null);
      return;
    }
    if (isMobileViewport) {
      flushEditorDraftRef.current();
      closeOutline();
      backMobilePage();
      return;
    }
    if (viewLayout === "cards") {
      setCardEditingNoteId(null);
      return;
    }
  }, [backMobilePage, closeOutline, isMobileViewport, viewLayout]);
  const handleUploadImage = useCallback((file: File) => api.uploadAsset(file), []);
  const handleScrollToOutlineItem = useCallback(
    (id: string) => outlineNavigateRef.current?.(id),
    [],
  );
  const handleClearQuery = useCallback(() => changeQuery(""), [changeQuery]);
  useEffect(() => {
    if (!ready || !isMobileViewport || isNoteLoading) return;
    const frame = requestAnimationFrame(() => {
      if (document.activeElement?.closest(".mobile-bottom-search")) return;
      const selector =
        mobilePage === "home"
          ? "#mobile-notebooks-title"
          : mobilePage === "list"
            ? ".mobile-collection-header h2"
            : mobilePage === "tasks"
              ? ".tasks-back"
              : ".mobile-editor-title";
      document.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [isMobileViewport, isNoteLoading, mobilePage, ready]);
  useMobileViewport(isMobileViewport && ready);

  const handleWorkspaceContextMenu = createWorkspaceContextMenuHandler({
    openWorkspaceMenu,
    searchRef,
    changeQuery,
    openKanbanNote,
    handleToggleFavoriteKanbanCard,
    kanbanColumnsRef,
    handleMoveKanbanCard,
    handleRemoveKanbanCard,
    handleTrashKanbanCard,
    handleCreateNoteInKanbanColumn,
    notesRef,
    pendingTrashCount,
    emptyingTrash,
    view,
    selectedNoteIds,
    clearNoteSelection,
    viewLayout,
    handleOpenCardNote,
    selectNote,
    isMobileViewport,
    openInSplit,
    handleToggleCardSelection,
    handleNoteSwipeAction,
    restoreSelectedNotes,
    deleteSelectedNotes,
    handleToggleFavoriteNote,
    handleAddExistingNoteToKanban,
    notebooks,
    selectNotebook,
    createNoteInNotebook,
    handleEditNotebook,
    handleDeleteNotebook,
    sidebarCollapsed,
    handleNewInboxNote,
    handleCreateNotebook,
    selectView,
    handleCollapseSidebar: toggleSidebar,
    closeOutline,
    query,
    totalNotes,
    handleNewNote,
    toggleViewLayout,
    handleClearQuery,
    emptyTrash,
  });

  if (connectionError)
    return (
      <main className="app-loading" role="alert">
        <span>{connectionError}</span>
        <button className="secondary-button" type="button" onClick={retry}>
          重试
        </button>
      </main>
    );
  if (!ready)
    return (
      <main className="app-loading">
        <span className="loading-ring" />
        <span>正在进入你的空间……</span>
      </main>
    );
  const currentNotebook = notebookId
    ? notebooks.find((notebook) => notebook.id === notebookId)
    : undefined;
  const listNewNote = currentNotebook ? handleNewNote : undefined;
  // selectedNote 只保留元数据；正文从 selectedRef 单独传入，纯正文同步不更新 React state。
  // 这样 memo(NoteEditor) 不会因每次输入触发的 Markdown 同步而重渲染，也不会在 state 中留住旧正文。
  const renderedNote =
    selectedNote && selectedRef.current?.id === selectedNote.id
      ? selectedNote
      : (selectedRef.current ?? selectedNote);
  const renderedNoteContent =
    renderedNote && selectedRef.current?.id === renderedNote.id
      ? selectedRef.current.contentMarkdown
      : (renderedNote?.contentMarkdown ?? "");
  const splitRenderedNote =
    splitSelectedNote && splitSelectedRef.current?.id === splitSelectedNote.id
      ? splitSelectedNote
      : (splitSelectedRef.current ?? splitSelectedNote);
  const splitRenderedNoteContent =
    splitRenderedNote && splitSelectedRef.current?.id === splitRenderedNote.id
      ? splitSelectedRef.current.contentMarkdown
      : (splitRenderedNote?.contentMarkdown ?? "");
  const commandNoteReady = Boolean(
    (!isMobileViewport || mobilePage === "editor") &&
    renderedNote &&
    selectedRef.current?.id === renderedNote.id &&
    !isNoteLoading,
  );
  const isCardsLayout = !isMobileViewport && viewLayout === "cards";
  const showCardsGrid = !tasksOpen && !kanbanOpen && isCardsLayout && cardEditingNoteId === null;
  const editorContentInert = isMobileViewport && mobilePage !== "editor";
  if (mobilePage === "editor") mobileEditorVisitedRef.current = true;
  const mountEditor = !isMobileViewport || mobileEditorVisitedRef.current;

  return (
    <MemoWorkspaceProvider
      active={memosOpen}
      userKey={currentUserKey}
      externalRevision={memoRefreshToken}
      onUnauthorized={handleUnauthorized}
    >
      <div
        onContextMenu={handleWorkspaceContextMenu}
        onKeyDown={(event) => {
          if (
            event.nativeEvent.isComposing ||
            event.keyCode === 229 ||
            !(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
          )
            return;
          const target = event.target;
          if (
            !(target instanceof HTMLElement) ||
            target.closest("dialog, input, textarea, [contenteditable='true'], .editor-panel")
          )
            return;
          const rect = target.getBoundingClientRect();
          if (
            !target.dispatchEvent(
              new MouseEvent("contextmenu", {
                bubbles: true,
                cancelable: true,
                clientX: rect.left + 12,
                clientY: rect.top + 12,
              }),
            )
          )
            event.preventDefault();
        }}
        data-mobile-page={isMobileViewport ? mobilePage : undefined}
        className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${focusMode || autoReadingMode ? "is-focus-mode" : ""} ${autoReadingMode ? "is-auto-reading-mode" : ""} ${isCardsLayout ? "layout-cards" : ""} ${tasksOpen ? "is-tasks-open" : ""} ${kanbanOpen ? "is-kanban-open" : ""} ${memosOpen ? "is-memos-open" : ""}`}
      >
        {!isMobileViewport && (
          <Sidebar
            onReorderNotebooks={handleReorderNotebooks}
            reorderingNotebooks={reorderingNotebooks}
            view={view}
            setView={selectView}
            notebooks={notebooks}
            notebookId={notebookId}
            setNotebookId={selectNotebook}
            query={queryDraft}
            setQuery={handleQueryDraftChange}
            onSubmitQuery={submitQuery}
            searchRef={searchRef}
            onNewInboxNote={handleNewInboxNote}
            creatingNote={creatingNote}
            onCreateNotebook={handleCreateNotebook}
            collapsed={sidebarCollapsed}
            onCollapse={toggleSidebar}
            onMoveNotesToNotebook={handleMoveNotesToNotebook}
            onTrashNotes={handleTrashNotes}
            tasksActive={tasksOpen}
            onOpenTasks={openTasks}
            memoActive={memosOpen}
            onOpenMemo={openMemos}
            kanbanActive={kanbanOpen}
            onOpenKanban={openKanban}
          />
        )}
        {isMobileViewport && (
          <div
            className="mobile-home-region"
            hidden={mobilePage !== "home" || tasksOpen || kanbanOpen || memosOpen}
            inert={mobilePage !== "home" || tasksOpen || kanbanOpen || memosOpen}
          >
            <MobileNotebookHome
              onReorderNotebooks={handleReorderNotebooks}
              reorderingNotebooks={reorderingNotebooks}
              view={view}
              setView={selectView}
              notebooks={notebooks}
              notebookId={notebookId}
              setNotebookId={selectNotebook}
              onCreateNotebook={handleCreateNotebook}
              onEditNotebook={handleEditNotebook}
              onDeleteNotebook={handleDeleteNotebook}
              onLogout={logout}
              onOpenTasks={openTasks}
              onOpenMemo={openMemos}
              onOpenKanban={openKanban}
              active={mobilePage === "home"}
            />
          </div>
        )}
        {shouldShowMemoPage(memosOpen, isMobileViewport, mobilePage) && (
          <Suspense fallback={<NoteLoadingState />}>
            <LazyMemoPage
              isMobileViewport={isMobileViewport}
              onBack={isMobileViewport ? backMobilePage : undefined}
              onConverted={(note) => {
                revealCreatedNote(note, { view: "inbox", notebookId: note.notebookId });
                void refreshNotebooks();
                notifyInfo("随记已转为笔记，原随记已移除");
              }}
            />
          </Suspense>
        )}
        {shouldShowTasksPanel(tasksOpen, isMobileViewport, mobilePage) && (
          <TasksPanel
            tasks={tasks}
            total={currentTaskSnapshot?.total ?? 0}
            hasMore={currentTaskSnapshot !== null && currentTaskSnapshot.nextCursor !== null}
            loadingMore={tasksMoreLoading}
            loadMoreError={tasksMoreError}
            notebooks={notebooks}
            notebookId={taskNotebookId}
            status={taskStatus}
            loading={tasksLoading}
            busyTask={
              taskMutationNoteId !== null && taskMutationOrdinal !== null
                ? { noteId: taskMutationNoteId, ordinal: taskMutationOrdinal }
                : null
            }
            error={tasksError}
            onRetry={() => setTaskRefreshToken((value) => value + 1)}
            onNotebookChange={setTaskNotebookId}
            onStatusChange={setTaskStatus}
            onSelectTask={selectTask}
            onToggleTask={handleToggleTask}
            onLoadMore={loadMoreTasks}
            onBack={isMobileViewport ? backMobilePage : undefined}
          />
        )}
        {shouldShowKanbanPanel(kanbanOpen, isMobileViewport, mobilePage) && (
          <KanbanPanel
            columns={kanbanColumns}
            loading={kanbanLoading}
            onOpenNote={openKanbanNote}
            onCreateNoteInColumn={handleCreateNoteInKanbanColumn}
            onAddExistingNote={handleAddExistingNoteToKanban}
            onMoveCard={handleMoveKanbanCard}
            onTrashCard={handleTrashKanbanCard}
            onLoadMoreColumn={loadMoreKanbanColumn}
            onToggleFavorite={handleToggleFavoriteKanbanCard}
            onBack={isMobileViewport ? backMobilePage : undefined}
            isMobileViewport={isMobileViewport}
            availableNotes={notes}
          />
        )}
        {!tasksOpen && !kanbanOpen && !memosOpen && !isCardsLayout && (
          <NoteListPanel
            notes={notes}
            total={totalNotes}
            hasMore={hasMoreNotes}
            selectedId={selectedId}
            selectedIds={selectedNoteIds}
            onSelect={handleSelectListNote}
            onToggleFavoriteNote={handleToggleFavoriteNote}
            onDeleteSelected={deleteSelectedNotes}
            onNoteSwipeAction={handleNoteSwipeAction}
            view={view}
            query={query}
            currentNotebookName={currentNotebook?.name}
            onEmptyTrash={view === "trash" ? emptyTrash : undefined}
            trashBusy={pendingTrashCount > 0 || emptyingTrash}
            onNewNote={listNewNote}
            creatingNote={creatingNote}
            onClearQuery={handleClearQuery}
            isMobileViewport={isMobileViewport}
            onOpenSidebar={handleOpenSidebar}
            transitionToken={listTransitionToken}
            outlineOpen={!isMobileViewport && outlineOpen}
            outlineItems={
              activePane === "secondary" && splitNoteId ? splitOutlineItems : outlineItems
            }
            activeOutlineId={
              activePane === "secondary" && splitNoteId ? splitActiveOutlineId : activeOutlineId
            }
            onScrollToOutlineItem={
              activePane === "secondary" && splitNoteId
                ? (id) => splitOutlineNavigateRef.current?.(id)
                : handleScrollToOutlineItem
            }
            onCloseOutline={closeOutline}
            onLoadMore={loadMoreNotes}
            isLoadingMore={isLoadingMore}
            virtualizationScope={listScope}
            onFocusEditor={() => {
              if (selectedId) setEditorFocusNoteId(selectedId);
            }}
            inert={isMobileViewport && mobilePage !== "list"}
          />
        )}
        {showCardsGrid && (
          <NoteCardGridPanel
            notes={notes}
            total={totalNotes}
            hasMore={hasMoreNotes}
            isMobileViewport={isMobileViewport}
            selectedIds={selectedNoteIds}
            onOpenNote={handleOpenCardNote}
            onToggleSelectNote={handleToggleCardSelection}
            onDeleteSelected={deleteSelectedNotes}
            view={view}
            query={query}
            sort={noteSort}
            onClearQuery={handleClearQuery}
            notebooks={notebooks}
            onToggleFavoriteNote={handleToggleFavoriteNote}
            onEmptyTrash={view === "trash" ? emptyTrash : undefined}
            trashBusy={pendingTrashCount > 0 || emptyingTrash}
            transitionToken={listTransitionToken}
            onOpenSidebar={handleOpenSidebar}
            onLoadMore={loadMoreNotes}
            isLoadingMore={isLoadingMore}
            scrollScope={listScope}
            initialScrollTop={
              cardGridScrollPositionRef.current.scope === listScope
                ? cardGridScrollPositionRef.current.top
                : 0
            }
            onScrollPositionChange={handleCardGridScrollPositionChange}
            inert={isMobileViewport && mobilePage !== "list"}
          />
        )}
        {!memosOpen &&
          (!showCardsGrid || isMobileViewport) &&
          (!kanbanOpen || (isMobileViewport && mobilePage === "editor")) && (
            <main
              ref={editorRegionRef}
              className={`editor-region ${splitNoteId && !isMobileViewport ? "is-split" : ""}`}
              tabIndex={-1}
              aria-hidden={editorContentInert || undefined}
              inert={editorContentInert}
            >
              {splitNoteId && !isMobileViewport ? (
                <>
                  <div
                    className="split-pane split-pane-primary"
                    style={{ flex: `${splitRatio} 1 0%` }}
                  >
                    {mountEditor && renderedNote ? (
                      <ErrorBoundary
                        key={renderedNote.id}
                        fallback={(error, reset) => (
                          <EditorErrorFallback error={error} reset={reset} />
                        )}
                      >
                        <Suspense fallback={<NoteLoadingState />}>
                          <LazyNoteEditor
                            note={renderedNote}
                            contentMarkdown={renderedNoteContent}
                            availableNotes={notes}
                            onNavigateWikiLink={handleNavigateWikiLinkPrimary}
                            onCreateAndLinkNote={handleCreateAndLinkNote}
                            onSearchWikiLinkTitles={api.searchWikiNoteTitles}
                            onNavigateToNote={selectNote}
                            searchQuery={
                              resultSearch?.id === renderedNote.id
                                ? resultSearch.query
                                : inNoteSearchQuery
                            }
                            replaceRequest={
                              replaceRequest?.noteId === renderedNote.id ? replaceRequest : null
                            }
                            onReplaceRequestHandled={handleReplaceRequestHandled}
                            searchNavigationToken={
                              resultSearch?.id === renderedNote.id ? resultSearch.token : 0
                            }
                            taskNavigation={
                              taskNavigation?.noteId === renderedNote.id ? taskNavigation : null
                            }
                            onTaskNavigationMissing={handleTaskNavigationMissing}
                            onClearSearch={
                              inNoteSearchQuery || resultSearch?.id === renderedNote.id
                                ? handleClearInNoteSearch
                                : undefined
                            }
                            onMarkdownReaderChange={registerEditorMarkdownReader}
                            onMarkdownDirtyChange={registerEditorMarkdownDirty}
                            saveState={saveState}
                            isLoading={
                              isNoteLoading ||
                              creatingNote ||
                              taskMutationNoteId === renderedNote.id
                            }
                            loadingLabel={creatingNote ? "正在新建笔记…" : undefined}
                            trashBusy={
                              emptyingTrash ||
                              (pendingTrashCount > 0 &&
                                trashOperationsRef.current.has(renderedNote.id))
                            }
                            reloadToken={noteReloadToken}
                            focusRequested={editorFocusNoteId === renderedNote.id && !commandOpen}
                            onFocusHandled={handleEditorFocus}
                            onChange={onNoteChange}
                            onSaveNow={saveNoteNow}
                            onReloadNote={requestConflictReload}
                            onExportImage={handleExportImage}
                            onToggleFavorite={toggleFavorite}
                            onMoveToTrash={moveToTrash}
                            onRestore={restoreFromTrash}
                            onPermanentDelete={permanentDeleteNote}
                            onOpenList={handleOpenList}
                            isMobileViewport={false}
                            mobileBackLabel={
                              kanbanReturnRef.current
                                ? "看板"
                                : query
                                  ? "搜索结果"
                                  : (currentNotebook?.name ?? viewLabel(view))
                            }
                            onBackToKanban={
                              kanbanReturnRef.current
                                ? () => {
                                    closeSplit();
                                    setCardEditingNoteId(null);
                                    setKanbanOpen(true);
                                    kanbanReturnRef.current = false;
                                  }
                                : undefined
                            }
                            onBackToCards={
                              !kanbanReturnRef.current && isCardsLayout && !tasksOpen
                                ? () => {
                                    closeSplit();
                                    setCardEditingNoteId(null);
                                  }
                                : undefined
                            }
                            onUploadImage={handleUploadImage}
                            focusMode={focusMode}
                            typewriterMode={typewriterMode}
                            outlineOpen={outlineOpen && activePane === "primary"}
                            outlineItems={outlineItems}
                            activeOutlineId={activeOutlineId}
                            onToggleOutline={() => {
                              setActivePane("primary");
                              toggleOutline();
                            }}
                            onCloseOutline={closeOutline}
                            onOutlineItemsChange={handleOutlineItemsChange}
                            onOutlineActiveChange={handleOutlineActiveChange}
                            onOutlineNavigationReady={handleOutlineNavigationReady}
                            onToggleSplit={
                              !isMobileViewport && viewLayout === "cards"
                                ? handleToggleSplit
                                : undefined
                            }
                            isSplitActive={true}
                            isActivePane={activePane === "primary"}
                            onActivatePane={() => setActivePane("primary")}
                          />
                        </Suspense>
                      </ErrorBoundary>
                    ) : isNoteLoading ? (
                      <NoteLoadingState />
                    ) : (
                      <EmptyEditor
                        isTrash={view === "trash"}
                        onNewNote={handleNewNote}
                        creatingNote={creatingNote}
                        onOpenList={handleOpenList}
                        transitionToken={listTransitionToken}
                      />
                    )}
                  </div>
                  <SplitResizer
                    splitRatio={splitRatio}
                    onSplitRatioChange={setSplitRatio}
                    containerRef={editorRegionRef}
                  />
                  <div
                    className="split-pane split-pane-secondary"
                    style={{ flex: `${1 - splitRatio} 1 0%` }}
                  >
                    {splitRenderedNote ? (
                      <ErrorBoundary
                        key={splitRenderedNote.id}
                        fallback={(error, reset) => (
                          <EditorErrorFallback error={error} reset={reset} />
                        )}
                      >
                        <Suspense fallback={<NoteLoadingState />}>
                          <LazyNoteEditor
                            note={splitRenderedNote}
                            contentMarkdown={splitRenderedNoteContent}
                            availableNotes={notes}
                            onNavigateWikiLink={handleNavigateWikiLinkSplit}
                            onCreateAndLinkNote={handleCreateAndLinkNote}
                            onSearchWikiLinkTitles={api.searchWikiNoteTitles}
                            onNavigateToNote={(id) => openInSplit(id)}
                            searchQuery={
                              resultSearch?.id === splitRenderedNote.id ? resultSearch.query : ""
                            }
                            replaceRequest={
                              replaceRequest?.noteId === splitRenderedNote.id
                                ? replaceRequest
                                : null
                            }
                            onReplaceRequestHandled={handleReplaceRequestHandled}
                            searchNavigationToken={
                              resultSearch?.id === splitRenderedNote.id ? resultSearch.token : 0
                            }
                            taskNavigation={
                              taskNavigation?.noteId === splitRenderedNote.id
                                ? taskNavigation
                                : null
                            }
                            onTaskNavigationMissing={handleTaskNavigationMissing}
                            onClearSearch={
                              resultSearch?.id === splitRenderedNote.id
                                ? handleClearInNoteSearch
                                : undefined
                            }
                            onMarkdownReaderChange={(reader) => {
                              splitMarkdownReaderRef.current = reader;
                            }}
                            onMarkdownDirtyChange={(noteId, isDirty) => {
                              if (isDirty) splitMarkdownDirtyNoteRef.current = noteId;
                              else if (splitMarkdownDirtyNoteRef.current === noteId)
                                splitMarkdownDirtyNoteRef.current = null;
                            }}
                            saveState={splitSaveState}
                            isLoading={
                              splitIsNoteLoading ||
                              creatingNote ||
                              taskMutationNoteId === splitRenderedNote.id
                            }
                            loadingLabel={creatingNote ? "正在新建笔记…" : undefined}
                            trashBusy={
                              emptyingTrash ||
                              (pendingTrashCount > 0 &&
                                trashOperationsRef.current.has(splitRenderedNote.id))
                            }
                            reloadToken={splitNoteReloadToken}
                            focusRequested={
                              splitEditorFocusNoteId === splitRenderedNote.id && !commandOpen
                            }
                            onFocusHandled={handleSplitEditorFocus}
                            onChange={onSplitNoteChange}
                            onSaveNow={() => saveNoteNow(splitRenderedNote.id)}
                            onReloadNote={() => requestSplitConflictReload(splitRenderedNote.id)}
                            onExportImage={handleExportImage}
                            onToggleFavorite={() =>
                              void handleToggleFavoriteNote(toNoteSummary(splitRenderedNote))
                            }
                            onMoveToTrash={handleSplitMoveToTrash}
                            onRestore={handleSplitRestore}
                            onPermanentDelete={handleSplitPermanentDelete}
                            onOpenList={handleOpenList}
                            isMobileViewport={false}
                            mobileBackLabel=""
                            onUploadImage={handleUploadImage}
                            focusMode={focusMode}
                            typewriterMode={typewriterMode}
                            outlineOpen={outlineOpen && activePane === "secondary"}
                            outlineItems={splitOutlineItems}
                            activeOutlineId={splitActiveOutlineId}
                            onToggleOutline={() => {
                              setActivePane("secondary");
                              toggleOutline();
                            }}
                            onCloseOutline={closeOutline}
                            onOutlineItemsChange={handleSplitOutlineItemsChange}
                            onOutlineActiveChange={handleSplitOutlineActiveChange}
                            onOutlineNavigationReady={handleSplitOutlineNavigationReady}
                            onCloseSplit={closeSplit}
                            isActivePane={activePane === "secondary"}
                            onActivatePane={() => setActivePane("secondary")}
                          />
                        </Suspense>
                      </ErrorBoundary>
                    ) : splitIsNoteLoading ? (
                      <NoteLoadingState />
                    ) : null}
                  </div>
                </>
              ) : mountEditor && renderedNote ? (
                <ErrorBoundary
                  key={renderedNote.id}
                  fallback={(error, reset) => <EditorErrorFallback error={error} reset={reset} />}
                >
                  <Suspense fallback={<NoteLoadingState />}>
                    <LazyNoteEditor
                      note={renderedNote}
                      contentMarkdown={renderedNoteContent}
                      availableNotes={notes}
                      onNavigateWikiLink={handleNavigateWikiLinkPrimary}
                      onCreateAndLinkNote={handleCreateAndLinkNote}
                      onSearchWikiLinkTitles={api.searchWikiNoteTitles}
                      onNavigateToNote={selectNote}
                      searchQuery={
                        resultSearch?.id === renderedNote.id
                          ? resultSearch.query
                          : inNoteSearchQuery
                      }
                      replaceRequest={
                        replaceRequest?.noteId === renderedNote.id ? replaceRequest : null
                      }
                      onReplaceRequestHandled={handleReplaceRequestHandled}
                      searchNavigationToken={
                        resultSearch?.id === renderedNote.id ? resultSearch.token : 0
                      }
                      taskNavigation={
                        taskNavigation?.noteId === renderedNote.id ? taskNavigation : null
                      }
                      onTaskNavigationMissing={handleTaskNavigationMissing}
                      onClearSearch={
                        inNoteSearchQuery || resultSearch?.id === renderedNote.id
                          ? handleClearInNoteSearch
                          : undefined
                      }
                      onMarkdownReaderChange={registerEditorMarkdownReader}
                      onMarkdownDirtyChange={registerEditorMarkdownDirty}
                      saveState={saveState}
                      isLoading={
                        isNoteLoading || creatingNote || taskMutationNoteId === renderedNote.id
                      }
                      loadingLabel={creatingNote ? "正在新建笔记…" : undefined}
                      trashBusy={
                        emptyingTrash ||
                        (pendingTrashCount > 0 && trashOperationsRef.current.has(renderedNote.id))
                      }
                      reloadToken={noteReloadToken}
                      focusRequested={editorFocusNoteId === renderedNote.id && !commandOpen}
                      onFocusHandled={handleEditorFocus}
                      onChange={onNoteChange}
                      onSaveNow={saveNoteNow}
                      onReloadNote={requestConflictReload}
                      onExportImage={handleExportImage}
                      onToggleFavorite={toggleFavorite}
                      onMoveToTrash={moveToTrash}
                      onRestore={restoreFromTrash}
                      onPermanentDelete={permanentDeleteNote}
                      onOpenList={handleOpenList}
                      isMobileViewport={isMobileViewport}
                      mobileBackLabel={
                        kanbanReturnRef.current
                          ? "看板"
                          : tasksOpen
                            ? "任务"
                            : query
                              ? "搜索结果"
                              : (currentNotebook?.name ?? viewLabel(view))
                      }
                      onBackToKanban={
                        kanbanReturnRef.current
                          ? () => {
                              closeSplit();
                              setCardEditingNoteId(null);
                              setKanbanOpen(true);
                              kanbanReturnRef.current = false;
                            }
                          : undefined
                      }
                      onBackToCards={
                        !kanbanReturnRef.current && isCardsLayout && !tasksOpen
                          ? () => setCardEditingNoteId(null)
                          : undefined
                      }
                      onUploadImage={handleUploadImage}
                      focusMode={focusMode}
                      autoReadingMode={autoReadingMode}
                      onToggleAutoReadingMode={toggleAutoReadingMode}
                      onExitAutoReadingMode={exitAutoReadingMode}
                      typewriterMode={typewriterMode}
                      outlineOpen={outlineOpen}
                      outlineItems={outlineItems}
                      activeOutlineId={activeOutlineId}
                      onToggleOutline={toggleOutline}
                      onCloseOutline={closeOutline}
                      onOutlineItemsChange={handleOutlineItemsChange}
                      onOutlineActiveChange={handleOutlineActiveChange}
                      onOutlineNavigationReady={handleOutlineNavigationReady}
                      onToggleSplit={
                        !isMobileViewport && viewLayout === "cards" ? handleToggleSplit : undefined
                      }
                      isSplitActive={false}
                    />
                  </Suspense>
                </ErrorBoundary>
              ) : isNoteLoading ? (
                <NoteLoadingState />
              ) : (
                <EmptyEditor
                  isTrash={view === "trash"}
                  onNewNote={handleNewNote}
                  creatingNote={creatingNote}
                  onOpenList={handleOpenList}
                  transitionToken={listTransitionToken}
                />
              )}
            </main>
          )}
        {isMobileViewport && mobilePage !== "editor" && mobilePage !== "memos" && (
          <MobileBottomBar
            query={queryDraft}
            setQuery={handleQueryDraftChange}
            onSubmitQuery={submitQuery}
            searchRef={searchRef}
            creatingNote={creatingNote}
            onNewNote={
              mobilePage === "home"
                ? handleNewInboxNote
                : view === "trash"
                  ? undefined
                  : handleNewNote
            }
          />
        )}
        <CommandMenu
          isMobileViewport={isMobileViewport}
          open={commandOpen}
          onClose={closeCommandMenu}
          onCommand={command}
          onCreateNoteInNotebook={createNoteInNotebook}
          canRestore={Boolean(commandNoteReady && renderedNote?.deletedAt)}
          canMoveToTrash={Boolean(commandNoteReady && renderedNote && !renderedNote.deletedAt)}
          notebooks={notebooks}
          currentNotebookId={renderedNote?.notebookId}
          onMoveNoteToNotebook={(targetNotebookId) =>
            onNoteChange({ notebookId: targetNotebookId })
          }
          focusMode={focusMode}
          autoReadingMode={autoReadingMode}
          canAutoRead={!splitNoteId}
          typewriterMode={typewriterMode}
          viewLayout={isMobileViewport ? "three-column" : viewLayout}
          isSplitActive={Boolean(splitNoteId && !isMobileViewport)}
          canInstallApp={pwaState.canInstall}
          showIosInstallHint={pwaState.showIosInstallHint}
          standalone={pwaState.standalone}
          hasSelectedNote={commandNoteReady}
          onSearchInCurrentNote={handleSearchInCurrentNote}
          onReplaceInCurrentNote={openReplaceInCurrentNote}
          onSearchGlobal={handleSearchGlobal}
          initialQuery={commandInitialQuery}
          themePreference={themePreference}
        />

        {imageExportSnapshot && (
          <Suspense fallback={null}>
            <LazyImageExportDialog snapshot={imageExportSnapshot} onClose={closeImageExport} />
          </Suspense>
        )}
        {editingNotebook !== undefined && (
          <NotebookDialog
            key={editingNotebook?.id ?? "new"}
            notebook={editingNotebook}
            onClose={() => setEditingNotebook(undefined)}
            onSave={saveNotebookDraft}
            onSaved={saveNotebook}
            onRequestDelete={(target) =>
              requestConfirm({
                eyebrow: "删除笔记本",
                title: `删除笔记本“${target.name}”？`,
                description: "笔记本中的笔记会自动移入收件箱，笔记内容不会被删除。",
                confirmLabel: "删除笔记本",
                danger: true,
                onConfirm: () => deleteNotebook(target.id),
              })
            }
          />
        )}
        {confirmRequest && (
          <ConfirmDialog
            key={confirmRequest.id}
            request={confirmRequest}
            onClose={() => setConfirmRequest(null)}
          />
        )}
        <SplitNoteDialog
          open={splitPickerOpen}
          onClose={() => setSplitPickerOpen(false)}
          onSelectNote={handleSelectSplitNote}
          notes={notes}
          excludeNoteId={selectedId}
        />
        <SystemNotices
          notice={notice}
          onDismiss={dismissNotice}
          onPause={pauseNotice}
          updateAvailable={pwaState.updateAvailable}
          onUpdate={() => void updatePwa()}
        />
        {workspaceMenu}
      </div>
    </MemoWorkspaceProvider>
  );
}
