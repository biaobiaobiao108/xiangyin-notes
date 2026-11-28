import { useCallback, useDeferredValue, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { dispatchKeyboardContextMenu, useContextMenu } from "./context-menu";
import { subscribePwa, type PwaState } from "./pwa";
import {
  NOTE_BATCH_LIMIT,
  type Note,
  type NoteSummary,
  type NoteView,
  type Notebook,
} from "../shared/types";
import { useOutlineState } from "./workspace/use-outline-state";
import { type ConfirmRequest } from "./workspace/dialogs";
import { NoteListPanel, Sidebar } from "./workspace/panels";
import { NoteCardGridPanel } from "./workspace/note-card-grid";
import { registerDragOverGuard } from "./workspace/note-drag-drop";
import { noteMetadataSnapshot, toNoteSummary, viewLabel } from "./workspace/helpers";
import { useNoteSelection } from "./workspace/use-note-selection";
import { isMissingNoteError, useNoteSaveQueue } from "./workspace/use-note-save-queue";
import { emptyRealtimeRefreshPlan, type RealtimeRefreshPlan } from "./workspace/realtime-refresh";
import { useWorkspaceShortcuts } from "./workspace/use-workspace-shortcuts";
import { useTrashActions } from "./workspace/use-trash-actions";
import {
  useMobileNavigation,
  type MobileListContext,
  type MobilePage,
} from "./workspace/use-mobile-navigation";
import { useMobileViewport } from "./workspace/use-mobile-viewport";
import { useNotices } from "./workspace/use-notices";
import { MobileBottomBar } from "./workspace/mobile-panels";
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
import { WorkspaceEditorArea } from "./workspace/workspace-editor-area";
import { useWorkspaceNoteSync } from "./workspace/use-workspace-note-sync";
import { useWorkspaceCollectionActions } from "./workspace/use-workspace-collection-actions";
import { useWorkspaceOffline } from "./workspace/use-workspace-offline";
import { useWorkspaceCommands } from "./workspace/use-workspace-commands";
import { useDeferredImages } from "./workspace/use-deferred-images";
import { useWorkspaceEditorDrafts } from "./workspace/use-workspace-editor-drafts";
import { useWorkspaceSplitState } from "./workspace/use-workspace-split-state";
import { WorkspaceCollections } from "./workspace/workspace-collections";
import { WorkspaceDialogs } from "./workspace/workspace-dialogs";

export type { ViewLayout } from "./workspace/use-workspace-preferences";

const EMPTY_NOTE_LIST: NoteSummary[] = [];

export function Workspace() {
  const navigate = useNavigate();
  const { ready, user, handleUnauthorized, connectionError, retry } = useWorkspaceSession();
  const { openMenu: openWorkspaceMenu, menu: workspaceMenu } = useContextMenu();
  const currentUserKey = user?.username ?? "";
  const userId = user?.id ?? null;
  const [initialLinkedNoteId] = useState(() =>
    new URLSearchParams(window.location.search).get("note"),
  );
  const pendingLinkedNoteRef = useRef(initialLinkedNoteId);
  const { preference: themePreference, setPreference: setThemePreference } = useThemePreference();
  const navigationIntentRef = useRef(0);
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
  const [totalNotes, setTotalNotes] = useState(0);
  const [hasMoreNotes, setHasMoreNotes] = useState(false);
  const [notesReloadToken, setNotesReloadToken] = useState(0);
  const searchActiveRef = useRef(false);
  searchActiveRef.current = Boolean(deferredQuery.trim());
  const handleSearchableFieldsSaved = useCallback(() => {
    if (searchActiveRef.current) setNotesReloadToken((value) => value + 1);
  }, []);
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
  const notesRef = useRef<NoteSummary[]>([]);
  const listRequestRef = useRef(0);
  const listAbortRef = useRef<AbortController | null>(null);
  const nextNotesCursorRef = useRef<string | null>(null);
  const trashOperationsRef = useRef(new Set<string>());
  const [pendingTrashCount, setPendingTrashCount] = useState(0);
  const emptyingTrashRef = useRef(false);
  const [emptyingTrash, setEmptyingTrash] = useState(false);
  const requestedListScope = JSON.stringify([view, notebookId, query]);
  const listScope =
    query === deferredQuery
      ? requestedListScope
      : JSON.stringify([view, notebookId, deferredQuery]);
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
  } = useNoteSelection(requestedListScope);
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
  }, [playListTransition, setViewLayout]);
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
    setOutlineOpen((current) => !current);
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
    busyTasks,
    setTaskBusy,
    applyTaskToggle,
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
  });
  const realtimeRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRealtimeRefreshRef = useRef<RealtimeRefreshPlan>(emptyRealtimeRefreshPlan());
  const confirmIdRef = useRef(0);
  const replaceList = useCallback((next: NoteSummary[]) => {
    notesRef.current = next;
    setNotes(next);
  }, []);
  const {
    splitNoteId,
    setSplitNoteId,
    splitNoteIdRef,
    autoReadingMode,
    setAutoReadingMode,
    toggleAutoReadingMode,
    exitAutoReadingMode,
    closeSplitRef,
    splitSelectedNote,
    setSplitSelectedNote,
    splitSelectedRef,
    splitNoteOpeningRef,
    splitIsNoteLoading,
    setSplitIsNoteLoading,
    splitSaveState,
    setSplitSaveState,
    splitNoteReloadToken,
    setSplitNoteReloadToken,
    activePane,
    setActivePane,
    splitRatio,
    setSplitRatio,
    splitOutlineItems,
    splitActiveOutlineId,
    splitOutlineNavigateRef,
    handleSplitOutlineItemsChange,
    handleSplitOutlineActiveChange,
    handleSplitOutlineNavigationReady,
    splitLoadRequestRef,
    splitAbortRef,
    splitMarkdownReaderRef,
    splitMarkdownDirtyNoteRef,
    splitEditorFocusNoteId,
    handleSplitEditorFocus,
    setSplitSelectedNoteMetadata,
    splitPickerOpen,
    setSplitPickerOpen,
  } = useWorkspaceSplitState(selectedIdRef);
  const [replaceRequest, setReplaceRequest] = useState<{
    noteId: string;
    token: number;
    query: string;
  } | null>(null);
  const persistRef = useRef<ReturnType<typeof useNoteSaveQueue>["persist"]>(() => undefined);
  const {
    editorMarkdownReaderRef,
    editorMarkdownDirtyNoteRef,
    flushEditorDraftRef,
    registerEditorMarkdownReader,
    registerEditorMarkdownDirty,
    flushActiveEditorDraft,
  } = useWorkspaceEditorDrafts({
    selectedRef,
    splitSelectedRef,
    splitMarkdownReaderRef,
    trashOperationsRef,
    persistRef,
  });
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
    toggleNoteTask,
    deleteNotebookAndMoveNotes,
    saveNoteNow,
    flushPendingSaves,
    flushDraftRecoveries,
    hasUnsavedWork,
    markNoteMissing,
    clearPendingForNote,
  } = useNoteSaveQueue({
    userId,
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
    onSearchableFieldsSaved: handleSearchableFieldsSaved,
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
  }, [saveState, setTaskRefreshToken, splitSaveState, tasksOpen]);
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
  const isMissingDraft = useCallback(
    (noteId: string) => isMissingNoteError(failedSavesRef.current.get(noteId)),
    [failedSavesRef],
  );
  const {
    loadNotes,
    loadMoreNotes,
    isLoadingMore,
    reloadNotes,
    updatedPageBoundaryRef,
    loadedScope,
    failedScope,
  } = useWorkspaceNoteList({
    view,
    notebookId,
    deferredQuery,
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
    isMissingDraft,
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
  const listStatus =
    deferredQuery !== query
      ? "loading"
      : loadedScope === listScope
        ? "ready"
        : failedScope === listScope
          ? "error"
          : "loading";
  const visibleNotes = listStatus === "ready" ? notes : EMPTY_NOTE_LIST;
  useEffect(() => {
    if (!ready) return;
    void refreshNotebooks();
    reloadNotes();
  }, [ready, refreshNotebooks, reloadNotes]);

  const isOffline = useWorkspaceOffline({
    onOffline: useCallback(() => {
      flushDraftRecoveries();
      notifyWarning("网络已断开，本地草稿会继续保留");
    }, [flushDraftRecoveries, notifyWarning]),
    onOnline: useCallback(() => {
      if (!ready) return;
      notifyInfo(hasUnsavedWork() ? "网络已恢复，正在同步未保存草稿" : "网络已恢复");
      void refreshNotebooks();
      reloadNotes();
    }, [hasUnsavedWork, notifyInfo, ready, refreshNotebooks, reloadNotes]),
  });

  const selectNote = useCallback(
    (id: string | null) => {
      navigationIntentRef.current += 1;
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
    [clearNoteSelection, setTaskNavigation],
  );
  mobileRestoreRef.current = (context, page) => {
    navigationIntentRef.current += 1;
    flushEditorDraftRef.current();
    setOutlineOpen(false);
    setTasksOpen(page === "tasks");
    setKanbanOpen(page === "kanban");
    setMemosOpen(page === "memos");
    setView(context.view);
    setNotebookId(context.notebookId);
    setQuery(context.query);
    searchOriginRef.current = context.searchOrigin;
    if (page === "editor" && context.noteId) selectNote(context.noteId);
  };
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
    userId,
    ready,
    selectedId,
    selectedRef,
    activeNoteIdRef,
    noteLoadRequestRef,
    noteAbortRef,
    noteOpeningRef,
    pendingSavesRef,
    failedSavesRef,
    markNoteMissing,
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
      navigationIntentRef.current += 1;
      listAbortRef.current?.abort();
      noteLoadRequestRef.current += 1;
      noteAbortRef.current?.abort();
      if (realtimeRefreshTimerRef.current !== null) clearTimeout(realtimeRefreshTimerRef.current);
    },
    [],
  );

  const onNoteChange = useWorkspaceNoteChange({
    selectedRef,
    notesRef,
    trashOperationsRef,
    replaceList,
    setSelectedNote,
    persist,
  });
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
    [
      clearPendingForNote,
      invalidateCollections,
      openMobileNote,
      playListTransition,
      replaceList,
      setQuery,
    ],
  );
  const {
    creatingNote,
    createNoteHere,
    createNoteInInbox,
    createNoteInNotebook,
    createRecoveredNote,
  } = useWorkspaceNoteCreation({
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

  const { refreshSelectedNoteFromRemote, refreshSplitNoteFromRemote, requestConflictReload } =
    useWorkspaceNoteSync({
      userId,
      ready,
      initialLinkedNoteId,
      pendingLinkedNoteRef,
      selectedRef,
      activeNoteIdRef,
      noteAbortRef,
      noteOpeningRef,
      noteLoadRequestRef,
      splitSelectedRef,
      splitNoteIdRef,
      splitAbortRef,
      splitNoteOpeningRef,
      splitLoadRequestRef,
      pendingSavesRef,
      failedSavesRef,
      editorMarkdownDirtyNoteRef,
      splitMarkdownDirtyNoteRef,
      notesRef,
      replaceList,
      setSelectedNote,
      setSplitSelectedNote,
      setNoteReloadToken,
      setSplitNoteReloadToken,
      setSaveState,
      setSplitSaveState,
      setIsNoteLoading,
      setView,
      setNotebookId,
      setQuery,
      setCardEditingNoteId,
      selectNote,
      openMobileNote,
      closeSplitRef,
      markNoteMissing,
      clearPendingForNote,
      removeFromList,
      invalidateCollections,
      reloadNotes,
      requestConfirm,
      notifyWarning,
      notifyError,
      navigate,
    });

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
    state: { view, totalNotes, pendingTrashCount },
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
    refreshNotebooks,
    onToggleFavoriteNote: (target) => handleToggleFavoriteNote(target),
  });

  const {
    requestDraftRecovery,
    deleteNotebook,
    toggleFavorite,
    handleToggleFavoriteNote,
    handleMoveNotesToNotebook,
    handleTrashNotes,
  } = useWorkspaceCollectionActions({
    view,
    notebookId,
    notebooks,
    kanbanOpen,
    tasksOpen,
    selectedRef,
    activeNoteIdRef,
    splitNoteIdRef,
    listScopeRef,
    trashOperationsRef,
    pendingSavesRef,
    failedSavesRef,
    flushEditorDraftRef,
    searchOriginRef,
    closeSplitRef,
    setNotebooks,
    setNotebookId,
    setView,
    setQuery,
    setTotalNotes,
    setSelectedNote,
    setEditingNotebook,
    setKanbanRefreshToken,
    setTaskRefreshToken,
    replaceList,
    removeFromList,
    removeManyFromList,
    clearNoteSelection,
    requestListTransition,
    invalidateCollections,
    refreshNotebooks,
    reloadNotes,
    loadNotes,
    refreshSelectedNoteFromRemote,
    refreshSplitNoteFromRemote,
    splitSelectedRef,
    persist,
    runSave,
    saveImmediately,
    saveFavorite,
    moveNoteToNotebook,
    deleteNotebookAndMoveNotes,
    clearPendingForNote,
    createRecoveredNote,
    revealCreatedNote,
    trashNotes,
    requestConfirm,
    notifyInfo,
    notifyError,
  });

  const {
    requestSplitConflictReload,
    flushSecondaryDraft,
    closeSplit,
    openInSplit,
    handleToggleSplit,
    handleSelectSplitNote,
    onSplitNoteChange,
  } = useWorkspaceSplit({
    userId,
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
    markNoteMissing,
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

  const handleReplaceRequestHandled = useCallback((token: number) => {
    setReplaceRequest((current) => (current?.token === token ? null : current));
  }, []);
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
    navigationIntentRef,
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
  const { openCommandMenu, openReplaceInCurrentNote, logout, command } = useWorkspaceCommands({
    ready,
    selectedRef,
    splitSelectedRef,
    editorMarkdownReaderRef,
    searchRef,
    activePane,
    splitNoteId,
    isMobileViewport,
    viewLayout,
    pwaState,
    flushPendingSaves,
    hasUnsavedWork,
    createNoteInInbox,
    openMobileList,
    openMobileHome,
    openKanban,
    handleToggleSplit,
    toggleViewLayout,
    toggleFocusMode,
    toggleAutoReadingMode,
    toggleTypewriterMode,
    toggleFavorite,
    moveToTrash,
    restoreFromTrash,
    handleExportImage,
    handleExportNote,
    handleExportLibrary,
    setSidebarCollapsed,
    setThemePreference,
    setCommandOpen,
    setCommandInitialQuery,
    setTasksOpen,
    setCardEditingNoteId,
    setReplaceRequest,
    notifyInfo,
    notifyWarning,
    notifyError,
    navigate,
  });
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
    setTaskBusy,
    applyTaskToggle,
    flushPendingSaves,
    hasUnsavedWork,
    toggleNoteTask,
    notifyWarning,
    notifyError,
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
  const handleToggleNoteSelection = useCallback<typeof toggleNoteSelection>(
    (...args) => {
      if (toggleNoteSelection(...args)) return true;
      notifyError(`一次最多选择 ${NOTE_BATCH_LIMIT} 篇笔记`);
      return false;
    },
    [notifyError, toggleNoteSelection],
  );
  const { handleSelectListNote, handleOpenCardNote, handleToggleCardSelection } =
    useWorkspaceNoteInteractions({
      isMobileViewport,
      openInSplit,
      locateSearchResult,
      notesRef,
      noteSelectionRef,
      toggleNoteSelection: handleToggleNoteSelection,
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
    navigationIntentRef.current += 1;
    openMobileHome();
  }, [openMobileHome]);
  const handleOpenList = useCallback(() => {
    navigationIntentRef.current += 1;
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
    }
  }, [backMobilePage, closeOutline, isMobileViewport, viewLayout]);
  const {
    deferredImages,
    onDeferImage,
    insertDeferredImages,
    onBackgroundImageError,
    handleUploadImage,
  } = useDeferredImages({ currentUserKey, notifyInfo, notifyWarning });
  const handleScrollToOutlineItem = useCallback(
    (id: string) => outlineNavigateRef.current?.(id),
    [outlineNavigateRef],
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
  const mobileBackLabel = kanbanReturnRef.current
    ? "看板"
    : !isSplitEditor && tasksOpen
      ? "任务"
      : query
        ? "搜索结果"
        : (currentNotebook?.name ?? viewLabel(view));

  const handleMemoConverted = useCallback(
    (note: Note) => {
      revealCreatedNote(note, { view: "inbox", notebookId: note.notebookId });
      void refreshNotebooks();
      notifyInfo("随记已转为笔记，原随记已移除");
    },
    [notifyInfo, refreshNotebooks, revealCreatedNote],
  );
  const handleRetryTasks = useCallback(
    () => setTaskRefreshToken((value) => value + 1),
    [setTaskRefreshToken],
  );
  const handleScrollToSplitOutlineItem = useCallback(
    (id: string) => splitOutlineNavigateRef.current?.(id),
    [],
  );
  const handleFocusSelectedEditor = useCallback(() => {
    if (selectedId) setEditorFocusNoteId(selectedId);
  }, [selectedId]);
  const handleBackToKanban = useCallback(() => {
    closeSplit();
    setCardEditingNoteId(null);
    setKanbanOpen(true);
    kanbanReturnRef.current = false;
  }, [closeSplit, setCardEditingNoteId, setKanbanOpen]);
  const handleBackToCards = useCallback(() => {
    if (isSplitEditor) closeSplit();
    setCardEditingNoteId(null);
  }, [closeSplit, isSplitEditor, setCardEditingNoteId]);
  const handleMoveCurrentNoteToNotebook = useCallback(
    (targetNotebookId: string) => {
      const id = selectedRef.current?.id;
      if (id) void handleMoveNotesToNotebook([id], targetNotebookId, true);
    },
    [handleMoveNotesToNotebook],
  );
  const handleCloseNotebookDialog = useCallback(
    () => setEditingNotebook(undefined),
    [setEditingNotebook],
  );
  const handleRequestDeleteNotebook = useCallback(
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
  const handleCloseConfirm = useCallback(() => setConfirmRequest(null), [setConfirmRequest]);
  const handleCloseSplitPicker = useCallback(() => setSplitPickerOpen(false), [setSplitPickerOpen]);

  return (
    <MemoWorkspaceProvider
      active={memosOpen}
      userKey={currentUserKey}
      externalRevision={memoRefreshToken}
      onUnauthorized={handleUnauthorized}
    >
      <div
        onContextMenu={handleWorkspaceContextMenu}
        onKeyDown={(event) =>
          dispatchKeyboardContextMenu(
            event,
            "dialog, input, textarea, [contenteditable='true'], .editor-panel",
          )
        }
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
        <WorkspaceCollections
          isMobileViewport={isMobileViewport}
          mobilePage={mobilePage}
          memosOpen={memosOpen}
          tasksOpen={tasksOpen}
          kanbanOpen={kanbanOpen}
          view={view}
          notebooks={notebooks}
          notebookId={notebookId}
          reorderingNotebooks={reorderingNotebooks}
          notes={notes}
          tasks={tasks}
          tasksTotal={currentTaskSnapshot?.total ?? 0}
          hasMoreTasks={currentTaskSnapshot !== null && currentTaskSnapshot.nextCursor !== null}
          tasksMoreLoading={tasksMoreLoading}
          tasksMoreError={tasksMoreError}
          taskNotebookId={taskNotebookId}
          taskStatus={taskStatus}
          tasksLoading={tasksLoading}
          busyTasks={busyTasks}
          tasksError={tasksError}
          kanbanColumns={kanbanColumns}
          kanbanLoading={kanbanLoading}
          onReorderNotebooks={handleReorderNotebooks}
          onSelectView={selectView}
          onSelectNotebook={selectNotebook}
          onCreateNotebook={handleCreateNotebook}
          onEditNotebook={handleEditNotebook}
          onDeleteNotebook={handleDeleteNotebook}
          onLogout={logout}
          onOpenTasks={openTasks}
          onOpenMemos={openMemos}
          onOpenKanban={openKanban}
          onBackMobilePage={backMobilePage}
          onMemoConverted={handleMemoConverted}
          onRetryTasks={handleRetryTasks}
          onTaskNotebookChange={setTaskNotebookId}
          onTaskStatusChange={setTaskStatus}
          onSelectTask={selectTask}
          onToggleTask={handleToggleTask}
          onLoadMoreTasks={loadMoreTasks}
          onOpenKanbanNote={openKanbanNote}
          onCreateKanbanNote={handleCreateNoteInKanbanColumn}
          onAddExistingKanbanNote={handleAddExistingNoteToKanban}
          onMoveKanbanCard={handleMoveKanbanCard}
          onTrashKanbanCard={handleTrashKanbanCard}
          onLoadMoreKanbanColumn={loadMoreKanbanColumn}
          onToggleFavoriteKanbanCard={handleToggleFavoriteKanbanCard}
        />
        {!tasksOpen && !kanbanOpen && !memosOpen && !isCardsLayout && (
          <NoteListPanel
            notes={visibleNotes}
            listStatus={listStatus}
            onRetryList={reloadNotes}
            total={listStatus === "ready" ? totalNotes : 0}
            hasMore={listStatus === "ready" && hasMoreNotes}
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
                ? handleScrollToSplitOutlineItem
                : handleScrollToOutlineItem
            }
            onCloseOutline={closeOutline}
            onLoadMore={loadMoreNotes}
            isLoadingMore={isLoadingMore}
            virtualizationScope={listScope}
            onFocusEditor={handleFocusSelectedEditor}
            inert={isMobileViewport && mobilePage !== "list"}
          />
        )}
        {showCardsGrid && (
          <NoteCardGridPanel
            notes={visibleNotes}
            listStatus={listStatus}
            onRetryList={reloadNotes}
            total={listStatus === "ready" ? totalNotes : 0}
            hasMore={listStatus === "ready" && hasMoreNotes}
            isMobileViewport={isMobileViewport}
            selectedIds={selectedNoteIds}
            onOpenNote={handleOpenCardNote}
            onToggleSelectNote={handleToggleCardSelection}
            onDeleteSelected={deleteSelectedNotes}
            view={view}
            query={query}
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
            <WorkspaceEditorArea
              editorRegionRef={editorRegionRef}
              editorContentInert={editorContentInert}
              mountEditor={mountEditor}
              renderedNote={renderedNote}
              renderedNoteContent={renderedNoteContent}
              splitRenderedNote={splitRenderedNote}
              splitRenderedNoteContent={splitRenderedNoteContent}
              splitNoteId={splitNoteId}
              isMobileViewport={isMobileViewport}
              isSplitEditor={isSplitEditor}
              splitRatio={splitRatio}
              setSplitRatio={setSplitRatio}
              activePane={activePane}
              setActivePane={setActivePane}
              notes={notes}
              handleNavigateWikiLinkPrimary={handleNavigateWikiLinkPrimary}
              handleNavigateWikiLinkSplit={handleNavigateWikiLinkSplit}
              handleCreateAndLinkNote={handleCreateAndLinkNote}
              selectNote={selectNote}
              openInSplit={openInSplit}
              resultSearch={resultSearch}
              inNoteSearchQuery={inNoteSearchQuery}
              replaceRequest={replaceRequest}
              handleReplaceRequestHandled={handleReplaceRequestHandled}
              taskNavigation={taskNavigation}
              handleTaskNavigationMissing={handleTaskNavigationMissing}
              handleClearInNoteSearch={handleClearInNoteSearch}
              registerEditorMarkdownReader={registerEditorMarkdownReader}
              registerEditorMarkdownDirty={registerEditorMarkdownDirty}
              splitMarkdownReaderRef={splitMarkdownReaderRef}
              splitMarkdownDirtyNoteRef={splitMarkdownDirtyNoteRef}
              saveState={saveState}
              splitSaveState={splitSaveState}
              isNoteLoading={isNoteLoading}
              splitIsNoteLoading={splitIsNoteLoading}
              creatingNote={creatingNote}
              busyTasks={busyTasks}
              emptyingTrash={emptyingTrash}
              pendingTrashCount={pendingTrashCount}
              trashOperationsRef={trashOperationsRef}
              noteReloadToken={noteReloadToken}
              splitNoteReloadToken={splitNoteReloadToken}
              editorFocusNoteId={editorFocusNoteId}
              splitEditorFocusNoteId={splitEditorFocusNoteId}
              commandOpen={commandOpen}
              handleEditorFocus={handleEditorFocus}
              handleSplitEditorFocus={handleSplitEditorFocus}
              onNoteChange={onNoteChange}
              onSplitNoteChange={onSplitNoteChange}
              requestDraftRecovery={requestDraftRecovery}
              saveNoteNow={saveNoteNow}
              requestConflictReload={requestConflictReload}
              requestSplitConflictReload={requestSplitConflictReload}
              handleExportImage={handleExportImage}
              toggleFavorite={toggleFavorite}
              handleToggleFavoriteNote={handleToggleFavoriteNote}
              moveToTrash={moveToTrash}
              restoreFromTrash={restoreFromTrash}
              permanentDeleteNote={permanentDeleteNote}
              handleSplitMoveToTrash={handleSplitMoveToTrash}
              handleSplitRestore={handleSplitRestore}
              handleSplitPermanentDelete={handleSplitPermanentDelete}
              handleOpenList={handleOpenList}
              mobileBackLabel={mobileBackLabel}
              onBackToKanban={kanbanReturnRef.current ? handleBackToKanban : undefined}
              onBackToCards={
                !kanbanReturnRef.current && isCardsLayout && !tasksOpen
                  ? handleBackToCards
                  : undefined
              }
              handleUploadImage={handleUploadImage}
              deferredImages={deferredImages}
              onDeferImage={onDeferImage}
              onBackgroundImageError={onBackgroundImageError}
              insertDeferredImages={insertDeferredImages}
              focusMode={focusMode}
              autoReadingMode={autoReadingMode}
              toggleAutoReadingMode={toggleAutoReadingMode}
              exitAutoReadingMode={exitAutoReadingMode}
              typewriterMode={typewriterMode}
              outlineOpen={outlineOpen}
              outlineItems={outlineItems}
              activeOutlineId={activeOutlineId}
              splitOutlineItems={splitOutlineItems}
              splitActiveOutlineId={splitActiveOutlineId}
              toggleOutline={toggleOutline}
              closeOutline={closeOutline}
              handleOutlineItemsChange={handleOutlineItemsChange}
              handleOutlineActiveChange={handleOutlineActiveChange}
              handleOutlineNavigationReady={handleOutlineNavigationReady}
              handleSplitOutlineItemsChange={handleSplitOutlineItemsChange}
              handleSplitOutlineActiveChange={handleSplitOutlineActiveChange}
              handleSplitOutlineNavigationReady={handleSplitOutlineNavigationReady}
              handleToggleSplit={
                !isMobileViewport && viewLayout === "cards" ? handleToggleSplit : undefined
              }
              closeSplit={closeSplit}
              view={view}
              handleNewNote={handleNewNote}
              listTransitionToken={listTransitionToken}
            />
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
        <WorkspaceDialogs
          isMobileViewport={isMobileViewport}
          commandOpen={commandOpen}
          commandInitialQuery={commandInitialQuery}
          commandNoteReady={commandNoteReady}
          renderedNote={renderedNote}
          notebooks={notebooks}
          focusMode={focusMode}
          autoReadingMode={autoReadingMode}
          splitNoteId={splitNoteId}
          typewriterMode={typewriterMode}
          viewLayout={viewLayout}
          pwaState={pwaState}
          themePreference={themePreference}
          imageExportSnapshot={imageExportSnapshot}
          editingNotebook={editingNotebook}
          confirmRequest={confirmRequest}
          splitPickerOpen={splitPickerOpen}
          notes={notes}
          selectedId={selectedId}
          notice={notice}
          offline={isOffline}
          workspaceMenu={workspaceMenu}
          onCloseCommandMenu={closeCommandMenu}
          onCommand={command}
          onCreateNoteInNotebook={createNoteInNotebook}
          onMoveCurrentNoteToNotebook={handleMoveCurrentNoteToNotebook}
          onSearchInCurrentNote={handleSearchInCurrentNote}
          onReplaceInCurrentNote={openReplaceInCurrentNote}
          onSearchGlobal={handleSearchGlobal}
          onCloseImageExport={closeImageExport}
          onCloseNotebookDialog={handleCloseNotebookDialog}
          onSaveNotebookDraft={saveNotebookDraft}
          onSavedNotebook={saveNotebook}
          onRequestDeleteNotebook={handleRequestDeleteNotebook}
          onCloseConfirm={handleCloseConfirm}
          onCloseSplitPicker={handleCloseSplitPicker}
          onSelectSplitNote={handleSelectSplitNote}
          onDismissNotice={dismissNotice}
          onPauseNotice={pauseNotice}
        />
      </div>
    </MemoWorkspaceProvider>
  );
}
