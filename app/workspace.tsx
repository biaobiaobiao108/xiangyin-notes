import { lazy, memo, Suspense, useCallback, useDeferredValue, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { flushSync } from "react-dom";
import { useNavigate } from "react-router";
import { ArrowUpRight, LayoutGrid, List, ListChecks, Plus, RotateCcw, Settings2, Star, Trash2, X } from "lucide-react";
import { textFieldMenuItems, useContextMenu, type ContextMenuItem } from "./context-menu";
import { ApiError, api } from "./api";
import { createUuid } from "./uuid";
import { CommandId, CommandMenu } from "./command-menu";
import type { CreateNoteCommand } from "./command-parser";
import { applyPwaUpdate, installPwa, subscribePwa, type PwaState } from "./pwa";
import type { WorkspaceChangeMessage } from "../shared/realtime";
import type { ImageExportSnapshot } from "./image-export/render";
import type { Note, NoteSummary, NoteView, Notebook } from "../shared/types";
import type { OutlineItem } from "./editor-metrics";
import { ConfirmDialog, NotebookDialog, type ConfirmRequest } from "./workspace/dialogs";
import { clearAllDraftRecoveries, readDraftRecovery } from "./workspace/draft-recovery";
import { EmptyEditor, NoteListPanel, NoteLoadingState, Sidebar } from "./workspace/panels";
import { NoteCardGridPanel } from "./workspace/note-card-grid";
import { errorMessage, shouldKeepActiveNoteInList, sortNotes, toNoteDraft, toNoteSummary, type NoteDraft, type NoteSort } from "./workspace/helpers";
import { applyNoteSelectionClick, isNoteSelectionModifierClick, noteSelectionAnchor, pruneNoteSelection, type NoteSelectionClick, type NoteSelectionState } from "./workspace/note-list-selection";
import { normalizeLinkTitle } from "../shared/wiki-links";
import { useNoteSaveQueue } from "./workspace/use-note-save-queue";
import { useWorkspaceRealtime } from "./workspace/use-realtime";
import { latestSelectedNoteSnapshot, refreshSelectedNote } from "./workspace/selected-note-sync";
import { useWorkspaceShortcuts } from "./workspace/use-workspace-shortcuts";
import { useMobileNavigation, type MobileListContext, type MobilePage } from "./workspace/use-mobile-navigation";
import { useMobileViewport } from "./workspace/use-mobile-viewport";
import { useNotices } from "./workspace/use-notices";
import { SystemNotices } from "./workspace/system-notices";
import { MobileNotebookHome, MobileBottomBar } from "./workspace/mobile-panels";
import { viewLabel } from "./workspace/helpers";
import { useThemePreference } from "./theme";
import type { NoteSwipeAction } from "./workspace/swipe-actions";

export type ViewLayout = "three-column" | "cards";

const LazyImageExportDialog = lazy(() => import("./image-export/dialog").then(({ ImageExportDialog }) => ({ default: ImageExportDialog })));

const LazyNoteEditor = lazy(() => import("./editor").then(({ NoteEditor }) => ({ default: memo(NoteEditor) })));
export function Workspace() {
  const navigate = useNavigate();
  const { openMenu: openWorkspaceMenu, menu: workspaceMenu } = useContextMenu();
  const [initialLinkedNoteId] = useState(() => new URLSearchParams(window.location.search).get("note"));
  const pendingLinkedNoteRef = useRef(initialLinkedNoteId);
  const { preference: themePreference, setPreference: setThemePreference } = useThemePreference();
  const [view, setView] = useState<NoteView>("all");
  const [notebookId, setNotebookId] = useState<string>();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [noteSort, setNoteSort] = useState<NoteSort>("updated");
  const [totalNotes, setTotalNotes] = useState(0);
  const [hasMoreNotes, setHasMoreNotes] = useState(false);
  const [notesReloadToken, setNotesReloadToken] = useState(0);
  const [listTransitionToken, setListTransitionToken] = useState(0);
  const listTransitionIntentRef = useRef(0);
  const listTransitionConsumedRef = useRef(0);
  const editorMarkdownReaderRef = useRef<(() => string | null) | null>(null);
  const editorMarkdownDirtyNoteRef = useRef<string | null>(null);
  const flushEditorDraftRef = useRef<() => void>(() => undefined);
  const notesRef = useRef<NoteSummary[]>([]);
  const pendingWikiCreationsRef = useRef<Map<string, Promise<NoteSummary | null>>>(new Map());
  const inboxNoteCreationRef = useRef(false);
  const listRequestRef = useRef(0);
  const listAbortRef = useRef<AbortController | null>(null);
  const nextNotesCursorRef = useRef<string | null>(null);
  const notebooksRequestRef = useRef(0);
  const trashOperationsRef = useRef(new Set<string>());
  const [pendingTrashCount, setPendingTrashCount] = useState(0);
  const emptyingTrashRef = useRef(false);
  const [emptyingTrash, setEmptyingTrash] = useState(false);
  const listScope = JSON.stringify([view, notebookId, deferredQuery, noteSort]);
  const listScopeRef = useRef(listScope);
  if (listScopeRef.current !== listScope) nextNotesCursorRef.current = null;
  listScopeRef.current = listScope;
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;
  const [selectedNoteIds, setSelectedNoteIds] = useState<ReadonlySet<string>>(() => new Set());
  const noteSelectionRef = useRef<NoteSelectionState>({ ids: new Set(), anchorId: null });
  const [selectedNote, setSelectedNote] = useState<Note | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [outlineItems, setOutlineItems] = useState<OutlineItem[]>([]);
  const [activeOutlineId, setActiveOutlineId] = useState<string | null>(null);
  const outlineNavigateRef = useRef<((id: string) => void) | null>(null);
  const [editorFocusNoteId, setEditorFocusNoteId] = useState<string | null>(null);
  const handleEditorFocus = useCallback(() => setEditorFocusNoteId(null), []);
  const selectedRef = useRef<Note | null>(null);
  const activeNoteIdRef = useRef<string | null>(null);
  const noteLoadRequestRef = useRef(0);
  const noteAbortRef = useRef<AbortController | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const searchOriginRef = useRef<{ view: NoteView; notebookId?: string } | null>(null);
  const [isNoteLoading, setIsNoteLoading] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [focusMode, setFocusMode] = useState(() => {
    try {
      return localStorage.getItem("xiangying_focus_mode") === "true";
    } catch {
      return false;
    }
  });
  const toggleFocusMode = useCallback(() => {
    setFocusMode((current) => {
      const next = !current;
      try {
        localStorage.setItem("xiangying_focus_mode", String(next));
      } catch {}
      return next;
    });
  }, []);
  const [typewriterMode, setTypewriterMode] = useState(() => {
    try {
      return localStorage.getItem("xiangying_typewriter_mode") === "true";
    } catch {
      return false;
    }
  });
  const toggleTypewriterMode = useCallback(() => {
    setTypewriterMode((current) => {
      const next = !current;
      try {
        localStorage.setItem("xiangying_typewriter_mode", String(next));
      } catch {}
      return next;
    });
  }, []);
  const exitFocusMode = useCallback(() => {
    setFocusMode(false);
    try {
      localStorage.setItem("xiangying_focus_mode", "false");
    } catch {}
  }, []);
  const [viewLayout, setViewLayout] = useState<ViewLayout>(() => {
    try {
      return (localStorage.getItem("xiangying_view_layout") as ViewLayout) || "three-column";
    } catch {
      return "three-column";
    }
  });
  const [mobileViewLayout, setMobileViewLayout] = useState<ViewLayout>(() => {
    try { return localStorage.getItem("xiangying_mobile_view_layout") === "cards" ? "cards" : "three-column"; }
    catch { return "three-column"; }
  });
  const toggleViewLayout = useCallback(() => {
    if (window.matchMedia("(max-width: 900px)").matches) {
      setMobileViewLayout((current) => {
        const next = current === "cards" ? "three-column" : "cards";
        try { localStorage.setItem("xiangying_mobile_view_layout", next); } catch {}
        return next;
      });
      return;
    }
    setViewLayout((current) => {
      const next = current === "cards" ? "three-column" : "cards";
      try {
        localStorage.setItem("xiangying_view_layout", next);
      } catch {}
      return next;
    });
  }, []);
  const [cardEditingNoteId, setCardEditingNoteId] = useState<string | null>(null);
  const cardGridScrollPositionRef = useRef<{ scope: string; top: number }>({ scope: "", top: 0 });
  const mobileEditorVisitedRef = useRef(false);

  const editorRegionRef = useRef<HTMLElement | null>(null);
  const mobileRestoreRef = useRef<(context: MobileListContext, page: MobilePage) => void>(() => undefined);
  const { isMobileViewport, mobilePage, openMobileList, openMobileNote, backMobilePage, openMobileHome } = useMobileNavigation(
    { view, notebookId, query, sort: noteSort, noteId: selectedId, searchOrigin: searchOriginRef.current },
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
  const handleOutlineItemsChange = useCallback((nextItems: OutlineItem[]) => {
    setOutlineItems((current) => {
      const unchanged = current.length === nextItems.length && current.every((item, index) => {
        const next = nextItems[index];
        return next && item.id === next.id && item.level === next.level && item.title === next.title;
      });
      return unchanged ? current : nextItems;
    });
  }, []);
  const handleOutlineActiveChange = useCallback((nextId: string | null) => {
    setActiveOutlineId((current) => current === nextId ? current : nextId);
  }, []);
  const handleOutlineNavigationReady = useCallback((navigate: ((id: string) => void) | null) => {
    outlineNavigateRef.current = navigate;
  }, []);
  const [imageExportSnapshot, setImageExportSnapshot] = useState<ImageExportSnapshot | null>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandInitialQuery, setCommandInitialQuery] = useState("");
  const [inNoteSearchQuery, setInNoteSearchQuery] = useState("");
  const [editingNotebook, setEditingNotebook] = useState<Notebook | null | undefined>(undefined);
  const { notice, notifyError, notifyWarning, notifyInfo, dismiss: dismissNotice, setPaused: pauseNotice } = useNotices();
  const [ready, setReady] = useState(false);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const [noteReloadToken, setNoteReloadToken] = useState(0);
  const [pwaState, setPwaState] = useState<PwaState>({ standalone: false, canInstall: false, showIosInstallHint: false, updateAvailable: false });
  const realtimeRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRealtimeRefreshRef = useRef({ notebooks: false, notes: false, selected: false, noteIds: new Set<string>() });
  const shortcutHandledRef = useRef(false);
  const confirmIdRef = useRef(0);
  const replaceList = useCallback((next: NoteSummary[]) => { notesRef.current = next; setNotes(next); }, []);
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
    setSelectedNote,
    setToast: notifyError,
  });
  const persistRef = useRef(persist);
  persistRef.current = persist;

  const requestConfirm = useCallback((request: Omit<ConfirmRequest, "id">) => {
    confirmIdRef.current += 1;
    setConfirmRequest({ ...request, id: confirmIdRef.current, returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null });
  }, []);
  const updateNoteSelection = useCallback((next: NoteSelectionState) => {
    const normalized = { ids: new Set(next.ids), anchorId: next.anchorId };
    noteSelectionRef.current = normalized;
    setSelectedNoteIds(normalized.ids);
  }, []);
  const clearNoteSelection = useCallback(() => {
    updateNoteSelection({ ids: new Set(), anchorId: null });
  }, [updateNoteSelection]);
  const setNoteSelectionAnchor = useCallback((id: string) => {
    updateNoteSelection(noteSelectionAnchor(id));
  }, [updateNoteSelection]);
  const previousListScopeRef = useRef(listScope);
  useEffect(() => {
    if (previousListScopeRef.current === listScope) return;
    previousListScopeRef.current = listScope;
    clearNoteSelection();
  }, [clearNoteSelection, listScope]);

  useEffect(() => subscribePwa(setPwaState), []);
  useEffect(() => {
    let disposed = false;
    void api.bootstrap().then(async (status) => {
      if (!status.configured) { navigate(`/setup${window.location.search}`, { replace: true }); return; }
      try { await api.me(); if (!disposed) setReady(true); }
      catch { if (!disposed) navigate(`/login${window.location.search}`, { replace: true }); }
    }).catch(() => { if (!disposed) navigate(`/login${window.location.search}`, { replace: true }); });
    return () => { disposed = true; };
  }, [navigate]);
  const requestListTransition = useCallback(() => {
    listTransitionIntentRef.current += 1;
  }, []);
  const playListTransition = useCallback(() => {
    listTransitionConsumedRef.current = listTransitionIntentRef.current;
    setListTransitionToken((value) => value + 1);
  }, []);
  const playPendingListTransition = useCallback(() => {
    if (listTransitionIntentRef.current === listTransitionConsumedRef.current) return;
    playListTransition();
  }, [playListTransition]);
  const invalidateCollections = useCallback(() => { listRequestRef.current += 1; notebooksRequestRef.current += 1; }, []);
  const refreshNotebooks = useCallback(async () => {
    const requestId = ++notebooksRequestRef.current;
    try {
      const result = await api.listNotebooks();
      if (requestId === notebooksRequestRef.current && !trashOperationsRef.current.size && !emptyingTrashRef.current) {
        setNotebooks(result.notebooks);
      }
    } catch { /* Keep the current list visible until the next request succeeds. */ }
  }, []);
  const loadNotes = useCallback(async () => {
    if (pendingLinkedNoteRef.current) return;
    nextNotesCursorRef.current = null;
    setHasMoreNotes(false);
    const requestId = ++listRequestRef.current;
    listAbortRef.current?.abort();
    const controller = new AbortController();
    listAbortRef.current = controller;
    try {
      const result = await api.listNotes({ view, query: deferredQuery, notebookId, sort: noteSort }, { signal: controller.signal });
      if (requestId !== listRequestRef.current || listScope !== listScopeRef.current || trashOperationsRef.current.size || emptyingTrashRef.current) return;
      const active = selectedRef.current;
      const notesToDisplay = active && !result.notes.some((note) => note.id === active.id) &&
        shouldKeepActiveNoteInList(active, notebooks, view, deferredQuery, notebookId)
        ? [toNoteSummary(active), ...result.notes]
        : result.notes;
      replaceList(notesToDisplay);
      setTotalNotes(Math.max(result.total ?? 0, notesToDisplay.length));
      setHasMoreNotes(Boolean(result.hasMore));
      nextNotesCursorRef.current = result.nextCursor ?? null;
      const currentSelectedId = selectedIdRef.current;
      const nextSelectedId = currentSelectedId && notesToDisplay.some((note) => note.id === currentSelectedId) ? currentSelectedId : notesToDisplay[0]?.id ?? null;
      setSelectedId(nextSelectedId);
      updateNoteSelection(pruneNoteSelection(noteSelectionRef.current, sortNotes(notesToDisplay, noteSort).map((note) => note.id)));
      playPendingListTransition();
    } catch (reason) {
      if (reason instanceof Error && reason.name === "AbortError") return;
      if (reason instanceof ApiError && reason.status === 401) navigate(`/login${window.location.search}`, { replace: true });
    } finally {
      if (listAbortRef.current === controller) listAbortRef.current = null;
    }
  }, [deferredQuery, listScope, navigate, noteSort, notebookId, notebooks, notesReloadToken, playPendingListTransition, replaceList, updateNoteSelection, view]);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const loadMoreNotes = useCallback(async () => {
    const cursor = nextNotesCursorRef.current;
    if (isLoadingMore || !cursor) return;
    const requestId = listRequestRef.current;
    const scope = listScopeRef.current;
    setIsLoadingMore(true);
    try {
      const result = await api.listNotes({ view, query: deferredQuery, notebookId, sort: noteSort, cursor, includeTotal: false });
      if (requestId !== listRequestRef.current || scope !== listScopeRef.current || trashOperationsRef.current.size || emptyingTrashRef.current) return;
      const currentList = notesRef.current;
      const existingIds = new Set(currentList.map((note) => note.id));
      const nextNotes = result.notes.filter((note) => !existingIds.has(note.id));
      const merged = [...currentList, ...nextNotes];
      replaceList(merged);
      if (result.total !== undefined) setTotalNotes(Math.max(result.total, merged.length));
      setHasMoreNotes(Boolean(result.hasMore));
      nextNotesCursorRef.current = result.nextCursor ?? null;
    } catch {
      notifyError("加载更多笔记失败，请重试");
    } finally {
      setIsLoadingMore(false);
    }
  }, [deferredQuery, isLoadingMore, noteSort, notebookId, replaceList, view]);
  const reloadNotes = useCallback(() => setNotesReloadToken((value) => value + 1), []);
  useEffect(() => {
    if (!ready) return;
    void refreshNotebooks();
    reloadNotes();
  }, [ready, refreshNotebooks, reloadNotes]);
  const selectNote = useCallback((id: string | null) => {
    setInNoteSearchQuery("");
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
  }, [clearNoteSelection]);
  mobileRestoreRef.current = (context, page) => {
    flushEditorDraftRef.current();
    setOutlineOpen(false);
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
    window.history.replaceState(window.history.state, "", `${linkedUrl.pathname}${linkedUrl.search}${linkedUrl.hash}`);
    void api.getNote(initialLinkedNoteId, { signal: controller.signal }).then(({ note }) => {
      if (controller.signal.aborted) return;
      invalidateCollections();
      selectedRef.current = note;
      setSelectedNote(note);
      setView(note.deletedAt !== null ? "trash" : "all");
      setNotebookId(note.deletedAt !== null ? undefined : note.notebookId);
      setQuery("");
      selectNote(note.id);
      setCardEditingNoteId(note.id);
      openMobileNote({ view: note.deletedAt !== null ? "trash" : "all", notebookId: note.deletedAt !== null ? undefined : note.notebookId, query: "", noteId: note.id, searchOrigin: null });
    }).catch((error) => {
      if (!controller.signal.aborted) notifyError(errorMessage(error, "无法打开链接中的笔记"));
    }).finally(() => {
      if (controller.signal.aborted) return;
      pendingLinkedNoteRef.current = null;
      const url = new URL(window.location.href);
      url.searchParams.delete("note");
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
      reloadNotes();
    });
    return () => controller.abort();
  }, [openMobileNote, initialLinkedNoteId, invalidateCollections, ready, reloadNotes, selectNote]);
  useEffect(() => {
    setOutlineOpen(false);
    setOutlineItems([]);
    setActiveOutlineId(null);
    outlineNavigateRef.current = null;
  }, [selectedId]);
  useEffect(() => {
    if (focusMode) {
      setOutlineOpen(false);
    }
  }, [focusMode]);
  const removeFromList = useCallback((noteId: string) => {
    const ordered = sortNotes(notesRef.current, noteSort);
    const index = ordered.findIndex((note) => note.id === noteId);
    if (index === -1) return;
    replaceList(notesRef.current.filter((note) => note.id !== noteId));
    setTotalNotes((value) => Math.max(0, value - 1));
    if (activeNoteIdRef.current === noteId) {
      const nextId = ordered[index + 1]?.id ?? ordered[index - 1]?.id ?? null;
      selectNote(nextId);
      setCardEditingNoteId((current) => current === noteId ? nextId : current);
    }
  }, [noteSort, replaceList, selectNote]);
  const removeManyFromList = useCallback((noteIds: string[]) => {
    const deletedIds = new Set(noteIds);
    const currentList = notesRef.current;
    const ordered = sortNotes(currentList, noteSort);
    const visibleDeletedCount = currentList.filter((note) => deletedIds.has(note.id)).length;
    const activeId = activeNoteIdRef.current;
    const activeIndex = activeId ? ordered.findIndex((note) => note.id === activeId) : -1;
    const activeWasDeleted = Boolean(activeId && deletedIds.has(activeId));
    const nextActiveId = activeWasDeleted && activeIndex >= 0
      ? ordered.slice(activeIndex + 1).find((note) => !deletedIds.has(note.id))?.id
        ?? ordered.slice(0, activeIndex).reverse().find((note) => !deletedIds.has(note.id))?.id
        ?? null
      : null;

    replaceList(currentList.filter((note) => !deletedIds.has(note.id)));
    setTotalNotes((value) => Math.max(0, value - visibleDeletedCount));
    clearNoteSelection();
    if (activeWasDeleted) {
      selectNote(nextActiveId);
      setCardEditingNoteId((current) => current && deletedIds.has(current) ? nextActiveId : current);
    }
  }, [clearNoteSelection, noteSort, replaceList, selectNote]);
  const loadSelectedNote = useCallback(async (id: string) => {
    noteAbortRef.current?.abort();
    const controller = new AbortController();
    noteAbortRef.current = controller;
    setEditorFocusNoteId((current) => current === id ? current : null);
    const requestId = ++noteLoadRequestRef.current;
    let previousNote = selectedRef.current;
    if (previousNote?.id !== id) {
      flushEditorDraftRef.current();
      previousNote = selectedRef.current;
    }
    const pendingNote = pendingSavesRef.current.get(id);
    const failedSave = failedSavesRef.current.get(id);
    activeNoteIdRef.current = id;
    setIsNoteLoading(true);
    setSaveState(failedSave ? failedSave instanceof ApiError && failedSave.code === "VERSION_CONFLICT" ? "conflict" : "error" : pendingNote ? "saving" : "idle");
    try {
      const result = await api.getNote(id, { signal: controller.signal });
      if (requestId !== noteLoadRequestRef.current || activeNoteIdRef.current !== id) return;
      let loadedNote = latestSelectedNoteSnapshot(result.note, selectedRef.current);
      // The load can outlive a queued save; do not recover the same draft after
      // that save has already succeeded and started clearing its recovery copy.
      if (!pendingNote && !pendingSavesRef.current.has(id)) {
        const recoveredDraft = await readDraftRecovery(id);
        if (requestId !== noteLoadRequestRef.current || activeNoteIdRef.current !== id) return;
        loadedNote = latestSelectedNoteSnapshot(loadedNote, selectedRef.current);
        if (recoveredDraft && !pendingSavesRef.current.has(id)) {
          pendingSavesRef.current.set(id, recoveredDraft);
          if (recoveredDraft.version === loadedNote.version) {
            notifyWarning("已恢复一份未保存草稿");
          } else {
            failedSavesRef.current.set(id, new ApiError(409, "VERSION_CONFLICT", "恢复的草稿与服务器版本不同"));
            setSaveState("conflict");
            notifyWarning("已保留未保存草稿；服务器版本已变化，请先复制需要的修改再重新载入");
          }
        }
      }
      const latestPendingNote = pendingSavesRef.current.get(id);
      loadedNote = latestSelectedNoteSnapshot(loadedNote, selectedRef.current);
      const nextNote = latestPendingNote ? { ...loadedNote, ...latestPendingNote } : loadedNote;
      selectedRef.current = nextNote;
      setSelectedNote(nextNote);
      setIsNoteLoading(false);
      // A draft kept from an earlier failure or a note switch is retried instead of staying stuck on "saving".
      const retryDraft = latestPendingNote;
      if (retryDraft && !failedSavesRef.current.has(id) && !trashOperationsRef.current.has(id)) persistRef.current(retryDraft);
    } catch (reason) {
      if (requestId !== noteLoadRequestRef.current || activeNoteIdRef.current !== id) return;
      if (reason instanceof Error && reason.name === "AbortError") return;
      setIsNoteLoading(false);
      if (reason instanceof ApiError && reason.status === 401) {
        navigate(`/login${window.location.search}`, { replace: true });
        return;
      }
      if (previousNote) {
        const restoredNote = previousNote;
        const previousFailure = failedSavesRef.current.get(restoredNote.id);
        setSaveState(previousFailure
          ? previousFailure instanceof ApiError && previousFailure.code === "VERSION_CONFLICT" ? "conflict" : "error"
          : pendingSavesRef.current.has(restoredNote.id) ? "saving" : "idle");
        activeNoteIdRef.current = restoredNote.id;
        selectedRef.current = restoredNote;
        setSelectedId(restoredNote.id);
        setSelectedNote(restoredNote);
        setCardEditingNoteId((current) => current === id ? restoredNote.id : current);
      } else {
        activeNoteIdRef.current = null;
        selectedRef.current = null;
        setSelectedId(null);
        setSelectedNote(null);
      }
      notifyError("无法打开这篇笔记");
    } finally {
      if (noteAbortRef.current === controller) noteAbortRef.current = null;
    }
  }, [failedSavesRef, navigate]);
  useEffect(() => {
    if (!ready || !selectedId) {
      flushEditorDraftRef.current();
      noteAbortRef.current?.abort();
      activeNoteIdRef.current = null;
      selectedRef.current = null;
      setIsNoteLoading(false);
      setSelectedNote(null);
      return;
    }
    void loadSelectedNote(selectedId);
  }, [loadSelectedNote, ready, selectedId]);
  useEffect(() => () => { notebooksRequestRef.current += 1; }, []);
  useEffect(() => {
    if (!ready) return;
    nextNotesCursorRef.current = null;
    setHasMoreNotes(false);
    const timer = setTimeout(() => void loadNotes(), 180);
    return () => { clearTimeout(timer); listRequestRef.current += 1; };
  }, [loadNotes, ready]);
  useEffect(() => () => {
    listAbortRef.current?.abort();
    noteAbortRef.current?.abort();
    if (realtimeRefreshTimerRef.current !== null) clearTimeout(realtimeRefreshTimerRef.current);
  }, []);
  const openCommandMenu = useCallback((initialQuery = "") => {
    setCommandInitialQuery(initialQuery);
    setCommandOpen(true);
  }, []);
  const handleOpenCommands = useCallback(() => openCommandMenu(), [openCommandMenu]);
  const activeSearchQuery = inNoteSearchQuery || query;
  useWorkspaceShortcuts({
    focusMode,
    hasModalOpen: Boolean(commandOpen || imageExportSnapshot || editingNotebook !== undefined || confirmRequest),
    // Escape 第 1 层：正文搜索高亮清除优先于退出沉浸模式。
    hasSearchHighlight: Boolean(activeSearchQuery.trim()),
    clearSearchHighlight: () => handleClearSearch(),
    toggleSidebar: () => isMobileViewport ? openMobileHome() : setSidebarCollapsed((value) => !value),
    toggleFocusMode,
    toggleTypewriterMode,
    exitFocusMode,
    openCommandMenu: (initialQuery = "") => {
      setCommandInitialQuery(initialQuery);
      setCommandOpen(true);
    },
    toggleViewLayout,
    isCardEditing: !isMobileViewport && viewLayout === "cards" && cardEditingNoteId !== null,
    onExitCardEditing: () => setCardEditingNoteId(null),
    hasSelection: selectedNoteIds.size > 0,
    clearSelection: clearNoteSelection,
    outlineOpen,
    closeOutline,
  });


  const onNoteChange = useCallback((patch: { title?: string; contentMarkdown?: string; notebookId?: string }) => {
    const current = selectedRef.current;
    if (!current || trashOperationsRef.current.has(current.id)) return;
    if ((patch.title === undefined || patch.title === current.title) && (patch.contentMarkdown === undefined || patch.contentMarkdown === current.contentMarkdown) && (patch.notebookId === undefined || patch.notebookId === current.notebookId)) return;
    const targetNotebook = patch.notebookId ? notebooks.find((nb) => nb.id === patch.notebookId) : undefined;
    const next = { ...current, ...patch, ...(targetNotebook ? { notebookName: targetNotebook.name } : {}) };
    selectedRef.current = next;
    const contentOnlyChange = patch.contentMarkdown !== undefined && patch.title === undefined && patch.notebookId === undefined;
    if (!contentOnlyChange) {
      setSelectedNote(next);
      const summaryPatch: Partial<NoteSummary> = {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.notebookId !== undefined ? { notebookId: patch.notebookId } : {}),
        ...(targetNotebook ? { notebookName: targetNotebook.name } : {}),
      };
      replaceList(notesRef.current.map((note) => note.id === current.id ? { ...note, ...summaryPatch } : note));
    }

    if (patch.notebookId && patch.notebookId !== current.notebookId) {
      if (targetNotebook) {
        invalidateCollections();
        searchOriginRef.current = null;
        setQuery("");
        const targetView: NoteView = targetNotebook.isSystem ? "inbox" : "all";
        const targetNotebookId = targetNotebook.isSystem ? undefined : targetNotebook.id;
        requestListTransition();
        setView(targetView);
        setNotebookId(targetNotebookId);
        replaceList([toNoteSummary(next)]);
        setTotalNotes(Math.max(1, targetNotebook.count + 1));
        setNotebooks((items) => items.map((notebook) => {
          if (notebook.id === current.notebookId) return { ...notebook, count: Math.max(0, notebook.count - 1) };
          if (notebook.id === targetNotebook.id) return { ...notebook, count: notebook.count + 1 };
          return notebook;
        }));
      }
      void saveImmediately(next, false, ["notebookId"]).then(() => {
        refreshNotebooks();
        reloadNotes();
      }).catch(() => {
        refreshNotebooks();
        reloadNotes();
      });
    } else {
      persist(next, Object.keys(patch) as Array<"title" | "contentMarkdown" | "notebookId">);
    }
  }, [invalidateCollections, notebooks, persist, refreshNotebooks, reloadNotes, replaceList, requestListTransition, saveImmediately]);
  const registerEditorMarkdownReader = useCallback((reader: (() => string | null) | null) => {
    editorMarkdownReaderRef.current = reader;
  }, []);
  const registerEditorMarkdownDirty = useCallback((noteId: string, isDirty: boolean) => {
    if (isDirty) editorMarkdownDirtyNoteRef.current = noteId;
    else if (editorMarkdownDirtyNoteRef.current === noteId) editorMarkdownDirtyNoteRef.current = null;
  }, []);
  const flushActiveEditorDraft = useCallback(() => {
    const current = selectedRef.current;
    if (!current || trashOperationsRef.current.has(current.id)) return;
    const markdown = editorMarkdownReaderRef.current?.();
    if (markdown == null || markdown === current.contentMarkdown) return;
    const next = { ...current, contentMarkdown: markdown };
    selectedRef.current = next;
    persistRef.current(next, ["contentMarkdown"]);
  }, []);
  flushEditorDraftRef.current = flushActiveEditorDraft;
  const revealCreatedNote = useCallback((note: Note, target: { view: NoteView; notebookId?: string }) => {
    flushEditorDraftRef.current();
    invalidateCollections();
    searchOriginRef.current = null;
    setView(target.view);
    setNotebookId(target.notebookId);
    setQuery("");
    replaceList([toNoteSummary(note), ...notesRef.current.filter((currentNote) => currentNote.id !== note.id)]);
    setTotalNotes((value) => value + 1);
    playListTransition();
    setSelectedNote(note);
    setIsNoteLoading(true);
    selectedRef.current = note;
    activeNoteIdRef.current = note.id;
    clearPendingForNote(note.id);
    setEditorFocusNoteId(note.id);
    setSelectedId(note.id);
    setCardEditingNoteId(note.id);
    openMobileNote({ ...target, query: "", noteId: note.id, searchOrigin: null });
  }, [openMobileNote, playListTransition]);
  const createNoteHere = useCallback(async () => {
    const currentNotebook = notebookId ? notebooks.find((notebook) => notebook.id === notebookId) : undefined;
    const inbox = notebooks.find((notebook) => notebook.isSystem);
    const staysInView = Boolean(currentNotebook) || view === "all" || view === "inbox";
    try {
      const result = await api.createNote(currentNotebook ? { notebookId: currentNotebook.id } : { notebookId: inbox?.id });
      revealCreatedNote(result.note, { view: currentNotebook || !staysInView ? "all" : view, notebookId: currentNotebook?.id });
      void refreshNotebooks();
    } catch (reason) { notifyError(errorMessage(reason, "创建笔记失败")); }
  }, [notebookId, notebooks, refreshNotebooks, revealCreatedNote, view]);
  const createNoteInInbox = useCallback(async () => {
    if (inboxNoteCreationRef.current) return;
    const inbox = notebooks.find((notebook) => notebook.isSystem);
    inboxNoteCreationRef.current = true;
    try {
      const result = await api.createNote(inbox ? { notebookId: inbox.id } : {});
      revealCreatedNote(result.note, { view: "inbox", notebookId: result.note.notebookId });
      void refreshNotebooks();
    } catch (reason) {
      notifyError(errorMessage(reason, "创建笔记失败"));
    } finally {
      inboxNoteCreationRef.current = false;
    }
  }, [notebooks, refreshNotebooks, revealCreatedNote]);
  const createNoteInNotebook = useCallback(async (commandToCreate: CreateNoteCommand) => {
    try {
      const result = await api.createNote({ notebookId: commandToCreate.notebookId, title: commandToCreate.title });
      revealCreatedNote(result.note, { view: "all", notebookId: commandToCreate.notebookId });
      void refreshNotebooks();
    } catch (reason) { if (reason instanceof ApiError && reason.status === 401) navigate(`/login${window.location.search}`, { replace: true }); notifyError(errorMessage(reason, "创建笔记失败，请稍后重试")); }
  }, [navigate, notebooks, refreshNotebooks, revealCreatedNote]);
  const createNotebook = useCallback(() => setEditingNotebook(null), []);
  const saveNotebook = useCallback((saved: Notebook) => {
    setNotebooks((current) => {
      const exists = current.some((nb) => nb.id === saved.id);
      return exists ? current.map((nb) => nb.id === saved.id ? { ...nb, ...saved } : nb) : [...current, saved];
    });
    if (editingNotebook) {
      const current = selectedRef.current;
      if (current?.notebookId === saved.id) {
        const next = { ...current, notebookName: saved.name };
        selectedRef.current = next;
        setSelectedNote(next);
      }
    } else {
      setNotebookId(saved.id);
      setView("all");
      openMobileList({ view: "all", notebookId: saved.id, query: "", searchOrigin: null });
    }
    setEditingNotebook(undefined);
  }, [openMobileList, editingNotebook]);
  const saveNotebookDraft = useCallback(async (draft: { name: string; color: string; icon: string }) => {
    const existing = editingNotebook ?? undefined;
    const timestamp = Math.floor(Date.now() / 1000);
    const notebook: Notebook = existing
      ? { ...existing, name: draft.name, color: draft.color, icon: draft.icon }
      : { id: createUuid(), name: draft.name, color: draft.color, icon: draft.icon, isSystem: false, count: 0, updatedAt: timestamp };
    const result = existing
      ? await api.updateNotebook(notebook.id, { name: notebook.name, color: notebook.color, icon: notebook.icon })
      : await api.createNotebook({ name: notebook.name, color: notebook.color, icon: notebook.icon });
    return result.notebook;
  }, [editingNotebook]);
  const refreshSelectedNoteFromRemote = useCallback((noteId: string) => refreshSelectedNote(noteId, {
    selectedRef,
    activeNoteIdRef,
    noteAbortRef,
    noteLoadRequestRef,
    hasPendingWork: (id) => pendingSavesRef.current.has(id) || failedSavesRef.current.has(id) || editorMarkdownDirtyNoteRef.current === id,
    onConflict: () => {
      setSaveState("conflict");
      notifyWarning("当前笔记已在其他设备更新，请先保存或重新载入");
    },
    onUpdated: (note) => {
      setSelectedNote(note);
      replaceList(notesRef.current.map((n) => (n.id === noteId ? { ...n, ...toNoteSummary(note) } : n)));
      setNoteReloadToken((value) => value + 1);
      setSaveState("idle");
    },
    onUnauthorized: () => navigate(`/login${window.location.search}`, { replace: true }),
    onNotFound: removeFromList,
    onError: () => notifyError("同步当前笔记失败，请稍后重试"),
  }), [failedSavesRef, navigate, pendingSavesRef, removeFromList, replaceList, setSaveState]);
  const deleteNotebook = useCallback(async (id: string) => {
    const target = notebooks.find((notebook) => notebook.id === id);
    if (!target || target.isSystem) throw new Error("无法删除此笔记本");
    await flushNotebookSaves(id);
    await api.deleteNotebook(id);
    const activeNote = selectedRef.current;
    if (activeNote?.notebookId === id) await refreshSelectedNoteFromRemote(activeNote.id);
    setNotebooks((current) => current.filter((notebook) => notebook.id !== id));
    if (notebookId === id) setNotebookId(undefined);
    refreshNotebooks();
    void loadNotes();
    setEditingNotebook(undefined);
  }, [flushNotebookSaves, loadNotes, notebookId, notebooks, refreshNotebooks, refreshSelectedNoteFromRemote]);
  const toggleFavorite = useCallback(() => {
    const current = selectedRef.current;
    if (!current) return;
    const next = { ...current, isFavorite: !current.isFavorite };
    selectedRef.current = next;
    setSelectedNote(next);
    if (view !== "favorites" || next.isFavorite) {
      persist(next);
      return;
    }

    const scope = listScopeRef.current;
    void saveImmediately(next, false, ["isFavorite"]).then(() => {
      if (scope === listScopeRef.current) removeFromList(current.id);
    }).catch(() => undefined);
  }, [persist, removeFromList, saveImmediately, view]);
  const finishTrashOperation = useCallback((noteId: string) => {
    trashOperationsRef.current.delete(noteId);
    setPendingTrashCount(trashOperationsRef.current.size);
    invalidateCollections();
    if (!trashOperationsRef.current.size) { void refreshNotebooks(); reloadNotes(); }
  }, [invalidateCollections, refreshNotebooks, reloadNotes]);
  const changeDeletedState = useCallback(async (deleted: boolean) => {
    flushEditorDraftRef.current();
    const current = selectedRef.current;
    if (!current || Boolean(current.deletedAt) === deleted || trashOperationsRef.current.has(current.id) || emptyingTrashRef.current) return;
    const scope = listScopeRef.current;
    const next = { ...current, deletedAt: deleted ? Math.floor(Date.now() / 1000) : null };
    trashOperationsRef.current.add(current.id);
    setPendingTrashCount(trashOperationsRef.current.size);
    invalidateCollections();
    setNotebooks((items) => items.map((notebook) => notebook.id === current.notebookId ? { ...notebook, count: Math.max(0, notebook.count + (deleted ? -1 : 1)) } : notebook));
    try {
      await saveImmediately(next, false, ["deleted"]);
      if (scope === listScopeRef.current) removeFromList(current.id);
    } catch (reason) {
      pendingSavesRef.current.set(current.id, toNoteDraft(current));
      setNotebooks((items) => items.map((notebook) => notebook.id === current.notebookId ? { ...notebook, count: Math.max(0, notebook.count + (deleted ? 1 : -1)) } : notebook));
      notifyError(reason instanceof ApiError && reason.code === "VERSION_CONFLICT" ? "这篇笔记已在别处更新，操作未完成，本地草稿已保留" : errorMessage(reason, deleted ? "移入回收站失败，请重试" : "恢复笔记失败，请重试"));
    } finally { finishTrashOperation(current.id); }
  }, [finishTrashOperation, invalidateCollections, pendingSavesRef, removeFromList, saveImmediately]);
  const moveToTrash = useCallback(() => { void changeDeletedState(true); }, [changeDeletedState]);
  const restoreFromTrash = useCallback(() => { void changeDeletedState(false); }, [changeDeletedState]);
  const discardNoteDraft = useCallback((noteId: string) => {
    clearPendingForNote(noteId);
  }, [clearPendingForNote]);
  const getBatchEntries = useCallback((noteIds: string[]) => {
    const selected = new Set(noteIds);
    return sortNotes(notesRef.current, noteSort)
      .filter((note) => selected.has(note.id))
      .map((note) => ({ id: note.id, version: note.version }));
  }, [noteSort]);
  const performBatchDelete = useCallback(async (noteIds: string[], permanent: boolean) => {
    flushEditorDraftRef.current();
    const ids = [...new Set(noteIds)];
    if (!ids.length) return;
    if (emptyingTrashRef.current || trashOperationsRef.current.size) throw new ApiError(409, "TRASH_BUSY", "回收站正在处理其他操作，请稍后重试");

    ids.forEach((id) => trashOperationsRef.current.add(id));
    setPendingTrashCount(trashOperationsRef.current.size);
    invalidateCollections();
    try {
      await Promise.all(ids.map((id) => runSave(id)));
      const entries = getBatchEntries(ids);
      if (entries.length !== ids.length) throw new ApiError(409, "NOTE_SELECTION_STALE", "选中的笔记已不在当前列表，请重新选择");
      const result = permanent ? await api.deleteNotes(entries) : await api.moveNotesToTrash(entries);
      for (const id of result.deletedIds) discardNoteDraft(id);
      removeManyFromList(result.deletedIds);
    } finally {
      ids.forEach((id) => trashOperationsRef.current.delete(id));
      setPendingTrashCount(trashOperationsRef.current.size);
      invalidateCollections();
      void refreshNotebooks();
      reloadNotes();
    }
  }, [discardNoteDraft, getBatchEntries, invalidateCollections, refreshNotebooks, reloadNotes, removeManyFromList, runSave]);
  const performBatchRestore = useCallback(async (noteIds: string[]) => {
    flushEditorDraftRef.current();
    const ids = [...new Set(noteIds)];
    if (!ids.length) return;
    if (emptyingTrashRef.current || trashOperationsRef.current.size) throw new ApiError(409, "TRASH_BUSY", "回收站正在处理其他操作，请稍后重试");

    ids.forEach((id) => trashOperationsRef.current.add(id));
    setPendingTrashCount(trashOperationsRef.current.size);
    invalidateCollections();
    try {
      await Promise.all(ids.map((id) => runSave(id)));
      const entries = getBatchEntries(ids);
      if (entries.length !== ids.length) throw new ApiError(409, "NOTE_SELECTION_STALE", "选中的笔记已不在当前列表，请重新选择");
      const result = await api.restoreNotes(entries);
      for (const id of result.restoredIds) discardNoteDraft(id);
      removeManyFromList(result.restoredIds);
    } finally {
      ids.forEach((id) => trashOperationsRef.current.delete(id));
      setPendingTrashCount(trashOperationsRef.current.size);
      invalidateCollections();
      void refreshNotebooks();
      reloadNotes();
    }
  }, [discardNoteDraft, getBatchEntries, invalidateCollections, refreshNotebooks, reloadNotes, removeManyFromList, runSave]);
  const showBatchDeleteError = useCallback((reason: unknown) => {
    notifyError(reason instanceof ApiError && reason.code === "VERSION_CONFLICT" ? "选中的笔记已发生变化，请重新选择后重试" : errorMessage(reason, "批量删除失败，请重试"));
  }, []);
  const showBatchRestoreError = useCallback((reason: unknown) => {
    notifyError(reason instanceof ApiError && reason.code === "VERSION_CONFLICT" ? "选中的笔记已发生变化，请重新选择后重试" : errorMessage(reason, "批量恢复失败，请重试"));
  }, []);
  const deleteSelectedNotes = useCallback(() => {
    const ids = [...noteSelectionRef.current.ids];
    if (!ids.length || pendingTrashCount > 0 || emptyingTrashRef.current) return;
    if (view === "trash") {
      requestConfirm({
        eyebrow: "不可撤销",
        title: `彻底删除 ${ids.length} 篇笔记？`,
        description: "这些笔记会从数据库永久移除，回收站不再保留。",
        confirmLabel: "彻底删除",
        danger: true,
        onConfirm: () => performBatchDelete(ids, true),
      });
      return;
    }
    void performBatchDelete(ids, false).catch(showBatchDeleteError);
  }, [emptyingTrashRef, pendingTrashCount, performBatchDelete, requestConfirm, showBatchDeleteError, view]);
  const restoreSelectedNotes = useCallback(() => {
    const ids = [...noteSelectionRef.current.ids];
    if (view !== "trash" || ids.length < 2 || pendingTrashCount > 0 || emptyingTrashRef.current) return;
    void performBatchRestore(ids).catch(showBatchRestoreError);
  }, [emptyingTrashRef, pendingTrashCount, performBatchRestore, showBatchRestoreError, view]);
  const performPermanentDelete = useCallback(async (noteId: string, expectedVersion: number) => {
    if (trashOperationsRef.current.has(noteId) || emptyingTrashRef.current) throw new ApiError(409, "TRASH_BUSY", "回收站正在处理其他操作，请稍后重试");
    flushEditorDraftRef.current();
    trashOperationsRef.current.add(noteId);
    setPendingTrashCount(trashOperationsRef.current.size);
    invalidateCollections();
    try {
      const savedVersion = await runSave(noteId);
      await api.deleteNote(noteId, savedVersion ?? expectedVersion);
      removeFromList(noteId);
      discardNoteDraft(noteId);
    } finally { finishTrashOperation(noteId); }
  }, [discardNoteDraft, finishTrashOperation, invalidateCollections, removeFromList, runSave]);
  const permanentDeleteNote = useCallback(async () => {
    flushEditorDraftRef.current();
    const current = selectedRef.current;
    if (!current) return;
    requestConfirm({
      eyebrow: "不可撤销",
      title: `彻底删除“${current.title.trim() || "未命名笔记"}”？`,
      description: "这篇笔记会从数据库中永久移除，回收站不再保留。",
      confirmLabel: "彻底删除",
      danger: true,
      onConfirm: () => performPermanentDelete(current.id, current.version),
    });
  }, [performPermanentDelete, requestConfirm]);
  const restoreNoteFromList = useCallback(async (noteId: string) => {
    if (emptyingTrashRef.current || trashOperationsRef.current.size > 0) throw new ApiError(409, "TRASH_BUSY", "回收站正在处理其他操作，请稍后重试");
    flushEditorDraftRef.current();
    trashOperationsRef.current.add(noteId);
    setPendingTrashCount(trashOperationsRef.current.size);
    invalidateCollections();
    try {
      await runSave(noteId);
      const current = notesRef.current.find((note) => note.id === noteId);
      if (!current || !current.deletedAt) throw new ApiError(409, "NOTE_SELECTION_STALE", "这篇笔记已不在回收站，请刷新后重试");
      await api.updateNote(noteId, { version: current.version, deleted: false }, { response: "summary" });
      removeFromList(noteId);
      discardNoteDraft(noteId);
    } finally { finishTrashOperation(noteId); }
  }, [discardNoteDraft, finishTrashOperation, invalidateCollections, notesRef, removeFromList, runSave]);
  const handleNoteSwipeAction = useCallback((note: NoteSummary, action: NoteSwipeAction) => {
    if (pendingTrashCount > 0 || emptyingTrashRef.current) return;
    if (action === "trash") {
      void performBatchDelete([note.id], false).catch(showBatchDeleteError);
    } else if (action === "restore") {
      void restoreNoteFromList(note.id).catch((reason) => notifyError(reason instanceof ApiError && reason.code === "VERSION_CONFLICT" ? "这篇笔记已在别处更新，恢复未完成，请刷新后重试" : errorMessage(reason, "恢复笔记失败，请重试")));
    } else {
      requestConfirm({
        eyebrow: "不可撤销",
        title: `彻底删除“${note.title.trim() || "未命名笔记"}”？`,
        description: "这篇笔记会从数据库中永久移除，回收站不再保留。",
        confirmLabel: "彻底删除",
        danger: true,
        onConfirm: () => performPermanentDelete(note.id, note.version),
      });
    }
  }, [emptyingTrashRef, notifyError, pendingTrashCount, performBatchDelete, performPermanentDelete, requestConfirm, restoreNoteFromList, showBatchDeleteError]);
  const performEmptyTrash = useCallback(async () => {
    if (emptyingTrashRef.current || trashOperationsRef.current.size) throw new ApiError(409, "TRASH_BUSY", "回收站正在处理其他操作，请稍后重试");
    flushEditorDraftRef.current();
    const scope = listScopeRef.current;
    emptyingTrashRef.current = true;
    setEmptyingTrash(true);
    invalidateCollections();
    try {
      const pendingTrash = [...pendingSavesRef.current.values()].filter((note) => note.deletedAt);
      await Promise.all(pendingTrash.map((note) => runSave(note.id)));
      const result = await api.emptyTrash();
      for (const id of result.deletedIds) { removeFromList(id); discardNoteDraft(id); }
      if (scope === listScopeRef.current) { replaceList([]); setTotalNotes(0); selectNote(null); }
    } finally {
      emptyingTrashRef.current = false;
      setEmptyingTrash(false);
      invalidateCollections();
      void refreshNotebooks();
      reloadNotes();
    }
  }, [discardNoteDraft, invalidateCollections, refreshNotebooks, reloadNotes, removeFromList, replaceList, runSave, selectNote]);
  const emptyTrash = useCallback(() => {
    if (!totalNotes || pendingTrashCount || emptyingTrashRef.current) return;
    requestConfirm({
      eyebrow: "不可撤销",
      title: "清空回收站？",
      description: `将永久删除回收站中的全部笔记（当前共 ${totalNotes} 篇），包括列表尚未显示的笔记。删除后无法恢复。`,
      confirmLabel: "清空回收站",
      danger: true,
      onConfirm: performEmptyTrash,
    });
  }, [pendingTrashCount, performEmptyTrash, requestConfirm, totalNotes]);

  const handleMoveSelectedToNotebook = useCallback(async (targetNotebookId: string) => {
    const ids = [...noteSelectionRef.current.ids];
    if (!ids.length) return;
    try {
      await Promise.all(
        ids.map(async (id) => {
          const note = notesRef.current.find((n) => n.id === id);
          if (!note) return;
          return api.updateNote(id, { version: note.version, notebookId: targetNotebookId }, { response: "summary" });
        })
      );
      clearNoteSelection();
      void loadNotes();
      void refreshNotebooks();
    } catch (reason) {
      notifyError(errorMessage(reason, "移动笔记失败"));
    }
  }, [clearNoteSelection, loadNotes, refreshNotebooks, notifyError]);

  const handleToggleFavoriteCardNote = useCallback(async (target: NoteSummary) => {
    const isFavorite = !target.isFavorite;
    try {
      await saveFavorite(target.id, isFavorite);
      if (view === "favorites" && !isFavorite) removeFromList(target.id);
    } catch (reason) {
      notifyError(errorMessage(reason, "操作失败"));
    }
  }, [removeFromList, saveFavorite, notifyError, view]);

  const handleMoveCardNoteToTrash = useCallback(async (target: NoteSummary) => {
    try {
      await api.moveNotesToTrash([{ id: target.id, version: target.version }]);
      clearPendingForNote(target.id);
      removeFromList(target.id);
    } catch (reason) {
      notifyError(errorMessage(reason, "移入回收站失败"));
    }
  }, [clearPendingForNote, removeFromList, notifyError]);

  const handleRestoreCardNote = useCallback(async (target: NoteSummary) => {
    try {
      await api.updateNote(target.id, { version: target.version, deleted: false }, { response: "summary" });
      clearPendingForNote(target.id);
      removeFromList(target.id);
    } catch (reason) {
      notifyError(errorMessage(reason, "恢复笔记失败"));
    }
  }, [clearPendingForNote, removeFromList, notifyError]);

  const handlePermanentDeleteCardNote = useCallback((target: NoteSummary) => {
    requestConfirm({
      eyebrow: "不可撤销",
      title: `彻底删除“${target.title.trim() || "未命名笔记"}”？`,
      description: "这篇笔记会从数据库中永久移除，回收站不再保留。",
      confirmLabel: "彻底删除",
      danger: true,
      onConfirm: async () => {
        try {
          await api.deleteNotes([{ id: target.id, version: target.version }]);
          clearPendingForNote(target.id);
          removeFromList(target.id);
        } catch (reason) {
          notifyError(errorMessage(reason, "删除笔记失败"));
        }
      },
    });
  }, [clearPendingForNote, removeFromList, requestConfirm, notifyError]);
  const reloadSelectedNote = useCallback(async () => {
    const current = selectedRef.current;
    if (!current) return;
    setIsNoteLoading(true);
    try {
      const result = await api.getNote(current.id);
      if (selectedRef.current?.id !== result.note.id) return;
      clearPendingForNote(current.id);
      selectedRef.current = result.note;
      setSelectedNote(result.note);
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
      description: "这篇笔记已在别处更新。重新载入会使用服务器上的最新内容替换当前编辑，本地尚未保存的修改将丢失。",
      confirmLabel: "重新载入",
      onConfirm: () => void reloadSelectedNote(),
    });
  }, [reloadSelectedNote, requestConfirm]);
  const handleRealtimeChange = useCallback((message?: WorkspaceChangeMessage) => {
    const pending = pendingRealtimeRefreshRef.current;
    const resource = message?.resource;
    if (!message || resource === "notes" || resource === "notebooks") pending.notebooks = true;
    if (!message || resource === "notes" || resource === "notebooks") pending.notes = true;
    if (!message || resource === "notes") {
      if (!message?.noteId) pending.selected = true;
      else pending.noteIds.add(message.noteId);
    }
    if (realtimeRefreshTimerRef.current !== null) return;
    realtimeRefreshTimerRef.current = setTimeout(() => {
      realtimeRefreshTimerRef.current = null;
      const next = pendingRealtimeRefreshRef.current;
      pendingRealtimeRefreshRef.current = { notebooks: false, notes: false, selected: false, noteIds: new Set() };
      if (next.notebooks) void refreshNotebooks();
      if (next.notes) reloadNotes();
      const activeId = activeNoteIdRef.current;
      if (activeId && (next.selected || next.noteIds.has(activeId))) void refreshSelectedNoteFromRemote(activeId);
    }, 50);
  }, [refreshNotebooks, refreshSelectedNoteFromRemote, reloadNotes, view]);
  useWorkspaceRealtime({ ready, onChange: handleRealtimeChange });
  const selectView = useCallback((next: NoteView) => {
    if (view !== next || notebookId || query) requestListTransition();
    searchOriginRef.current = null;
    setQuery("");
    setView(next);
    setNotebookId(undefined);
    setCardEditingNoteId(null);
    openMobileList({ view: next, notebookId: undefined, query: "", searchOrigin: null });
  }, [openMobileList, notebookId, query, requestListTransition, view]);
  const selectNotebook = useCallback((notebookIdToSelect: string) => {
    if (notebookId !== notebookIdToSelect || view !== "all" || query) requestListTransition();
    searchOriginRef.current = null;
    setQuery("");
    setNotebookId(notebookIdToSelect);
    setView("all");
    setCardEditingNoteId(null);
    openMobileList({ view: "all", notebookId: notebookIdToSelect, query: "", searchOrigin: null });
  }, [openMobileList, notebookId, query, requestListTransition, view]);
  const changeQuery = useCallback((next: string) => {
    if (next) {
      if (!query) {
        requestListTransition();
        searchOriginRef.current = { view, notebookId };
      }
      setQuery(next);
      setView("all");
      setNotebookId(undefined);
      openMobileList({ view: "all", notebookId: undefined, query: next, searchOrigin: searchOriginRef.current });
      return;
    }
    if (query) requestListTransition();
    const origin = searchOriginRef.current;
    searchOriginRef.current = null;
    setQuery("");
    setView(origin?.view ?? "all");
    setNotebookId(origin?.notebookId);
  }, [notebookId, openMobileList, query, requestListTransition, view]);
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
    setInNoteSearchQuery(normalized);
  }, []);
  const handleSearchGlobal = useCallback((term: string) => {
    const normalized = term.trim();
    if (!normalized) return;
    changeQuery(normalized);
    setSidebarCollapsed(false);
    setCardEditingNoteId(null);
    openMobileList();
    closeCommandMenu();
  }, [changeQuery, closeCommandMenu, openMobileList]);
  const handleFocusGlobalSearch = useCallback(() => {
    setSidebarCollapsed(false);
    setCardEditingNoteId(null);
    openMobileList();
    closeCommandMenu();
    requestAnimationFrame(() => {
      searchRef.current?.focus();
      searchRef.current?.select();
    });
  }, [closeCommandMenu, openMobileList]);
  const handleClearSearch = useCallback(() => {
    setInNoteSearchQuery("");
    if (query) {
      changeQuery("");
    }
  }, [changeQuery, query]);
  const handleExportNotes = useCallback(async () => {
    try {
      await flushPendingSaves("now");
      if (hasUnsavedWork()) {
        notifyWarning("仍有内容未保存，请保存成功后再导出");
        return;
      }
      const response = await fetch("/api/export", { credentials: "include" });
      if (!response.ok) throw new Error("export-failed");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `xiangying-notes-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      notifyError("导出失败，请检查网络后重试");
    }
  }, [flushPendingSaves, hasUnsavedWork]);
  const handleExportImage = useCallback(() => {
    flushEditorDraftRef.current();
    const note = selectedRef.current;
    if (!note || isNoteLoading) return;
    setImageExportSnapshot({ title: note.title, contentMarkdown: note.contentMarkdown });
  }, [isNoteLoading]);
  const closeImageExport = useCallback(() => setImageExportSnapshot(null), []);

  const copyNoteMarkdown = useCallback(async () => {
    const note = selectedRef.current;
    if (!note) return;
    const markdown = editorMarkdownReaderRef.current?.() ?? note.contentMarkdown;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard-unavailable");
      await navigator.clipboard.writeText(markdown);
      notifyInfo("笔记 Markdown 已复制");
    } catch {
      notifyError("复制失败，请检查浏览器剪贴板权限");
    }
  }, []);
  const command = useCallback((id: CommandId) => {
    if (id === "new-note") void createNoteInInbox();
    if (id === "find-in-note") {
      const selectedText = window.getSelection()?.toString().trim() ?? "";
      const initial = selectedText && selectedText.length <= 50 ? selectedText : "";
      setCommandInitialQuery(initial);
      setCommandOpen(true);
    }
    if (id === "toggle-sidebar") { if (isMobileViewport) openMobileHome(); else setSidebarCollapsed((value) => !value); }
    if (id === "toggle-view-layout") toggleViewLayout();
    if (id === "toggle-focus-mode") toggleFocusMode();
    if (id === "toggle-typewriter-mode") toggleTypewriterMode();
    if (id === "set-theme-light") setThemePreference("light");
    if (id === "set-theme-dark") setThemePreference("dark");
    if (id === "set-theme-system") setThemePreference("system");
    if (id === "copy-note-markdown") void copyNoteMarkdown();
    if (id === "favorite") toggleFavorite();
    if (id === "trash") moveToTrash();
    if (id === "restore") restoreFromTrash();
    if (id === "export-image") handleExportImage();
    if (id === "export-notes") void handleExportNotes();
    if (id === "install-app") { if (pwaState.canInstall) void installPwa(); else if (pwaState.showIosInstallHint && !pwaState.standalone) notifyInfo("请在 Safari 中点击分享，再选择“添加到主屏幕”"); }
  }, [copyNoteMarkdown, createNoteInInbox, handleExportImage, handleExportNotes, isMobileViewport, moveToTrash, openMobileHome, pwaState, restoreFromTrash, setThemePreference, toggleFavorite, toggleFocusMode, toggleTypewriterMode, toggleViewLayout]);
  useEffect(() => {
    if (!ready || shortcutHandledRef.current) return;
    const action = new URLSearchParams(window.location.search).get("action");
    if (action === "new-note") void createNoteInInbox();
    if (action === "search") { openMobileList(); requestAnimationFrame(() => searchRef.current?.focus()); }
    shortcutHandledRef.current = true;
    if (action) window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.hash}`);
  }, [createNoteInInbox, openMobileList, ready]);
  const logout = useCallback(async () => {
    await flushPendingSaves("now");
    if (hasUnsavedWork()) {
      notifyWarning("仍有内容未保存，请稍后再退出");
      return;
    }
    await api.logout().catch(() => undefined);
    clearAllDraftRecoveries();
    navigate(`/login${window.location.search}`, { replace: true });
  }, [flushPendingSaves, navigate]);
  const updatePwa = useCallback(async () => {
    await flushPendingSaves("now");
    if (hasUnsavedWork()) { notifyWarning("仍有编辑内容未保存，更新已暂缓"); return; }
    applyPwaUpdate();
  }, [flushPendingSaves, hasUnsavedWork]);

  const ensureWikiNoteExists = useCallback(
    async (title: string): Promise<NoteSummary | null> => {
      const cleanTitle = title.replace(/^(?:\[\[|【【)\s*|\s*(?:\]\]|】】)$/g, "").trim();
      const normalized = normalizeLinkTitle(cleanTitle);
      if (!normalized) return null;
      const inFlight = pendingWikiCreationsRef.current.get(normalized);
      if (inFlight) {
        return await inFlight;
      }
      const defaultNotebook = notebookId
        ? notebooks.find((n) => n.id === notebookId)
        : notebooks.find((n) => n.isSystem) ?? notebooks[0];
      if (!defaultNotebook) return null;
      const creationPromise = (async () => {
        try {
          const result = await api.ensureWikiNote({ title: cleanTitle, notebookId: defaultNotebook.id });

          const summary: NoteSummary = {
            id: result.note.id,
            title: result.note.title,
            preview: result.note.preview,
            tags: result.note.tags,
            thumbnail: result.note.thumbnail,
            notebookId: result.note.notebookId,
            notebookName: result.note.notebookName,
            isFavorite: result.note.isFavorite,
            deletedAt: result.note.deletedAt,
            version: result.note.version,
            createdAt: result.note.createdAt,
            updatedAt: result.note.updatedAt,
          };

          replaceList([summary, ...notesRef.current.filter((n) => n.id !== summary.id)]);
          if (result.created) {
            setTotalNotes((prev) => prev + 1);
            void refreshNotebooks();
          }

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
    [notebookId, notebooks, refreshNotebooks, replaceList],
  );

  const handleNavigateWikiLink = useCallback(
    async (targetTitle: string) => {
      const note = await ensureWikiNoteExists(targetTitle);
      if (note) {
        selectNote(note.id);
      } else {
        notifyError("打开或创建笔记失败，请重试");
      }
    },
    [ensureWikiNoteExists, selectNote],
  );

  const handleCreateAndLinkNote = useCallback(
    async (title: string) => {
      await ensureWikiNoteExists(title);
    },
    [ensureWikiNoteExists],
  );

  const handleNewNote = useCallback(() => { void createNoteHere(); }, [createNoteHere]);
  const handleNewInboxNote = useCallback(() => { void createNoteInInbox(); }, [createNoteInInbox]);
  const handleCreateNotebook = useCallback(() => { createNotebook(); }, [createNotebook]);
  const handleEditNotebook = useCallback((target: Notebook) => setEditingNotebook(target), []);
  const handleDeleteNotebook = useCallback((target: Notebook) => requestConfirm({ eyebrow: "删除笔记本", title: `删除笔记本“${target.name}”？`, description: "笔记本中的笔记会自动移入收件箱，笔记内容不会被删除。", confirmLabel: "删除笔记本", danger: true, onConfirm: () => deleteNotebook(target.id) }), [deleteNotebook, requestConfirm]);
  const handleCollapseSidebar = useCallback(() => {
    const toggle = () => setSidebarCollapsed((value) => !value);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion || typeof document.startViewTransition !== "function") {
      toggle();
      return;
    }
    document.startViewTransition(() => flushSync(toggle));
  }, []);
  const handleSelectListNote = useCallback((id: string, event: ReactMouseEvent<HTMLButtonElement>) => {
    const orderedIds = sortNotes(notesRef.current, noteSort).map((note) => note.id);
    if (isNoteSelectionModifierClick(event)) {
      const nextSelection = applyNoteSelectionClick(noteSelectionRef.current, orderedIds, {
        id,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
      });
      updateNoteSelection(nextSelection);
      return;
    }
    if (noteSelectionRef.current.ids.size > 0) {
      const nextSelection = applyNoteSelectionClick(noteSelectionRef.current, orderedIds, { id, ctrlKey: true });
      updateNoteSelection(nextSelection);
      return;
    }
    selectNote(id);
    setNoteSelectionAnchor(id);
    openMobileNote({ noteId: id });
  }, [openMobileNote, noteSort, selectNote, setNoteSelectionAnchor, updateNoteSelection]);
  const handleOpenCardNote = useCallback((id: string) => {
    selectNote(id);
    setNoteSelectionAnchor(id);
    setCardEditingNoteId(id);
    openMobileNote({ noteId: id });
  }, [openMobileNote, selectNote, setNoteSelectionAnchor]);
  const handleToggleCardSelection = useCallback((id: string, modifiers: Pick<NoteSelectionClick, "metaKey" | "ctrlKey" | "shiftKey">) => {
    const nextSelection = applyNoteSelectionClick(noteSelectionRef.current, sortNotes(notesRef.current, noteSort).map((note) => note.id), {
      id,
      metaKey: modifiers.metaKey,
      ctrlKey: modifiers.ctrlKey,
      shiftKey: modifiers.shiftKey,
    });
    updateNoteSelection(nextSelection);
  }, [noteSort, updateNoteSelection]);
  const handleCardGridScrollPositionChange = useCallback((scope: string, top: number) => {
    cardGridScrollPositionRef.current = { scope, top };
  }, []);
  const handleNoteSort = useCallback((nextSort: NoteSort) => {
    clearNoteSelection();
    setNoteSort(nextSort);
  }, [clearNoteSelection]);
  const handleOpenSidebar = useCallback(() => {
    openMobileHome();
  }, [openMobileHome]);
  const handleOpenList = useCallback(() => {
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
  const handleScrollToOutlineItem = useCallback((id: string) => outlineNavigateRef.current?.(id), []);
  const handleClearQuery = useCallback(() => changeQuery(""), [changeQuery]);
  useEffect(() => {
    if (!ready || !isMobileViewport || isNoteLoading) return;
    const frame = requestAnimationFrame(() => {
      if (document.activeElement?.closest(".mobile-bottom-search")) return;
      const selector = mobilePage === "home" ? "#mobile-notebooks-title" : mobilePage === "list" ? ".mobile-collection-header h2" : ".mobile-editor-title";
      document.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [isMobileViewport, isNoteLoading, mobilePage, mobileViewLayout, ready]);
  useMobileViewport(isMobileViewport && ready);

  const handleWorkspaceContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target === searchRef.current) {
      openWorkspaceMenu(event, textFieldMenuItems(target, changeQuery), "搜索文本");
      return;
    }
    if (!(target instanceof Element) || target.closest("dialog, input, textarea, [contenteditable='true'], .editor-panel")) return;
    const noteId = target.closest<HTMLElement>("[data-note-id]")?.dataset.noteId;
    const targetNote = noteId ? notesRef.current.find((note) => note.id === noteId) : undefined;
    if (targetNote) {
      const busy = pendingTrashCount > 0 || emptyingTrash;
      const items: ContextMenuItem[] = [
        { label: "打开笔记", icon: ArrowUpRight, onSelect: () => { clearNoteSelection(); if (viewLayout === "cards") handleOpenCardNote(targetNote.id); else selectNote(targetNote.id); } },
        { label: selectedNoteIds.has(targetNote.id) ? "从多选中移除" : "加入多选", icon: ListChecks, onSelect: () => handleToggleCardSelection(targetNote.id, { ctrlKey: true }) },
      ];
      if (targetNote.deletedAt) {
        items.push({ label: "恢复笔记", icon: RotateCcw, disabled: busy, onSelect: () => handleNoteSwipeAction(targetNote, "restore") });
        if (selectedNoteIds.has(targetNote.id) && selectedNoteIds.size > 1) items.push({ label: `恢复所选 ${selectedNoteIds.size} 篇笔记`, icon: RotateCcw, disabled: busy, onSelect: restoreSelectedNotes });
      } else {
        items.push({ label: targetNote.isFavorite ? "取消收藏" : "收藏笔记", icon: Star, onSelect: () => handleToggleFavoriteCardNote(targetNote) });
      }
      items.push({ label: targetNote.deletedAt ? "彻底删除" : "移入回收站", icon: Trash2, danger: true, separator: true, disabled: busy, onSelect: () => handleNoteSwipeAction(targetNote, targetNote.deletedAt ? "permanent-delete" : "trash") });
      if (selectedNoteIds.has(targetNote.id) && selectedNoteIds.size > 1) items.push({ label: `${view === "trash" ? "彻底删除" : "移入回收站"}所选 ${selectedNoteIds.size} 篇笔记`, icon: Trash2, danger: true, disabled: busy, onSelect: deleteSelectedNotes });
      openWorkspaceMenu(event, items, targetNote.title || "未命名笔记");
      return;
    }
    const targetNotebookId = target.closest<HTMLElement>("[data-notebook-id]")?.dataset.notebookId;
    const targetNotebook = notebooks.find((notebook) => notebook.id === targetNotebookId);
    if (targetNotebook) {
      openWorkspaceMenu(event, [
        { label: "打开笔记本", icon: ArrowUpRight, onSelect: () => selectNotebook(targetNotebook.id) },
        { label: "在此新建笔记", icon: Plus, onSelect: () => createNoteInNotebook({ notebookId: targetNotebook.id, notebookName: targetNotebook.name, title: "未命名笔记" }) },
        { label: "笔记本设置", icon: Settings2, separator: true, onSelect: () => handleEditNotebook(targetNotebook) },
        ...(!targetNotebook.isSystem ? [{ label: "删除笔记本", icon: Trash2, danger: true, separator: true, onSelect: () => handleDeleteNotebook(targetNotebook) }] : []),
      ], targetNotebook.name);
      return;
    }
    if (target.closest(".sidebar")) {
      const targetView = target.closest<HTMLElement>("[data-note-view]")?.dataset.noteView as NoteView | undefined;
      const items: ContextMenuItem[] = [];
      if (targetView) items.push({ label: `打开${viewLabel(targetView)}`, icon: ArrowUpRight, onSelect: () => selectView(targetView) });
      items.push({ label: "新建笔记", icon: Plus, onSelect: handleNewInboxNote }, { label: "新建笔记本", icon: Plus, onSelect: handleCreateNotebook }, { label: sidebarCollapsed ? "展开侧栏" : "收起侧栏", icon: Settings2, separator: true, onSelect: handleCollapseSidebar });
      openWorkspaceMenu(event, items, "导航");
      return;
    }
    if (target.closest(".note-list-panel, .note-card-grid-panel, .empty-editor")) {
      if (target.closest(".note-outline-panel")) {
        openWorkspaceMenu(event, [{ label: "关闭大纲", icon: X, onSelect: closeOutline }], "笔记大纲");
        return;
      }
      const items: ContextMenuItem[] = [];
      if (view !== "trash") items.push({ label: "新建笔记", icon: Plus, onSelect: handleNewNote });
      items.push({ label: viewLayout === "cards" ? "切换为列表视图" : "切换为卡片视图", icon: viewLayout === "cards" ? List : LayoutGrid, onSelect: toggleViewLayout });
      if (query) items.push({ label: "清空搜索", icon: X, onSelect: handleClearQuery });
      if (selectedNoteIds.size) items.push({ label: "取消多选", icon: X, onSelect: clearNoteSelection });
      if (view === "trash") items.push({ label: "清空回收站", icon: Trash2, danger: true, separator: true, disabled: !totalNotes || pendingTrashCount > 0 || emptyingTrash, onSelect: emptyTrash });
      openWorkspaceMenu(event, items, "笔记工作区");
    }
  };

  if (!ready) return <main className="app-loading"><span className="loading-ring" /><span>正在进入你的空间……</span></main>;
  const currentNotebook = notebookId ? notebooks.find((notebook) => notebook.id === notebookId) : undefined;
  const listNewNote = currentNotebook ? handleNewNote : undefined;
  // 以 selectedNote 为准：纯正文变更只更新 selectedRef，避免每次防抖同步都给 memo(NoteEditor) 新引用。
  // id 变化或尚未同步到 state 时（切换笔记、外部同步、草稿恢复）才回退到 selectedRef。
  const renderedNote = selectedNote && selectedRef.current?.id === selectedNote.id ? selectedNote : selectedRef.current ?? selectedNote;
  const commandNoteReady = Boolean((!isMobileViewport || mobilePage === "editor") && renderedNote && selectedRef.current?.id === renderedNote.id && !isNoteLoading);
  const isCardsLayout = !isMobileViewport && viewLayout === "cards";
  const mobileCards = isMobileViewport && mobileViewLayout === "cards";
  const showCardsGrid = mobileCards || (isCardsLayout && cardEditingNoteId === null);
  const editorContentInert = isMobileViewport && mobilePage !== "editor";
  if (mobilePage === "editor") mobileEditorVisitedRef.current = true;
  const mountEditor = !isMobileViewport || mobileEditorVisitedRef.current;

  return <div onContextMenu={handleWorkspaceContextMenu} onKeyDown={(event) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229 || !(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) return;
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.closest("dialog, input, textarea, [contenteditable='true'], .editor-panel")) return;
    const rect = target.getBoundingClientRect();
    if (!target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: rect.left + 12, clientY: rect.top + 12 }))) event.preventDefault();
  }} data-mobile-page={isMobileViewport ? mobilePage : undefined} className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${focusMode ? "is-focus-mode" : ""} ${isCardsLayout ? "layout-cards" : ""}`}>
    {!isMobileViewport && <Sidebar view={view} setView={selectView} notebooks={notebooks} notebookId={notebookId} setNotebookId={selectNotebook} query={query} setQuery={changeQuery} searchRef={searchRef} onNewInboxNote={handleNewInboxNote} onCreateNotebook={handleCreateNotebook} collapsed={sidebarCollapsed} onCollapse={handleCollapseSidebar} onLogout={logout} />}
    {isMobileViewport && <div className="mobile-home-region" hidden={mobilePage !== "home"} inert={mobilePage !== "home"}><MobileNotebookHome view={view} setView={selectView} notebooks={notebooks} notebookId={notebookId} setNotebookId={selectNotebook} onCreateNotebook={handleCreateNotebook} onEditNotebook={handleEditNotebook} onDeleteNotebook={handleDeleteNotebook} onLogout={logout} active={mobilePage === "home"} /></div>}
    {!isCardsLayout && !mobileCards && (
      <NoteListPanel notes={notes} total={totalNotes} hasMore={hasMoreNotes} sort={noteSort} setSort={handleNoteSort} selectedId={selectedId} selectedIds={selectedNoteIds} onSelect={handleSelectListNote} onDeleteSelected={deleteSelectedNotes} onNoteSwipeAction={handleNoteSwipeAction} view={view} query={query} currentNotebookName={currentNotebook?.name} onEmptyTrash={view === "trash" ? emptyTrash : undefined} trashBusy={pendingTrashCount > 0 || emptyingTrash} onNewNote={listNewNote} onClearQuery={handleClearQuery} isMobileViewport={isMobileViewport} onToggleLayout={toggleViewLayout} onOpenSidebar={handleOpenSidebar} transitionToken={listTransitionToken} outlineOpen={!isMobileViewport && outlineOpen} outlineItems={outlineItems} activeOutlineId={activeOutlineId} onScrollToOutlineItem={handleScrollToOutlineItem} onCloseOutline={closeOutline} onLoadMore={loadMoreNotes} isLoadingMore={isLoadingMore} virtualizationScope={listScope} inert={isMobileViewport && mobilePage !== "list"} />
    )}
    {showCardsGrid && (
      <NoteCardGridPanel
        notes={notes}
        total={totalNotes}
        hasMore={hasMoreNotes}
        sort={noteSort}
        setSort={handleNoteSort}
        isMobileViewport={isMobileViewport}
        onToggleLayout={toggleViewLayout}
        selectedIds={selectedNoteIds}
        onOpenNote={handleOpenCardNote}
        onToggleSelectNote={handleToggleCardSelection}
        onDeleteSelected={deleteSelectedNotes}
        view={view}
        currentNotebookName={currentNotebook?.name}
        query={query}
        onClearQuery={handleClearQuery}
        notebooks={notebooks}
        onToggleFavoriteNote={handleToggleFavoriteCardNote}
        onEmptyTrash={view === "trash" ? emptyTrash : undefined}
        trashBusy={pendingTrashCount > 0 || emptyingTrash}
        transitionToken={listTransitionToken}
        onOpenSidebar={handleOpenSidebar}
        onLoadMore={loadMoreNotes}
        isLoadingMore={isLoadingMore}
        scrollScope={listScope}
        initialScrollTop={cardGridScrollPositionRef.current.scope === listScope ? cardGridScrollPositionRef.current.top : 0}
        onScrollPositionChange={handleCardGridScrollPositionChange}
        inert={isMobileViewport && mobilePage !== "list"}
      />
    )}
    {(!showCardsGrid || isMobileViewport) && (
      <main ref={editorRegionRef} className="editor-region" tabIndex={-1} aria-hidden={editorContentInert || undefined} inert={editorContentInert}>
        {mountEditor && renderedNote ? <Suspense fallback={<NoteLoadingState />}><LazyNoteEditor note={renderedNote} availableNotes={notes} onNavigateWikiLink={handleNavigateWikiLink} onCreateAndLinkNote={handleCreateAndLinkNote} onNavigateToNote={selectNote} searchQuery={activeSearchQuery} onClearSearch={activeSearchQuery ? handleClearSearch : undefined} onMarkdownReaderChange={registerEditorMarkdownReader} onMarkdownDirtyChange={registerEditorMarkdownDirty} saveState={saveState} isLoading={isNoteLoading} trashBusy={emptyingTrash || (pendingTrashCount > 0 && trashOperationsRef.current.has(renderedNote.id))} reloadToken={noteReloadToken} focusRequested={editorFocusNoteId === renderedNote.id && !commandOpen} onFocusHandled={handleEditorFocus} onChange={onNoteChange} onSaveNow={saveNoteNow} onReloadNote={requestConflictReload} onExportImage={handleExportImage} onToggleFavorite={toggleFavorite} onMoveToTrash={moveToTrash} onRestore={restoreFromTrash} onPermanentDelete={permanentDeleteNote} onOpenList={handleOpenList} onOpenCommands={handleOpenCommands} isMobileViewport={isMobileViewport} mobileBackLabel={query ? "搜索结果" : currentNotebook?.name ?? viewLabel(view)} onBackToCards={isCardsLayout ? () => setCardEditingNoteId(null) : undefined} onUploadImage={handleUploadImage} focusMode={focusMode} typewriterMode={typewriterMode} outlineOpen={outlineOpen} outlineItems={outlineItems} activeOutlineId={activeOutlineId} onToggleOutline={toggleOutline} onCloseOutline={closeOutline} onOutlineItemsChange={handleOutlineItemsChange} onOutlineActiveChange={handleOutlineActiveChange} onOutlineNavigationReady={handleOutlineNavigationReady} /></Suspense> : isNoteLoading ? <NoteLoadingState /> : <EmptyEditor isTrash={view === "trash"} onNewNote={handleNewNote} onOpenList={handleOpenList} transitionToken={listTransitionToken} />}
      </main>
    )}
    {isMobileViewport && mobilePage !== "editor" && <MobileBottomBar onOpenCommands={handleOpenCommands} query={query} setQuery={changeQuery} searchRef={searchRef} onNewNote={mobilePage === "home" ? handleNewInboxNote : view === "trash" ? undefined : handleNewNote} />}
    <CommandMenu isMobileViewport={isMobileViewport} open={commandOpen} onClose={closeCommandMenu} onCommand={command} onCreateNoteInNotebook={createNoteInNotebook} canRestore={Boolean(commandNoteReady && renderedNote?.deletedAt)} canMoveToTrash={Boolean(commandNoteReady && renderedNote && !renderedNote.deletedAt)} notebooks={notebooks} currentNotebookId={renderedNote?.notebookId} onMoveNoteToNotebook={(targetNotebookId) => onNoteChange({ notebookId: targetNotebookId })} focusMode={focusMode} typewriterMode={typewriterMode} viewLayout={isMobileViewport ? mobileViewLayout : viewLayout} canInstallApp={pwaState.canInstall} showIosInstallHint={pwaState.showIosInstallHint} standalone={pwaState.standalone} hasSelectedNote={commandNoteReady} onSearchInCurrentNote={handleSearchInCurrentNote} onSearchGlobal={handleSearchGlobal} onFocusGlobalSearch={handleFocusGlobalSearch} initialQuery={commandInitialQuery} themePreference={themePreference} />


    {imageExportSnapshot && <Suspense fallback={null}><LazyImageExportDialog snapshot={imageExportSnapshot} onClose={closeImageExport} /></Suspense>}
    {editingNotebook !== undefined && <NotebookDialog key={editingNotebook?.id ?? "new"} notebook={editingNotebook} onClose={() => setEditingNotebook(undefined)} onSave={saveNotebookDraft} onSaved={saveNotebook} onRequestDelete={(target) => requestConfirm({ eyebrow: "删除笔记本", title: `删除笔记本“${target.name}”？`, description: "笔记本中的笔记会自动移入收件箱，笔记内容不会被删除。", confirmLabel: "删除笔记本", danger: true, onConfirm: () => deleteNotebook(target.id) })} />}
    {confirmRequest && <ConfirmDialog key={confirmRequest.id} request={confirmRequest} onClose={() => setConfirmRequest(null)} />}
    <SystemNotices notice={notice} onDismiss={dismissNotice} onPause={pauseNotice} updateAvailable={pwaState.updateAvailable} onUpdate={() => void updatePwa()} />
    {workspaceMenu}
  </div>;
}
