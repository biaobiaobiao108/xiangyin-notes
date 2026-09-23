import { lazy, memo, Suspense, useCallback, useDeferredValue, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { RefreshCw } from "lucide-react";
import { useNavigate } from "react-router";
import { ApiError, api } from "./api";
import { CommandId, CommandMenu } from "./command-menu";
import type { CreateNoteCommand } from "./command-parser";
import { applyPwaUpdate, installPwa, subscribePwa, type PwaState } from "./pwa";
import type { WorkspaceChangeMessage } from "../shared/realtime";
import type { Note, NoteSummary, NoteView, Notebook } from "../shared/types";
import type { OutlineItem } from "./editor-metrics";
import { ConfirmDialog, NotebookDialog, ShareDialog, type ConfirmRequest } from "./workspace/dialogs";
import { clearAllDraftRecoveries, clearDraftRecovery, readDraftRecovery } from "./workspace/draft-recovery";
import { EmptyEditor, NoteListPanel, NoteLoadingState, Sidebar } from "./workspace/panels";
import { NoteCardGridPanel } from "./workspace/note-card-grid";
import { errorMessage, shouldKeepActiveNoteInList, sortNotes, toNoteDraft, toNoteSummary, type NoteDraft, type NoteSort } from "./workspace/helpers";
import { applyNoteSelectionClick, isNoteSelectionModifierClick, pruneNoteSelection, type NoteSelectionState } from "./workspace/note-list-selection";
import { normalizeLinkTitle } from "../shared/wiki-links";
import { useNoteSaveQueue } from "./workspace/use-note-save-queue";
import { useWorkspaceRealtime } from "./workspace/use-realtime";
import { useWorkspaceShortcuts } from "./workspace/use-workspace-shortcuts";

export type ViewLayout = "three-column" | "cards";

const LazyNoteEditor = lazy(() => import("./editor").then(({ NoteEditor }) => ({ default: memo(NoteEditor) })));
export function Workspace() {
  const navigate = useNavigate();
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
  const toggleViewLayout = useCallback(() => {
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
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [mobileListOpen, setMobileListOpen] = useState(false);
  const toggleOutline = useCallback(() => {
    if (focusMode) return;
    setOutlineOpen((current) => {
      const next = !current;
      if (next) {
        setMobileListOpen(true);
        setMobileSidebarOpen(false);
      }
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
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandInitialQuery, setCommandInitialQuery] = useState("");
  const [inNoteSearchQuery, setInNoteSearchQuery] = useState("");
  const [shareOpen, setShareOpen] = useState(false);
  const [editingNotebook, setEditingNotebook] = useState<Notebook | null | undefined>(undefined);
  const [toast, setToast] = useState("");
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
    saveNoteNow,
    flushPendingSaves,
    hasUnsavedWork,
    clearPendingForNote,
  } = useNoteSaveQueue({
    selectedRef,
    notesRef,
    activeNoteIdRef,
    trashOperationsRef,
    replaceList,
    setSelectedNote,
    setToast,
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
      if (!status.configured) { navigate("/setup", { replace: true }); return; }
      try { await api.me(); if (!disposed) setReady(true); }
      catch { if (!disposed) navigate("/login", { replace: true }); }
    }).catch(() => { if (!disposed) navigate("/login", { replace: true }); });
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
      if (reason instanceof ApiError && reason.status === 401) navigate("/login", { replace: true });
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
      setToast("加载更多笔记失败，请重试");
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
    noteLoadRequestRef.current += 1;

    activeNoteIdRef.current = id;
    selectedRef.current = null;
    setSelectedId(id);
    setIsNoteLoading(Boolean(id));
    if (!id) {
      setSelectedNote(null);
      setCardEditingNoteId(null);
    }
  }, [clearNoteSelection]);
  useEffect(() => {
    setOutlineOpen(false);
    setOutlineItems([]);
    setActiveOutlineId(null);
    outlineNavigateRef.current = null;
  }, [selectedId]);
  useEffect(() => {
    if (focusMode) {
      setOutlineOpen(false);
      setMobileListOpen(false);
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
    const previousNote = selectedRef.current;
    const pendingNote = pendingSavesRef.current.get(id);
    const failedSave = failedSavesRef.current.get(id);
    activeNoteIdRef.current = id;
    selectedRef.current = null;
    setIsNoteLoading(true);
    setSaveState(failedSave ? failedSave instanceof ApiError && failedSave.code === "VERSION_CONFLICT" ? "conflict" : "error" : pendingNote ? "saving" : "idle");
    try {
      const result = await api.getNote(id, { signal: controller.signal });
      if (requestId !== noteLoadRequestRef.current || activeNoteIdRef.current !== id) return;
      if (!pendingSavesRef.current.has(id)) {
        const recoveredDraft = await readDraftRecovery(id);
        if (requestId !== noteLoadRequestRef.current || activeNoteIdRef.current !== id) return;
        if (recoveredDraft?.version === result.note.version) {
          pendingSavesRef.current.set(id, recoveredDraft);
          setToast("已恢复一份未保存草稿");
        } else if (recoveredDraft) {
          clearDraftRecovery(id);
        }
      }
      const latestPendingNote = pendingSavesRef.current.get(id);
      const nextNote = latestPendingNote ? { ...result.note, ...latestPendingNote } : result.note;
      selectedRef.current = nextNote;
      setSelectedNote(nextNote);
      setIsNoteLoading(false);
      // A draft kept from an earlier failure or a note switch is retried instead of staying stuck on "saving".
      const retryDraft = latestPendingNote;
      if (retryDraft && !failedSave && !trashOperationsRef.current.has(id)) persistRef.current(retryDraft);
    } catch (reason) {
      if (requestId !== noteLoadRequestRef.current || activeNoteIdRef.current !== id) return;
      if (reason instanceof Error && reason.name === "AbortError") return;
      setIsNoteLoading(false);
      if (reason instanceof ApiError && reason.status === 401) {
        navigate("/login", { replace: true });
        return;
      }
      if (previousNote) {
        activeNoteIdRef.current = previousNote.id;
        selectedRef.current = previousNote;
        setSelectedId(previousNote.id);
        setSelectedNote(previousNote);
      } else {
        activeNoteIdRef.current = null;
        selectedRef.current = null;
        setSelectedId(null);
        setSelectedNote(null);
      }
      setToast("无法打开这篇笔记");
    } finally {
      if (noteAbortRef.current === controller) noteAbortRef.current = null;
    }
  }, [navigate]);
  useEffect(() => {
    if (!ready || !selectedId) {
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
  useWorkspaceShortcuts({
    focusMode,
    hasModalOpen: Boolean(commandOpen || shareOpen || editingNotebook !== undefined || confirmRequest),
    toggleSidebar: () => setSidebarCollapsed((value) => !value),
    toggleFocusMode,
    toggleTypewriterMode,
    exitFocusMode,
    openCommandMenu: (initialQuery = "") => {
      setCommandInitialQuery(initialQuery);
      setCommandOpen(true);
    },
    toggleViewLayout,
    isCardEditing: viewLayout === "cards" && cardEditingNoteId !== null,
    onExitCardEditing: () => setCardEditingNoteId(null),
    hasSelection: selectedNoteIds.size > 0,
    clearSelection: clearNoteSelection,
    outlineOpen,
    closeOutline,
  });
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(""), 3000); return () => clearTimeout(timer); }, [toast]);


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
        setMobileSidebarOpen(false);
        setMobileListOpen(false);
      }
      void saveImmediately(next, false, ["notebookId"]).then(() => {
        refreshNotebooks();
        reloadNotes();
      }).catch(() => {
        refreshNotebooks();
        reloadNotes();
      });
      setToast(targetNotebook ? `已移至“${targetNotebook.name}”` : "已变更所属笔记本");
    } else {
      persist(next, Object.keys(patch) as Array<"title" | "contentMarkdown" | "notebookId">);
    }
  }, [invalidateCollections, notebooks, persist, refreshNotebooks, reloadNotes, replaceList, requestListTransition, saveImmediately]);
  const revealCreatedNote = useCallback((note: Note, target: { view: NoteView; notebookId?: string }, message: string) => {
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
    setMobileSidebarOpen(false);
    setMobileListOpen(false);
    setToast(message);
  }, [playListTransition]);
  const createNoteHere = useCallback(async () => {
    const currentNotebook = notebookId ? notebooks.find((notebook) => notebook.id === notebookId) : undefined;
    const inbox = notebooks.find((notebook) => notebook.isSystem);
    const staysInView = Boolean(currentNotebook) || view === "all" || view === "inbox";
    try {
      const result = await api.createNote(currentNotebook ? { notebookId: currentNotebook.id } : { notebookId: inbox?.id });
      revealCreatedNote(result.note, { view: currentNotebook || !staysInView ? "all" : view, notebookId: currentNotebook?.id }, currentNotebook ? `已在“${currentNotebook.name}”中创建新笔记` : "已在收件箱中创建新笔记");
      void refreshNotebooks();
    } catch (reason) { setToast(errorMessage(reason, "创建笔记失败")); }
  }, [notebookId, notebooks, refreshNotebooks, revealCreatedNote, view]);
  const createNoteInInbox = useCallback(async () => {
    if (inboxNoteCreationRef.current) return;
    const inbox = notebooks.find((notebook) => notebook.isSystem);
    inboxNoteCreationRef.current = true;
    try {
      const result = await api.createNote(inbox ? { notebookId: inbox.id } : {});
      revealCreatedNote(result.note, { view: "inbox", notebookId: result.note.notebookId }, "已在收件箱中创建新笔记");
      void refreshNotebooks();
    } catch (reason) {
      setToast(errorMessage(reason, "创建笔记失败"));
    } finally {
      inboxNoteCreationRef.current = false;
    }
  }, [notebooks, refreshNotebooks, revealCreatedNote]);
  const createNoteInNotebook = useCallback(async (commandToCreate: CreateNoteCommand) => {
    try {
      const result = await api.createNote({ notebookId: commandToCreate.notebookId, title: commandToCreate.title });
      revealCreatedNote(result.note, { view: "all", notebookId: commandToCreate.notebookId }, `已在“${commandToCreate.notebookName}”中创建“${commandToCreate.title}”`);
      void refreshNotebooks();
    } catch (reason) { if (reason instanceof ApiError && reason.status === 401) navigate("/login", { replace: true }); setToast(errorMessage(reason, "创建笔记失败，请稍后重试")); }
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
      setToast(`已更新笔记本“${saved.name}”`);
    } else {
      setNotebookId(saved.id);
      setView("all");
      setMobileSidebarOpen(false);
      setToast(`已创建笔记本“${saved.name}”`);
    }
    setEditingNotebook(undefined);
  }, [editingNotebook]);
  const saveNotebookDraft = useCallback(async (draft: { name: string; color: string; icon: string }) => {
    const existing = editingNotebook ?? undefined;
    const timestamp = Math.floor(Date.now() / 1000);
    const notebook: Notebook = existing
      ? { ...existing, name: draft.name, color: draft.color, icon: draft.icon }
      : { id: crypto.randomUUID(), name: draft.name, color: draft.color, icon: draft.icon, isSystem: false, count: 0, updatedAt: timestamp };
    const result = existing
      ? await api.updateNotebook(notebook.id, { name: notebook.name, color: notebook.color, icon: notebook.icon })
      : await api.createNotebook({ name: notebook.name, color: notebook.color, icon: notebook.icon });
    return result.notebook;
  }, [editingNotebook]);
  const deleteNotebook = useCallback(async (id: string) => {
    try {
      const target = notebooks.find((notebook) => notebook.id === id);
      const inbox = notebooks.find((notebook) => notebook.isSystem);
      if (!target || !inbox) throw new Error("notebook-not-found");
      await api.deleteNotebook(target.id);
      setNotebooks((current) => current.filter((nb) => nb.id !== id));
      if (notebookId === id) setNotebookId(undefined);
      refreshNotebooks();
      void loadNotes();
      setToast("已删除笔记本，原笔记已归入收件箱");
      setEditingNotebook(undefined);
    } catch (reason) {
      setToast(errorMessage(reason, "删除笔记本失败"));
    }
  }, [loadNotes, notebookId, notebooks, refreshNotebooks]);
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
      setToast(deleted ? "已移入回收站" : "已恢复笔记");
    } catch (reason) {
      pendingSavesRef.current.set(current.id, toNoteDraft(current));
      setNotebooks((items) => items.map((notebook) => notebook.id === current.notebookId ? { ...notebook, count: Math.max(0, notebook.count + (deleted ? 1 : -1)) } : notebook));
      setToast(reason instanceof ApiError && reason.code === "VERSION_CONFLICT" ? "这篇笔记已在别处更新，操作未完成，本地草稿已保留" : errorMessage(reason, deleted ? "移入回收站失败，请重试" : "恢复笔记失败，请重试"));
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
      setToast(permanent ? `已彻底删除 ${result.deletedIds.length} 篇笔记` : `已移入回收站 ${result.deletedIds.length} 篇笔记`);
    } finally {
      ids.forEach((id) => trashOperationsRef.current.delete(id));
      setPendingTrashCount(trashOperationsRef.current.size);
      invalidateCollections();
      void refreshNotebooks();
      reloadNotes();
    }
  }, [discardNoteDraft, getBatchEntries, invalidateCollections, refreshNotebooks, reloadNotes, removeManyFromList, runSave]);
  const showBatchDeleteError = useCallback((reason: unknown) => {
    setToast(reason instanceof ApiError && reason.code === "BATCH_VERSION_CONFLICT" ? "选中的笔记已发生变化，请重新选择后重试" : errorMessage(reason, "批量删除失败，请重试"));
  }, []);
  const deleteSelectedNotes = useCallback(() => {
    const ids = [...noteSelectionRef.current.ids];
    if (!ids.length || pendingTrashCount > 0 || emptyingTrashRef.current) return;
    if (view === "trash") {
      requestConfirm({
        eyebrow: "不可撤销",
        title: `彻底删除 ${ids.length} 篇笔记？`,
        description: "这些笔记会从数据库永久移除，回收站不再保留，相关分享链接也会同时失效。",
        confirmLabel: "彻底删除",
        danger: true,
        onConfirm: () => performBatchDelete(ids, true),
      });
      return;
    }
    void performBatchDelete(ids, false).catch(showBatchDeleteError);
  }, [emptyingTrashRef, pendingTrashCount, performBatchDelete, requestConfirm, showBatchDeleteError, view]);
  const performPermanentDelete = useCallback(async (noteId: string) => {
    if (trashOperationsRef.current.has(noteId) || emptyingTrashRef.current) throw new ApiError(409, "TRASH_BUSY", "回收站正在处理其他操作，请稍后重试");
    trashOperationsRef.current.add(noteId);
    setPendingTrashCount(trashOperationsRef.current.size);
    invalidateCollections();
    try {
      await runSave(noteId);
      await api.deleteNote(noteId);
      removeFromList(noteId);
      discardNoteDraft(noteId);
      setToast("已彻底删除笔记");
    } finally { finishTrashOperation(noteId); }
  }, [discardNoteDraft, finishTrashOperation, invalidateCollections, removeFromList, runSave]);
  const permanentDeleteNote = useCallback(async () => {
    const current = selectedRef.current;
    if (!current) return;
    requestConfirm({
      eyebrow: "不可撤销",
      title: `彻底删除“${current.title.trim() || "未命名笔记"}”？`,
      description: "这篇笔记会从数据库中永久移除，回收站不再保留，已生成的分享链接也会同时失效。",
      confirmLabel: "彻底删除",
      danger: true,
      onConfirm: () => performPermanentDelete(current.id),
    });
  }, [performPermanentDelete, requestConfirm]);
  const performEmptyTrash = useCallback(async () => {
    if (emptyingTrashRef.current || trashOperationsRef.current.size) throw new ApiError(409, "TRASH_BUSY", "回收站正在处理其他操作，请稍后重试");
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
      setToast(`回收站已清空，已彻底删除 ${result.deletedCount} 篇笔记`);
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
      description: `将永久删除回收站中的全部笔记（当前共 ${totalNotes} 篇），包括列表尚未显示的笔记。删除后无法恢复，相关分享链接也会同时失效。`,
      confirmLabel: "清空回收站",
      danger: true,
      onConfirm: performEmptyTrash,
    });
  }, [pendingTrashCount, performEmptyTrash, requestConfirm, totalNotes]);

  const handleMoveSelectedToNotebook = useCallback(async (targetNotebookId: string) => {
    const ids = [...noteSelectionRef.current.ids];
    if (!ids.length) return;
    const targetNotebook = notebooks.find((nb) => nb.id === targetNotebookId);
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
      setToast(`已将 ${ids.length} 篇笔记移动到“${targetNotebook?.name ?? "笔记本"}”`);
    } catch (reason) {
      setToast(errorMessage(reason, "移动笔记失败"));
    }
  }, [clearNoteSelection, loadNotes, notebooks, refreshNotebooks, setToast]);

  const handleToggleFavoriteCardNote = useCallback(async (target: NoteSummary) => {
    const isFavorite = !target.isFavorite;
    try {
      const result = await api.updateNote(target.id, { version: target.version, isFavorite }, { response: "summary" });
      const patch = {
        isFavorite: result.note.isFavorite,
        version: result.note.version,
        updatedAt: result.note.updatedAt,
      };
      replaceList(notesRef.current.map((note) => note.id === target.id ? { ...note, ...patch } : note));
      if (selectedRef.current?.id === target.id) {
        const selected = { ...selectedRef.current, ...patch };
        selectedRef.current = selected;
        setSelectedNote(selected);
      }
      if (view === "favorites" && !patch.isFavorite) removeFromList(target.id);
      setToast(patch.isFavorite ? "已加入收藏" : "已取消收藏");
    } catch (reason) {
      setToast(errorMessage(reason, "操作失败"));
    }
  }, [removeFromList, replaceList, setToast, view]);

  const handleMoveCardNoteToTrash = useCallback(async (target: NoteSummary) => {
    try {
      await api.moveNotesToTrash([{ id: target.id, version: target.version }]);
      clearPendingForNote(target.id);
      removeFromList(target.id);
      setToast("已移入回收站");
    } catch (reason) {
      setToast(errorMessage(reason, "移入回收站失败"));
    }
  }, [clearPendingForNote, removeFromList, setToast]);

  const handleRestoreCardNote = useCallback(async (target: NoteSummary) => {
    try {
      await api.updateNote(target.id, { version: target.version, deleted: false }, { response: "summary" });
      clearPendingForNote(target.id);
      removeFromList(target.id);
      setToast("已从回收站恢复");
    } catch (reason) {
      setToast(errorMessage(reason, "恢复笔记失败"));
    }
  }, [clearPendingForNote, removeFromList, setToast]);

  const handlePermanentDeleteCardNote = useCallback((target: NoteSummary) => {
    requestConfirm({
      eyebrow: "不可撤销",
      title: `彻底删除“${target.title.trim() || "未命名笔记"}”？`,
      description: "这篇笔记会从数据库中永久移除，回收站不再保留，已生成的分享链接也会同时失效。",
      confirmLabel: "彻底删除",
      danger: true,
      onConfirm: async () => {
        try {
          await api.deleteNotes([{ id: target.id, version: target.version }]);
          clearPendingForNote(target.id);
          removeFromList(target.id);
          setToast("已彻底删除笔记");
        } catch (reason) {
          setToast(errorMessage(reason, "删除笔记失败"));
        }
      },
    });
  }, [clearPendingForNote, removeFromList, requestConfirm, setToast]);
  const reloadSelectedNote = useCallback(async () => {
    const current = selectedRef.current;
    if (!current) return;
    clearPendingForNote(current.id);
    setIsNoteLoading(true);
    try {
      const result = await api.getNote(current.id);
      if (selectedRef.current?.id !== result.note.id) return;
      selectedRef.current = result.note;
      setSelectedNote(result.note);
      setNoteReloadToken((value) => value + 1);
      setSaveState("idle");
      setToast("已重新载入最新版本");
    } catch {
      setToast("重新载入失败，请重试");
    } finally {
      setIsNoteLoading(false);
    }
  }, [clearPendingForNote, setSaveState]);
  const refreshSelectedNoteFromRemote = useCallback(async (noteId: string) => {
    const current = selectedRef.current;
    if (!current || current.id !== noteId) return;

    noteAbortRef.current?.abort();
    const controller = new AbortController();
    noteAbortRef.current = controller;
    const requestId = ++noteLoadRequestRef.current;
    try {
      const result = await api.getNote(noteId, { signal: controller.signal });
      if (requestId !== noteLoadRequestRef.current || activeNoteIdRef.current !== noteId || selectedRef.current?.id !== noteId) return;
      if (result.note.version === current.version) return;

      if (pendingSavesRef.current.has(noteId) || failedSavesRef.current.has(noteId)) {
        setSaveState("conflict");
        setToast("当前笔记已在其他设备更新，请先保存或重新载入");
        return;
      }
      selectedRef.current = result.note;
      setSelectedNote(result.note);
      replaceList(notesRef.current.map((n) => (n.id === noteId ? { ...n, ...toNoteSummary(result.note) } : n)));
      setNoteReloadToken((value) => value + 1);
      setSaveState("idle");
    } catch (reason) {
      if (reason instanceof Error && reason.name === "AbortError") return;
      if (reason instanceof ApiError && reason.status === 401) {
        navigate("/login", { replace: true });
        return;
      }
      if (reason instanceof ApiError && reason.status === 404 && activeNoteIdRef.current === noteId) {
        removeFromList(noteId);
        return;
      }
      setToast("同步当前笔记失败，请稍后重试");
    } finally {
      if (noteAbortRef.current === controller) noteAbortRef.current = null;
    }
  }, [failedSavesRef, navigate, pendingSavesRef, removeFromList, replaceList, setSaveState]);
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
    if (!message || resource === "notes" || resource === "notebooks" || (resource === "shares" && view === "shared")) pending.notes = true;
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
    setMobileSidebarOpen(false);
    setMobileListOpen(false);
  }, [notebookId, query, requestListTransition, view]);
  const selectNotebook = useCallback((notebookIdToSelect: string) => {
    if (notebookId !== notebookIdToSelect || view !== "all" || query) requestListTransition();
    searchOriginRef.current = null;
    setQuery("");
    setNotebookId(notebookIdToSelect);
    setView("all");
    setCardEditingNoteId(null);
    setMobileSidebarOpen(false);
    setMobileListOpen(false);
  }, [notebookId, query, requestListTransition, view]);
  const changeQuery = useCallback((next: string) => {
    if (next) {
      if (!query) {
        requestListTransition();
        searchOriginRef.current = { view, notebookId };
      }
      setQuery(next);
      setView("all");
      setNotebookId(undefined);
      return;
    }
    if (query) requestListTransition();
    const origin = searchOriginRef.current;
    searchOriginRef.current = null;
    setQuery("");
    setView(origin?.view ?? "all");
    setNotebookId(origin?.notebookId);
  }, [notebookId, query, requestListTransition, view]);
  const closeCommandMenu = useCallback(() => {
    setCommandOpen(false);
    setCommandInitialQuery("");
  }, []);
  const handleSearchInCurrentNote = useCallback((term: string) => {
    const normalized = term.trim();
    if (!normalized) return;
    if (!selectedRef.current) {
      setToast("当前未打开笔记，无法在单篇笔记内查找");
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
    setMobileSidebarOpen(true);
    setMobileListOpen(false);
    closeCommandMenu();
  }, [changeQuery, closeCommandMenu]);
  const handleFocusGlobalSearch = useCallback(() => {
    setSidebarCollapsed(false);
    setCardEditingNoteId(null);
    setMobileSidebarOpen(true);
    setMobileListOpen(false);
    closeCommandMenu();
    requestAnimationFrame(() => {
      searchRef.current?.focus();
      searchRef.current?.select();
    });
  }, [closeCommandMenu]);
  const handleClearSearch = useCallback(() => {
    setInNoteSearchQuery("");
    if (query) {
      changeQuery("");
    }
  }, [changeQuery, query]);
  const handleExportNotes = useCallback(async () => {
    setToast("正在生成笔记压缩包……");
    try {
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
      setToast("笔记压缩包已下载");
    } catch {
      setToast("导出失败，请检查网络后重试");
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
    if (id === "toggle-sidebar") setSidebarCollapsed((value) => !value);
    if (id === "toggle-view-layout") toggleViewLayout();
    if (id === "toggle-focus-mode") toggleFocusMode();
    if (id === "toggle-typewriter-mode") toggleTypewriterMode();
    if (id === "share" && selectedRef.current) setShareOpen(true);
    if (id === "favorite") toggleFavorite();
    if (id === "trash") moveToTrash();
    if (id === "restore") restoreFromTrash();
    if (id === "export-notes") void handleExportNotes();
    if (id === "install-app") { if (pwaState.canInstall) void installPwa(); else if (pwaState.showIosInstallHint && !pwaState.standalone) setToast("请在 Safari 中点击分享，再选择“添加到主屏幕”"); }
  }, [createNoteInInbox, handleExportNotes, moveToTrash, pwaState, restoreFromTrash, toggleFavorite, toggleFocusMode, toggleTypewriterMode, toggleViewLayout]);
  useEffect(() => {
    if (!ready || shortcutHandledRef.current) return;
    const action = new URLSearchParams(window.location.search).get("action");
    if (action === "new-note") void createNoteInInbox();
    if (action === "search") { setMobileSidebarOpen(true); setMobileListOpen(false); requestAnimationFrame(() => searchRef.current?.focus()); }
    shortcutHandledRef.current = true;
    if (action) window.history.replaceState(null, "", `${window.location.pathname}${window.location.hash}`);
  }, [createNoteInInbox, ready]);
  const logout = useCallback(async () => {
    await flushPendingSaves("now");
    if (hasUnsavedWork()) {
      setToast("仍有内容未保存，请稍后再退出");
      return;
    }
    await api.logout().catch(() => undefined);
    clearAllDraftRecoveries();
    navigate("/login", { replace: true });
  }, [flushPendingSaves, navigate]);
  const updatePwa = useCallback(async () => {
    await flushPendingSaves("now");
    if (hasUnsavedWork()) { setToast("仍有编辑内容未保存，更新已暂缓"); return; }
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
        setToast("打开或创建笔记失败，请重试");
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
  const handleCollapseSidebar = useCallback(() => setSidebarCollapsed((value) => !value), []);
  const handleSelectListNote = useCallback((id: string, event: ReactMouseEvent<HTMLButtonElement>) => {
    const nextSelection = applyNoteSelectionClick(noteSelectionRef.current, sortNotes(notesRef.current, noteSort).map((note) => note.id), {
      id,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
    });
    const isModifierSelection = isNoteSelectionModifierClick(event);
    if (!isModifierSelection) selectNote(id);
    updateNoteSelection(nextSelection);
    if (isModifierSelection) return;
    setMobileSidebarOpen(false);
    setMobileListOpen(false);
  }, [noteSort, selectNote, updateNoteSelection]);
  const handleOpenCardNote = useCallback((id: string) => {
    selectNote(id);
    setCardEditingNoteId(id);
  }, [selectNote]);
  const handleToggleCardSelection = useCallback((id: string, event: ReactMouseEvent) => {
    const nextSelection = applyNoteSelectionClick(noteSelectionRef.current, sortNotes(notesRef.current, noteSort).map((note) => note.id), {
      id,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
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
    setMobileSidebarOpen(true);
    setMobileListOpen(false);
  }, []);
  const handleOpenList = useCallback(() => {
    setMobileListOpen(true);
    setMobileSidebarOpen(false);
  }, []);
  const handleShare = useCallback(() => setShareOpen(true), []);
  const handleUploadImage = useCallback((file: File) => api.uploadAsset(file), []);
  const handleScrollToOutlineItem = useCallback((id: string) => outlineNavigateRef.current?.(id), []);
  const handleClearQuery = useCallback(() => changeQuery(""), [changeQuery]);

  if (!ready) return <main className="app-loading"><span className="loading-ring" /><span>正在进入你的空间……</span></main>;
  const currentNotebook = notebookId ? notebooks.find((notebook) => notebook.id === notebookId) : undefined;
  const listNewNote = currentNotebook ? handleNewNote : undefined;
  const renderedNote = selectedNote && selectedRef.current?.id === selectedNote.id ? selectedRef.current : selectedNote;
  const commandNoteReady = Boolean(renderedNote && selectedRef.current?.id === renderedNote.id && !isNoteLoading);
  const activeSearchQuery = inNoteSearchQuery || query;
  const mobileNavigationOpen = mobileSidebarOpen || mobileListOpen;
  const isCardsLayout = viewLayout === "cards";
  const showCardsGrid = isCardsLayout && cardEditingNoteId === null;

  return <div className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${focusMode ? "is-focus-mode" : ""} ${isCardsLayout ? "layout-cards" : ""}`}>
    {mobileNavigationOpen && <button className="mobile-scrim is-visible" type="button" aria-label="关闭导航" onClick={() => { setMobileSidebarOpen(false); setMobileListOpen(false); closeOutline(); }} />}
    <Sidebar view={view} setView={selectView} notebooks={notebooks} notebookId={notebookId} setNotebookId={selectNotebook} query={query} setQuery={changeQuery} searchRef={searchRef} onNewInboxNote={handleNewInboxNote} onCreateNotebook={handleCreateNotebook} onEditNotebook={handleEditNotebook} collapsed={sidebarCollapsed} onCollapse={handleCollapseSidebar} mobileOpen={mobileSidebarOpen} onLogout={logout} />
    {!isCardsLayout && (
      <NoteListPanel notes={notes} total={totalNotes} hasMore={hasMoreNotes} sort={noteSort} setSort={handleNoteSort} selectedId={selectedId} selectedIds={selectedNoteIds} onSelect={handleSelectListNote} onDeleteSelected={deleteSelectedNotes} view={view} query={query} currentNotebookName={currentNotebook?.name} onEmptyTrash={view === "trash" ? emptyTrash : undefined} trashBusy={pendingTrashCount > 0 || emptyingTrash} onNewNote={listNewNote} onClearQuery={handleClearQuery} mobileOpen={mobileListOpen} onOpenSidebar={handleOpenSidebar} transitionToken={listTransitionToken} outlineOpen={outlineOpen} outlineItems={outlineItems} activeOutlineId={activeOutlineId} onScrollToOutlineItem={handleScrollToOutlineItem} onCloseOutline={closeOutline} onLoadMore={loadMoreNotes} isLoadingMore={isLoadingMore} />
    )}
    {showCardsGrid ? (
      <NoteCardGridPanel
        notes={notes}
        total={totalNotes}
        hasMore={hasMoreNotes}
        sort={noteSort}
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
      />
    ) : (
      <main className="editor-region">
        {renderedNote ? <Suspense fallback={<NoteLoadingState />}><LazyNoteEditor note={renderedNote} availableNotes={notes} onNavigateWikiLink={handleNavigateWikiLink} onCreateAndLinkNote={handleCreateAndLinkNote} onNavigateToNote={selectNote} searchQuery={activeSearchQuery} onClearSearch={activeSearchQuery ? handleClearSearch : undefined} onToast={setToast} saveState={saveState} isLoading={isNoteLoading} trashBusy={emptyingTrash || (pendingTrashCount > 0 && trashOperationsRef.current.has(renderedNote.id))} reloadToken={noteReloadToken} focusRequested={editorFocusNoteId === renderedNote.id && !commandOpen} onFocusHandled={handleEditorFocus} onChange={onNoteChange} onSaveNow={saveNoteNow} onReloadNote={requestConflictReload} onShare={handleShare} onToggleFavorite={toggleFavorite} onMoveToTrash={moveToTrash} onRestore={restoreFromTrash} onPermanentDelete={permanentDeleteNote} onOpenList={handleOpenList} onBackToCards={isCardsLayout ? () => setCardEditingNoteId(null) : undefined} onUploadImage={handleUploadImage} focusMode={focusMode} onToggleFocusMode={toggleFocusMode} typewriterMode={typewriterMode} outlineOpen={outlineOpen} outlineItems={outlineItems} activeOutlineId={activeOutlineId} onToggleOutline={toggleOutline} onCloseOutline={closeOutline} onOutlineItemsChange={handleOutlineItemsChange} onOutlineActiveChange={handleOutlineActiveChange} onOutlineNavigationReady={handleOutlineNavigationReady} /></Suspense> : isNoteLoading ? <NoteLoadingState /> : <EmptyEditor isTrash={view === "trash"} onNewNote={handleNewNote} onOpenList={handleOpenList} transitionToken={listTransitionToken} />}
      </main>
    )}
    <CommandMenu open={commandOpen} onClose={closeCommandMenu} onCommand={command} onCreateNoteInNotebook={createNoteInNotebook} canRestore={Boolean(commandNoteReady && renderedNote?.deletedAt)} canMoveToTrash={Boolean(commandNoteReady && renderedNote && !renderedNote.deletedAt)} notebooks={notebooks} currentNotebookId={renderedNote?.notebookId} onMoveNoteToNotebook={(targetNotebookId) => onNoteChange({ notebookId: targetNotebookId })} focusMode={focusMode} typewriterMode={typewriterMode} viewLayout={viewLayout} canInstallApp={pwaState.canInstall} showIosInstallHint={pwaState.showIosInstallHint} standalone={pwaState.standalone} hasSelectedNote={commandNoteReady} onSearchInCurrentNote={handleSearchInCurrentNote} onSearchGlobal={handleSearchGlobal} onFocusGlobalSearch={handleFocusGlobalSearch} initialQuery={commandInitialQuery} />


    {shareOpen && renderedNote && <ShareDialog note={renderedNote} onClose={() => setShareOpen(false)} onToast={setToast} />}
    {editingNotebook !== undefined && <NotebookDialog key={editingNotebook?.id ?? "new"} notebook={editingNotebook} onClose={() => setEditingNotebook(undefined)} onSave={saveNotebookDraft} onSaved={saveNotebook} onRequestDelete={(target) => requestConfirm({ eyebrow: "整理上下文", title: `删除笔记本“${target.name}”？`, description: "笔记本中的笔记会自动移入收件箱，笔记内容不会被删除。", confirmLabel: "删除笔记本", danger: true, onConfirm: () => void deleteNotebook(target.id) })} onToast={setToast} />}
    {confirmRequest && <ConfirmDialog key={confirmRequest.id} request={confirmRequest} onClose={() => setConfirmRequest(null)} />}
    <div className="system-notices">{pwaState.updateAvailable && <div className="update-notice" role="status" aria-live="polite" aria-labelledby="update-notice-title"><div className="update-notice-header"><RefreshCw size={18} aria-hidden="true" /><div><strong id="update-notice-title">发现新版本</strong><p>保存当前编辑后即可更新应用。</p></div></div><div className="update-notice-actions"><button className="text-button update-notice-action" type="button" onClick={() => void updatePwa()}>更新</button></div></div>}{toast && <div className="toast" role="status">{toast}</div>}</div>
  </div>;
}
