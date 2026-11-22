import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router";
import { useContextMenu } from "./context-menu";
import { copyPlainText } from "./editor/code-block-copy";
import { moveSelectedNotes } from "./workspace/move-selected-notes";
import { ApiError, api } from "./api";
import { CommandId, CommandMenu } from "./command-menu";
import { applyPwaUpdate, installPwa, subscribePwa, type PwaState } from "./pwa";
import type { Note, NoteSummary, NoteView, Notebook } from "../shared/types";
import { useOutlineState } from "./workspace/use-outline-state";
import { ConfirmDialog, NotebookDialog, type ConfirmRequest } from "./workspace/dialogs";
import { SplitResizer, DEFAULT_SPLIT_RATIO } from "./workspace/split-resizer";
import { SplitNoteDialog } from "./workspace/split-note-dialog";
import { EmptyEditor, NoteListPanel, NoteLoadingState, Sidebar } from "./workspace/panels";
import { NoteCardGridPanel } from "./workspace/note-card-grid";
import { registerDragOverGuard } from "./workspace/note-drag-drop";
import { ErrorBoundary, EditorErrorFallback } from "./error-boundary";
import {
  errorMessage,
  noteMetadataSnapshot,
  toNoteSummary,
  type NoteSort,
} from "./workspace/helpers";
import { useNoteSelection } from "./workspace/use-note-selection";
import { useNoteSaveQueue, type SaveState } from "./workspace/use-note-save-queue";
import { emptyRealtimeRefreshPlan, type RealtimeRefreshPlan } from "./workspace/realtime-refresh";
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
import { useWorkspaceNoteInteractions } from "./workspace/use-workspace-note-interactions";
import { useWorkspaceListChanges } from "./workspace/use-workspace-list-changes";
import { useWorkspaceRealtimeRefresh } from "./workspace/use-workspace-realtime-refresh";
import { useWorkspaceSearch } from "./workspace/use-workspace-search";
import { useWorkspaceNotebookEditor } from "./workspace/use-workspace-notebook-editor";
import { useWorkspaceNavigation } from "./workspace/use-workspace-navigation";
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

const LazyTasksPanel = lazy(() =>
  import("./workspace/tasks-panel").then(({ TasksPanel }) => ({ default: TasksPanel })),
);

const LazyKanbanPanel = lazy(() =>
  import("./workspace/kanban-panel").then(({ KanbanPanel }) => ({ default: KanbanPanel })),
);

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
  const editorMarkdownReaderRef = useRef<((noteId: string) => string | null) | null>(null);
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
  const splitMarkdownReaderRef = useRef<((noteId: string) => string | null) | null>(null);
  const splitMarkdownDirtyNoteRef = useRef<string | null>(null);
  const [splitEditorFocusNoteId, setSplitEditorFocusNoteId] = useState<string | null>(null);
  const handleSplitEditorFocus = useCallback(() => setSplitEditorFocusNoteId(null), []);
  const setSplitSelectedNoteMetadata = useCallback((note: Note | null) => {
    setSplitSelectedNote(note ? noteMetadataSnapshot(note) : null);
  }, []);
  const [splitPickerOpen, setSplitPickerOpen] = useState(false);
  const refreshLinkedNotesRef = useRef<(sourceId: string) => void>(() => undefined);
  const handleLinkedNotesRewritten = useCallback((sourceId: string) => {
    refreshLinkedNotesRef.current(sourceId);
  }, []);
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
    moveNoteToNotebook,
    flushNotebookSaves,
    saveNoteNow,
    flushPendingSaves,
    hasUnsavedWork,
    clearPendingForNote,
  } = useNoteSaveQueue({
    selectedRef,
    notesRef,
    activeNoteIdRef,
    noteOpeningRef,
    splitNoteOpeningRef,
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
    onLinkedNotesRewritten: handleLinkedNotesRewritten,
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
  const { loadNotes, loadMoreNotes, isLoadingMore, reloadNotes, updatedPageBoundaryRef } =
    useWorkspaceNoteList({
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
  const { removeFromList, patchNoteFromRemote, removeManyFromList } = useWorkspaceListChanges({
    notesRef,
    noteSort,
    replaceList,
    setTotalNotes,
    activeNoteIdRef,
    selectNote,
    setCardEditingNoteId,
    splitNoteIdRef,
    closeSplitRef,
    listScopeRef,
    listScope,
    nextNotesCursorRef,
    updatedPageBoundaryRef,
    notebooks,
    view,
    deferredQuery,
    notebookId,
    clearNoteSelection,
  });
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
    trashOperationsRef,
    replaceList,
    setSelectedNote,
    persist,
  });
  const registerEditorMarkdownReader = useCallback(
    (reader: ((noteId: string) => string | null) | null) => {
      editorMarkdownReaderRef.current = reader;
    },
    [],
  );
  const registerEditorMarkdownDirty = useCallback((noteId: string, isDirty: boolean) => {
    if (isDirty) editorMarkdownDirtyNoteRef.current = noteId;
    else if (editorMarkdownDirtyNoteRef.current === noteId)
      editorMarkdownDirtyNoteRef.current = null;
  }, []);
  const flushActiveEditorDraft = useCallback(() => {
    const current = selectedRef.current;
    if (current && !trashOperationsRef.current.has(current.id)) {
      const markdown = editorMarkdownReaderRef.current?.(current.id);
      if (markdown != null && markdown !== current.contentMarkdown) {
        const next = { ...current, contentMarkdown: markdown };
        selectedRef.current = next;
        persistRef.current(next, ["contentMarkdown"]);
      }
    }
    const split = splitSelectedRef.current;
    if (split && !trashOperationsRef.current.has(split.id)) {
      const markdown = splitMarkdownReaderRef.current?.(split.id);
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
  const { createNotebook, saveNotebook, saveNotebookDraft } = useWorkspaceNotebookEditor({
    editingNotebook,
    setEditingNotebook,
    setNotebooks,
    selectedRef,
    setSelectedNote,
    setNotebookId,
    setView,
    openMobileList,
  });
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

  const movingNoteIdsRef = useRef(new Set<string>());
  const handleMoveNotesToNotebook = useCallback(
    async (ids: string[], targetNotebookId: string, followNote = false) => {
      const movers = movingNoteIdsRef.current;
      const targets = [...new Set(ids)];
      if (!targets.length) return;
      if (targets.some((id) => movers.has(id) || trashOperationsRef.current.has(id))) {
        notifyInfo("正在处理这篇笔记，请稍后重试");
        return;
      }
      const target = notebooks.find((notebook) => notebook.id === targetNotebookId);
      if (!target) {
        notifyError("找不到目标笔记本");
        return;
      }

      const scope = listScopeRef.current;
      targets.forEach((id) => movers.add(id));
      try {
        const { movedIds, failures } = await moveSelectedNotes(targets, {
          flushEditorDraft: () => flushEditorDraftRef.current(),
          saveNote: runSave,
          moveNote: (id) => moveNoteToNotebook(id, target.id),
        });

        if (movedIds.length || failures.length) {
          invalidateCollections();
          void refreshNotebooks();
          reloadNotes();
          if (movedIds.length && kanbanOpen) setKanbanRefreshToken((value) => value + 1);
          if (movedIds.length && tasksOpen) setTaskRefreshToken((value) => value + 1);
        }
        if (scope === listScopeRef.current && movedIds.length) {
          const current = selectedRef.current;
          if (
            followNote &&
            current &&
            movedIds.includes(current.id) &&
            activeNoteIdRef.current === current.id
          ) {
            searchOriginRef.current = null;
            setQuery("");
            requestListTransition();
            setView(target.isSystem ? "inbox" : "all");
            setNotebookId(target.isSystem ? undefined : target.id);
            replaceList([toNoteSummary(current)]);
            setTotalNotes(target.count + 1);
          } else if (notebookId ? notebookId !== target.id : view === "inbox" && !target.isSystem) {
            removeManyFromList(movedIds);
          } else if (!failures.length) {
            clearNoteSelection();
          }
        }

        if (failures.length) {
          const message = errorMessage(failures[0], "移动笔记失败，请重试");
          notifyError(
            movedIds.length
              ? `已移动 ${movedIds.length} 篇，${failures.length} 篇未移动。${message}`
              : message,
          );
        } else if (movedIds.length) {
          notifyInfo(`已将 ${movedIds.length} 篇笔记移至「${target.name}」`);
        } else {
          notifyInfo(`笔记已在「${target.name}」`);
        }
      } finally {
        targets.forEach((id) => movers.delete(id));
      }
    },
    [
      clearNoteSelection,
      invalidateCollections,
      kanbanOpen,
      moveNoteToNotebook,
      notebookId,
      notebooks,
      notifyError,
      notifyInfo,
      refreshNotebooks,
      reloadNotes,
      removeManyFromList,
      replaceList,
      requestListTransition,
      runSave,
      setKanbanRefreshToken,
      setQuery,
      tasksOpen,
      view,
    ],
  );

  const handleTrashNotes = useCallback(
    async (ids: string[]) => {
      if (ids.some((id) => movingNoteIdsRef.current.has(id))) {
        notifyInfo("笔记正在移动，请稍后重试");
        return;
      }
      await trashNotes(ids);
    },
    [notifyInfo, trashNotes],
  );

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
    splitNoteOpeningRef,
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
  useWorkspaceRealtimeRefresh({
    ready,
    pendingRealtimeRefreshRef,
    realtimeRefreshTimerRef,
    deferredQuery,
    memosOpen,
    tasksOpen,
    kanbanOpen,
    setMemoRefreshToken,
    setTaskRefreshToken,
    setKanbanRefreshToken,
    refreshNotebooks,
    reloadNotes,
    activeNoteIdRef,
    splitNoteIdRef,
    refreshSelectedNoteFromRemote,
    refreshSplitNoteFromRemote,
    patchNoteFromRemote,
  });
  refreshLinkedNotesRef.current = (sourceId) => {
    const activeId = activeNoteIdRef.current;
    if (activeId && activeId !== sourceId) {
      void refreshSelectedNoteFromRemote(activeId).finally(reloadNotes);
    } else reloadNotes();
    const splitId = splitNoteIdRef.current;
    if (splitId && splitId !== sourceId) void refreshSplitNoteFromRemote(splitId);
    if (tasksOpen) setTaskRefreshToken((value) => value + 1);
    if (kanbanOpen) setKanbanRefreshToken((value) => value + 1);
  };
  const {
    selectView,
    openTasks,
    openKanban,
    openMemos,
    openKanbanNote,
    selectNotebook,
    changeQuery,
    handleQueryDraftChange,
    submitQuery,
  } = useWorkspaceNavigation({
    view,
    notebookId,
    query,
    queryDraft,
    setView,
    setNotebookId,
    setQuery,
    setQueryDraft,
    setTasksOpen,
    setKanbanOpen,
    setMemosOpen,
    setCardEditingNoteId,
    kanbanReturnRef,
    searchOriginRef,
    requestListTransition,
    openMobileList,
    openMobileTasks,
    openMobileKanban,
    openMobileMemos,
    openMobileNote,
    flushSecondaryDraft,
    flushPendingSaves,
    hasUnsavedWork,
    notifyWarning,
    flushEditorDraftRef,
    splitNoteId,
    closeSplit,
    viewLayout,
    selectNote,
  });
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
  const {
    closeCommandMenu,
    handleSearchInCurrentNote,
    handleSearchGlobal,
    handleClearInNoteSearch,
    locateSearchResult,
  } = useWorkspaceSearch({
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
  });
  const copyNoteMarkdown = useCallback(async () => {
    const note = selectedRef.current;
    if (!note) return;
    const markdown = editorMarkdownReaderRef.current?.(note.id) ?? note.contentMarkdown;
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
  const { handleSelectListNote, handleOpenCardNote, handleToggleCardSelection } =
    useWorkspaceNoteInteractions({
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
    });
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

  const isSplitEditor = Boolean(splitNoteId && !isMobileViewport);
  const primaryEditor =
    mountEditor && renderedNote ? (
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
              resultSearch?.id === renderedNote.id ? resultSearch.query : inNoteSearchQuery
            }
            replaceRequest={replaceRequest?.noteId === renderedNote.id ? replaceRequest : null}
            onReplaceRequestHandled={handleReplaceRequestHandled}
            searchNavigationToken={resultSearch?.id === renderedNote.id ? resultSearch.token : 0}
            taskNavigation={taskNavigation?.noteId === renderedNote.id ? taskNavigation : null}
            onTaskNavigationMissing={handleTaskNavigationMissing}
            onClearSearch={
              inNoteSearchQuery || resultSearch?.id === renderedNote.id
                ? handleClearInNoteSearch
                : undefined
            }
            onMarkdownReaderChange={registerEditorMarkdownReader}
            onMarkdownDirtyChange={registerEditorMarkdownDirty}
            saveState={saveState}
            isLoading={isNoteLoading || creatingNote || taskMutationNoteId === renderedNote.id}
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
            isMobileViewport={isSplitEditor ? false : isMobileViewport}
            mobileBackLabel={
              kanbanReturnRef.current
                ? "看板"
                : !isSplitEditor && tasksOpen
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
                ? () => {
                    if (isSplitEditor) closeSplit();
                    setCardEditingNoteId(null);
                  }
                : undefined
            }
            onUploadImage={handleUploadImage}
            focusMode={focusMode}
            autoReadingMode={isSplitEditor ? false : autoReadingMode}
            onToggleAutoReadingMode={toggleAutoReadingMode}
            onExitAutoReadingMode={exitAutoReadingMode}
            typewriterMode={typewriterMode}
            outlineOpen={outlineOpen && (!isSplitEditor || activePane === "primary")}
            outlineItems={outlineItems}
            activeOutlineId={activeOutlineId}
            onToggleOutline={() => {
              if (isSplitEditor) setActivePane("primary");
              toggleOutline();
            }}
            onCloseOutline={closeOutline}
            onOutlineItemsChange={handleOutlineItemsChange}
            onOutlineActiveChange={handleOutlineActiveChange}
            onOutlineNavigationReady={handleOutlineNavigationReady}
            onToggleSplit={
              !isMobileViewport && viewLayout === "cards" ? handleToggleSplit : undefined
            }
            isSplitActive={isSplitEditor}
            isActivePane={isSplitEditor ? activePane === "primary" : undefined}
            onActivatePane={isSplitEditor ? () => setActivePane("primary") : undefined}
          />
        </Suspense>
      </ErrorBoundary>
    ) : null;

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
          <Suspense fallback={<NoteLoadingState panel="任务" />}>
            <LazyTasksPanel
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
          </Suspense>
        )}
        {shouldShowKanbanPanel(kanbanOpen, isMobileViewport, mobilePage) && (
          <Suspense fallback={<NoteLoadingState panel="看板" />}>
            <LazyKanbanPanel
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
          </Suspense>
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
                    {primaryEditor ? (
                      primaryEditor
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
              ) : primaryEditor ? (
                primaryEditor
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
          onMoveNoteToNotebook={(targetNotebookId) => {
            const id = selectedRef.current?.id;
            if (id) void handleMoveNotesToNotebook([id], targetNotebookId, true);
          }}
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
