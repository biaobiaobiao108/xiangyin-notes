import { lazy, Suspense, useCallback, useDeferredValue, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { ApiError, api } from "./api";
import { CommandId, CommandMenu } from "./command-menu";
import type { CreateNoteCommand } from "./command-parser";
import { offlineSync, type OfflineSyncState } from "./offline-sync";
import { getOfflineConflicts, type OfflineConflict } from "./offline-store";
import { applyPwaUpdate, installPwa, subscribePwa, type PwaState } from "./pwa";
import type { Note, NoteSummary, NoteView, Notebook } from "../shared/types";
import { ConfirmDialog, ConflictDialog, NotebookDialog, ShareDialog, type ConfirmRequest } from "./workspace/dialogs";
import { EmptyEditor, NoteListPanel, NoteLoadingState, Sidebar, SyncNotice } from "./workspace/panels";
import { filterOfflineNotes, errorMessage, sortNotes, toNoteDraft, type NoteDraft, type NoteSort } from "./workspace/helpers";

const LazyNoteEditor = lazy(() => import("./editor").then(({ NoteEditor }) => ({ default: NoteEditor })));
export function Workspace() {
  const navigate = useNavigate();
  const [view, setView] = useState<NoteView>("all");
  const [notebookId, setNotebookId] = useState<string>();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [noteSort, setNoteSort] = useState<NoteSort>("updated");
  const [totalNotes, setTotalNotes] = useState(0);
  const [notesReloadToken, setNotesReloadToken] = useState(0);
  const notesRef = useRef<NoteSummary[]>([]);
  const listRequestRef = useRef(0);
  const notebooksRequestRef = useRef(0);
  const trashOperationsRef = useRef(new Set<string>());
  const [pendingTrashCount, setPendingTrashCount] = useState(0);
  const emptyingTrashRef = useRef(false);
  const [emptyingTrash, setEmptyingTrash] = useState(false);
  const listScope = JSON.stringify([view, notebookId, query, deferredQuery]);
  const listScopeRef = useRef(listScope);
  listScopeRef.current = listScope;
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedNote, setSelectedNote] = useState<Note | null>(null);
  const [editorFocusNoteId, setEditorFocusNoteId] = useState<string | null>(null);
  const handleEditorFocus = useCallback(() => setEditorFocusNoteId(null), []);
  const selectedRef = useRef<Note | null>(null);
  const activeNoteIdRef = useRef<string | null>(null);
  const noteLoadRequestRef = useRef(0);
  const saveTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const pendingSavesRef = useRef(new Map<string, NoteDraft>());
  const inFlightSavesRef = useRef(new Map<string, Promise<void>>());
  const failedSavesRef = useRef(new Map<string, unknown>());
  const searchRef = useRef<HTMLInputElement>(null);
  const searchOriginRef = useRef<{ view: NoteView; notebookId?: string } | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "local" | "conflict" | "error">("idle");
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
  const exitFocusMode = useCallback(() => {
    setFocusMode(false);
    try {
      localStorage.setItem("xiangying_focus_mode", "false");
    } catch {}
  }, []);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [mobileListOpen, setMobileListOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandInitialQuery, setCommandInitialQuery] = useState("");
  const [inNoteSearchQuery, setInNoteSearchQuery] = useState("");
  const [commandNoteQuery, setCommandNoteQuery] = useState("");
  const [commandNoteResults, setCommandNoteResults] = useState<NoteSummary[]>([]);
  const [commandNoteSearchLoading, setCommandNoteSearchLoading] = useState(false);

  const commandNoteRequestRef = useRef(0);
  const [shareOpen, setShareOpen] = useState(false);
  const [editingNotebook, setEditingNotebook] = useState<Notebook | null | undefined>(undefined);
  const [toast, setToast] = useState("");
  const [ready, setReady] = useState(false);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const [noteReloadToken, setNoteReloadToken] = useState(0);
  const [syncState, setSyncState] = useState<OfflineSyncState>(offlineSync.getState());
  const [pwaState, setPwaState] = useState<PwaState>({ standalone: false, canInstall: false, showIosInstallHint: false, updateAvailable: false });
  const [conflicts, setConflicts] = useState<OfflineConflict[]>([]);
  const [conflictOpen, setConflictOpen] = useState(false);
  const shortcutHandledRef = useRef(false);
  const confirmIdRef = useRef(0);
  const hasUnsavedWork = useCallback(() => pendingSavesRef.current.size > 0 || failedSavesRef.current.size > 0 || offlineSync.getState().pendingCount > 0 || offlineSync.getState().conflictCount > 0, []);
  const requestConfirm = useCallback((request: Omit<ConfirmRequest, "id">) => {
    confirmIdRef.current += 1;
    setConfirmRequest({ ...request, id: confirmIdRef.current, returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null });
  }, []);

  useEffect(() => subscribePwa(setPwaState), []);
  useEffect(() => offlineSync.subscribe(setSyncState), []);
  useEffect(() => {
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedWork()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [hasUnsavedWork]);
  useEffect(() => { if (syncState.conflictCount > 0) void getOfflineConflicts().then(setConflicts); }, [syncState.conflictCount]);
  useEffect(() => {
    let disposed = false;
    const enter = async (user: { id: string; username: string }) => {
      const local = await offlineSync.activate(user);
      if (disposed) return;
      if (local.notebooks.length) setNotebooks(local.notebooks);
      if (local.notes.length) {
        const localNotes = filterOfflineNotes(local.notes, local.notebooks, view, query, notebookId);
        notesRef.current = localNotes;
        setNotes(localNotes);
        setTotalNotes(localNotes.length);
        setSelectedId((current) => current && localNotes.some((note) => note.id === current) ? current : localNotes[0]?.id ?? null);
      }
      setReady(true);
    };
    const enterLocalIfAvailable = async () => {
      const localUser = await offlineSync.getLocalUser();
      if (localUser) await enter(localUser);
      else if (!disposed) navigate("/login", { replace: true });
    };
    void api.bootstrap().then(async (status) => {
      if (!status.configured) { navigate("/setup", { replace: true }); return; }
      try { const result = await api.me(); await enter(result.user); }
      catch { await enterLocalIfAvailable(); }
    }).catch(() => { void enterLocalIfAvailable(); });
    return () => { disposed = true; };
  }, [navigate]);

  const replaceList = useCallback((next: NoteSummary[]) => { notesRef.current = next; setNotes(next); }, []);
  const invalidateCollections = useCallback(() => { listRequestRef.current += 1; notebooksRequestRef.current += 1; }, []);
  const refreshNotebooks = useCallback(async () => {
    const requestId = ++notebooksRequestRef.current;
    try {
      const result = await api.listNotebooks();
      if (requestId === notebooksRequestRef.current && !trashOperationsRef.current.size && !emptyingTrashRef.current) {
        setNotebooks(result.notebooks);
        await Promise.all(result.notebooks.map((notebook) => offlineSync.cacheNotebook(notebook)));
      }
    } catch {
      const local = await offlineSync.getLocalSnapshot();
      if (requestId === notebooksRequestRef.current && local.notebooks.length) setNotebooks(local.notebooks);
    }
  }, []);
  const loadNotes = useCallback(async () => {
    const requestId = ++listRequestRef.current;
    try {
      const result = await api.listNotes({ view, query: deferredQuery, notebookId });
      if (requestId !== listRequestRef.current || listScope !== listScopeRef.current || trashOperationsRef.current.size || emptyingTrashRef.current) return;
      replaceList(result.notes);
      setTotalNotes(result.total);
      setSelectedId((current) => current && result.notes.some((note) => note.id === current) ? current : result.notes[0]?.id ?? null);
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401 && !offlineSync.getState().pendingCount) navigate("/login", { replace: true });
      const local = await offlineSync.getLocalSnapshot();
      if (requestId !== listRequestRef.current || listScope !== listScopeRef.current) return;
      const localNotes = filterOfflineNotes(local.notes, local.notebooks, view, deferredQuery, notebookId);
      replaceList(localNotes);
      setTotalNotes(localNotes.length);
      setSelectedId((current) => current && localNotes.some((note) => note.id === current) ? current : localNotes[0]?.id ?? null);
    }
  }, [deferredQuery, listScope, navigate, notebookId, notesReloadToken, replaceList, view]);
  const reloadNotes = useCallback(() => setNotesReloadToken((value) => value + 1), []);
  useEffect(() => {
    if (!ready || syncState.status !== "synced") return;
    void refreshNotebooks();
    reloadNotes();
  }, [ready, refreshNotebooks, reloadNotes, syncState.status]);
  const selectNote = useCallback((id: string | null) => {
    setInNoteSearchQuery("");
    if (activeNoteIdRef.current === id) return;
    noteLoadRequestRef.current += 1;

    activeNoteIdRef.current = id;
    selectedRef.current = null;
    setSelectedId(id);
    setIsNoteLoading(Boolean(id));
    if (!id) setSelectedNote(null);
  }, []);
  const removeFromList = useCallback((noteId: string) => {
    const ordered = sortNotes(notesRef.current, noteSort);
    const index = ordered.findIndex((note) => note.id === noteId);
    if (index === -1) return;
    replaceList(notesRef.current.filter((note) => note.id !== noteId));
    setTotalNotes((value) => Math.max(0, value - 1));
    if (activeNoteIdRef.current === noteId) selectNote(ordered[index + 1]?.id ?? ordered[index - 1]?.id ?? null);
  }, [noteSort, replaceList, selectNote]);
  const loadSelectedNote = useCallback(async (id: string) => {
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
      const result = await api.getNote(id);
      if (requestId !== noteLoadRequestRef.current || activeNoteIdRef.current !== id) return;
      const latestPendingNote = pendingSavesRef.current.get(id);
      const nextNote = latestPendingNote ? { ...result.note, ...latestPendingNote } : result.note;
      await offlineSync.cacheNote(result.note);
      selectedRef.current = nextNote;
      setSelectedNote(nextNote);
      setIsNoteLoading(false);
      // A draft kept from an earlier failure or a note switch is retried instead of staying stuck on "saving".
      const retryDraft = latestPendingNote;
      if (retryDraft && !failedSave && !trashOperationsRef.current.has(id)) persistRef.current(retryDraft);
    } catch (reason) {
      if (requestId !== noteLoadRequestRef.current || activeNoteIdRef.current !== id) return;
      setIsNoteLoading(false);
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
      if (reason instanceof ApiError && reason.status === 401 && !offlineSync.getState().pendingCount) navigate("/login", { replace: true });
      const local = await offlineSync.getLocalSnapshot();
      const cached = local.notes.find((note) => note.id === id);
      if (cached) {
        selectedRef.current = cached;
        setSelectedNote(cached);
        setIsNoteLoading(false);
      } else setToast("无法打开这篇笔记");
    }
  }, [navigate]);
  useEffect(() => {
    if (!ready || !selectedId) {
      activeNoteIdRef.current = null;
      selectedRef.current = null;
      setIsNoteLoading(false);
      setSelectedNote(null);
      return;
    }
    void loadSelectedNote(selectedId);
  }, [loadSelectedNote, ready, selectedId]);
  useEffect(() => { if (ready) void refreshNotebooks(); return () => { notebooksRequestRef.current += 1; }; }, [ready, refreshNotebooks]);
  useEffect(() => { if (!ready) return; const timer = setTimeout(() => void loadNotes(), 180); return () => { clearTimeout(timer); listRequestRef.current += 1; }; }, [loadNotes, ready]);
  useEffect(() => {
    const requestId = ++commandNoteRequestRef.current;
    const normalizedQuery = commandNoteQuery.trim();
    if (!normalizedQuery) {
      setCommandNoteResults([]);
      setCommandNoteSearchLoading(false);
      return;
    }

    setCommandNoteSearchLoading(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const result = await api.listNotes({ view: "all", query: normalizedQuery });
          if (requestId === commandNoteRequestRef.current) setCommandNoteResults(result.notes);
        } catch {
          const local = await offlineSync.getLocalSnapshot();
          if (requestId === commandNoteRequestRef.current) setCommandNoteResults(filterOfflineNotes(local.notes, local.notebooks, "all", normalizedQuery));
        } finally {
          if (requestId === commandNoteRequestRef.current) setCommandNoteSearchLoading(false);
        }
      })();
    }, 160);
    return () => clearTimeout(timer);
  }, [commandNoteQuery]);
  const focusModeRef = useRef(focusMode);
  focusModeRef.current = focusMode;
  const hasModalOpenRef = useRef(false);
  hasModalOpenRef.current = Boolean(commandOpen || shareOpen || conflictOpen || editingNotebook !== undefined || confirmRequest);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isMod = event.ctrlKey || event.metaKey;
      if (isMod && (event.key === "/" || event.key === "k" || event.key === "K")) {
        event.preventDefault();
        setCommandInitialQuery("");
        setCommandOpen(true);
      } else if (isMod && (event.key === "f" || event.key === "F") && !event.shiftKey) {
        event.preventDefault();
        const selectedText = window.getSelection()?.toString().trim() ?? "";
        const initial = selectedText && selectedText.length <= 50 ? selectedText : "";
        setCommandInitialQuery(initial);
        setCommandOpen(true);
      } else if (isMod && event.key === "\\") {
        event.preventDefault();
        setSidebarCollapsed((value) => !value);
      } else if (isMod && event.shiftKey && (event.key === "f" || event.key === "F")) {
        event.preventDefault();
        toggleFocusMode();
      } else if (event.key === "Escape") {
        if (focusModeRef.current && !hasModalOpenRef.current) {
          exitFocusMode();
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [exitFocusMode, toggleFocusMode]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(""), 3000); return () => clearTimeout(timer); }, [toast]);

  const persistRef = useRef<(draft: Note | NoteDraft) => void>(() => undefined);
  const runSave = useCallback(async (noteId: string, keepalive = false) => {
    const running = inFlightSavesRef.current.get(noteId);
    if (running) return running;
    const task = (async () => {
      try {
        // Drain this note's latest draft in order, including edits made while a request was in flight.
        while (pendingSavesRef.current.has(noteId)) {
          const draft = pendingSavesRef.current.get(noteId)!;
          const base = selectedRef.current?.id === noteId ? selectedRef.current : notesRef.current.find((note) => note.id === noteId);
          if (!base) throw new Error("note-not-loaded");
          const result = await offlineSync.saveNote({ ...base, ...draft, preview: base.preview, notebookName: base.notebookName, createdAt: base.createdAt, updatedAt: base.updatedAt }, { keepalive });
          const latest = pendingSavesRef.current.get(noteId);
          const next = latest && latest !== draft ? { ...result.note, ...latest, version: result.note.version } : undefined;
          if (next) pendingSavesRef.current.set(noteId, next);
          else pendingSavesRef.current.delete(noteId);
          failedSavesRef.current.delete(noteId);
          replaceList(notesRef.current.map((note) => note.id === noteId ? { ...note, ...result.note, ...next } : note));
          if (activeNoteIdRef.current === noteId) {
            selectedRef.current = next ?? result.note;
            setSelectedNote(selectedRef.current);
            setSaveState(next ? "saving" : result.offline ? "local" : "saved");
          }
        }
      } catch (reason) {
        failedSavesRef.current.set(noteId, reason);
        const conflict = reason instanceof ApiError && reason.code === "VERSION_CONFLICT";
        if (activeNoteIdRef.current === noteId) setSaveState(conflict ? "conflict" : "error");
        if (!trashOperationsRef.current.has(noteId)) setToast(conflict ? "这篇笔记已在别处更新，请重新载入" : errorMessage(reason, "保存失败，请检查网络后重试"));
        throw reason;
      }
    })();
    inFlightSavesRef.current.set(noteId, task);
    try { await task; }
    finally { if (inFlightSavesRef.current.get(noteId) === task) inFlightSavesRef.current.delete(noteId); }
  }, [replaceList]);
  const persist = useCallback((draft: Note | NoteDraft) => {
    const pendingDraft = toNoteDraft(draft);
    pendingSavesRef.current.set(pendingDraft.id, pendingDraft);
    if (activeNoteIdRef.current === pendingDraft.id) setSaveState("saving");
    const existingTimer = saveTimersRef.current.get(pendingDraft.id);
    if (existingTimer) clearTimeout(existingTimer);
    const timer = setTimeout(() => {
      saveTimersRef.current.delete(pendingDraft.id);
      const requestDraft = pendingSavesRef.current.get(pendingDraft.id);
      if (!requestDraft) return;
      void runSave(pendingDraft.id).catch(() => undefined);
    }, 800);
    saveTimersRef.current.set(pendingDraft.id, timer);
  }, [runSave]);
  persistRef.current = persist;
  const saveNoteNow = useCallback(() => {
    const current = selectedRef.current;
    const pending = current ? pendingSavesRef.current.get(current.id) : undefined;
    if (!current || !pending) return;
    const timer = saveTimersRef.current.get(current.id);
    if (timer) clearTimeout(timer);
    saveTimersRef.current.delete(current.id);
    setSaveState("saving");
    void runSave(current.id).catch(() => undefined);
  }, [runSave]);
  // Keeps in-flight edits from being lost when the page is hidden or unloaded.
  const flushPendingSaves = useCallback(async (mode: "now" | "keepalive") => {
    const ids = [...pendingSavesRef.current.keys()];
    if (!ids.length) return;
    await Promise.all(ids.map(async (id) => {
      const timer = saveTimersRef.current.get(id);
      if (timer) clearTimeout(timer);
      saveTimersRef.current.delete(id);
      const draft = pendingSavesRef.current.get(id);
      if (!draft) return;
      if (failedSavesRef.current.has(id)) return;
      await runSave(id, mode === "keepalive").catch(() => undefined);
    }));
  }, [runSave]);
  useEffect(() => {
    const flushWhenHidden = () => { if (document.visibilityState === "hidden") void flushPendingSaves("now"); };
    const flushWhenUnloading = () => { void flushPendingSaves("keepalive"); };
    document.addEventListener("visibilitychange", flushWhenHidden);
    window.addEventListener("pagehide", flushWhenUnloading);
    return () => {
      document.removeEventListener("visibilitychange", flushWhenHidden);
      window.removeEventListener("pagehide", flushWhenUnloading);
    };
  }, [flushPendingSaves]);
  useEffect(() => () => {
    void flushPendingSaves("keepalive");
    for (const timer of saveTimersRef.current.values()) clearTimeout(timer);
    saveTimersRef.current.clear();
  }, [flushPendingSaves]);
  const onNoteChange = useCallback((patch: { title?: string; contentMarkdown?: string; notebookId?: string }) => {
    const current = selectedRef.current;
    if (!current || trashOperationsRef.current.has(current.id)) return;
    if ((patch.title === undefined || patch.title === current.title) && (patch.contentMarkdown === undefined || patch.contentMarkdown === current.contentMarkdown) && (patch.notebookId === undefined || patch.notebookId === current.notebookId)) return;
    const targetNotebook = patch.notebookId ? notebooks.find((nb) => nb.id === patch.notebookId) : undefined;
    const next = { ...current, ...patch, ...(targetNotebook ? { notebookName: targetNotebook.name } : {}) };
    selectedRef.current = next;
    const contentOnlyChange = patch.contentMarkdown !== undefined && patch.title === undefined && patch.notebookId === undefined;
    if (!contentOnlyChange) setSelectedNote(next);
    persist(next);
    if (patch.notebookId && patch.notebookId !== current.notebookId) {
      refreshNotebooks();
      setToast(targetNotebook ? `已移至“${targetNotebook.name}”` : "已变更所属笔记本");
    }
  }, [notebooks, persist, refreshNotebooks]);
  const revealCreatedNote = useCallback((note: Note, target: { view: NoteView; notebookId?: string }, message: string) => {
    invalidateCollections();
    searchOriginRef.current = null;
    setView(target.view);
    setNotebookId(target.notebookId);
    setQuery("");
    replaceList([note, ...notesRef.current.filter((currentNote) => currentNote.id !== note.id)]);
    setTotalNotes((value) => value + 1);
    setSelectedNote(note);
    setIsNoteLoading(true);
    selectedRef.current = note;
    activeNoteIdRef.current = note.id;
    pendingSavesRef.current.delete(note.id);
    setSelectedId(note.id);
    setMobileListOpen(false);
    setToast(message);
  }, []);
  const createNoteHere = useCallback(async () => {
    const currentNotebook = notebookId ? notebooks.find((notebook) => notebook.id === notebookId) : undefined;
    const inbox = notebooks.find((notebook) => notebook.isSystem);
    const staysInView = Boolean(currentNotebook) || view === "all" || view === "inbox";
    try {
      const result = await offlineSync.createNote(currentNotebook ? { notebookId: currentNotebook.id } : { notebookId: inbox?.id }, currentNotebook ?? inbox);
      revealCreatedNote(result.note, { view: currentNotebook || !staysInView ? "all" : view, notebookId: currentNotebook?.id }, result.offline ? "已在本机创建笔记，联网后自动同步" : currentNotebook ? `已在“${currentNotebook.name}”中创建新笔记` : "已在收件箱中创建新笔记");
      refreshNotebooks();
    } catch (reason) { setToast(errorMessage(reason, "创建笔记失败")); }
  }, [notebookId, notebooks, refreshNotebooks, revealCreatedNote, view]);
  const createNoteInNotebook = useCallback(async (commandToCreate: CreateNoteCommand) => {
    try {
      const notebook = notebooks.find((item) => item.id === commandToCreate.notebookId);
      const result = await offlineSync.createNote({ notebookId: commandToCreate.notebookId, title: commandToCreate.title }, notebook);
      revealCreatedNote(result.note, { view: "all", notebookId: commandToCreate.notebookId }, result.offline ? "已在本机创建笔记，联网后自动同步" : `已在“${commandToCreate.notebookName}”中创建“${commandToCreate.title}”`);
      setEditorFocusNoteId(result.note.id);
      refreshNotebooks();
    } catch (reason) { if (reason instanceof ApiError && reason.status === 401 && !offlineSync.getState().pendingCount) navigate("/login", { replace: true }); setToast(errorMessage(reason, "创建笔记失败，请稍后重试")); }
  }, [navigate, notebooks, refreshNotebooks, revealCreatedNote]);
  const createNotebook = useCallback(() => setEditingNotebook(null), []);
  const saveNotebook = useCallback((saved: Notebook) => {
    setNotebooks((current) => {
      const exists = current.some((nb) => nb.id === saved.id);
      return exists ? current.map((nb) => nb.id === saved.id ? { ...nb, name: saved.name, color: saved.color } : nb) : [...current, saved];
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
  const saveNotebookDraft = useCallback(async (draft: { name: string; color: string }) => {
    const existing = editingNotebook ?? undefined;
    const timestamp = Math.floor(Date.now() / 1000);
    const notebook: Notebook = existing
      ? { ...existing, name: draft.name, color: draft.color }
      : { id: crypto.randomUUID(), name: draft.name, color: draft.color, isSystem: false, count: 0, updatedAt: timestamp };
    const result = await offlineSync.saveNotebook(notebook, !existing);
    if (result.offline) setToast("已保存到本机，联网后自动同步");
    return result.notebook;
  }, [editingNotebook]);
  const deleteNotebook = useCallback(async (id: string) => {
    try {
      const target = notebooks.find((notebook) => notebook.id === id);
      const inbox = notebooks.find((notebook) => notebook.isSystem);
      if (!target || !inbox) throw new Error("notebook-not-found");
      const result = await offlineSync.deleteNotebook(target, inbox);
      setNotebooks((current) => current.filter((nb) => nb.id !== id));
      if (notebookId === id) setNotebookId(undefined);
      refreshNotebooks();
      void loadNotes();
      setToast(result.offline ? "已在本机删除笔记本，联网后自动同步" : "已删除笔记本，原笔记已归入收件箱");
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

    const timer = saveTimersRef.current.get(current.id);
    if (timer) clearTimeout(timer);
    saveTimersRef.current.delete(current.id);
    pendingSavesRef.current.set(current.id, toNoteDraft(next));
    setSaveState("saving");
    const scope = listScopeRef.current;
    void runSave(current.id).then(() => {
      if (scope === listScopeRef.current) removeFromList(current.id);
    }).catch(() => undefined);
  }, [persist, removeFromList, runSave, view]);
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
    const timer = saveTimersRef.current.get(current.id);
    if (timer) clearTimeout(timer);
    saveTimersRef.current.delete(current.id);
    pendingSavesRef.current.set(current.id, toNoteDraft(next));
    setNotebooks((items) => items.map((notebook) => notebook.id === current.notebookId ? { ...notebook, count: Math.max(0, notebook.count + (deleted ? -1 : 1)) } : notebook));
    try {
      await runSave(current.id);
      if (scope === listScopeRef.current) removeFromList(current.id);
      setToast(deleted ? "已移入回收站" : "已恢复笔记");
    } catch (reason) {
      pendingSavesRef.current.set(current.id, toNoteDraft(current));
      setNotebooks((items) => items.map((notebook) => notebook.id === current.notebookId ? { ...notebook, count: Math.max(0, notebook.count + (deleted ? 1 : -1)) } : notebook));
      setToast(reason instanceof ApiError && reason.code === "VERSION_CONFLICT" ? "这篇笔记已在别处更新，操作未完成，本地草稿已保留" : errorMessage(reason, deleted ? "移入回收站失败，请重试" : "恢复笔记失败，请重试"));
    } finally { finishTrashOperation(current.id); }
  }, [finishTrashOperation, invalidateCollections, removeFromList, runSave]);
  const moveToTrash = useCallback(() => { void changeDeletedState(true); }, [changeDeletedState]);
  const restoreFromTrash = useCallback(() => { void changeDeletedState(false); }, [changeDeletedState]);
  const discardNoteDraft = useCallback((noteId: string) => {
    pendingSavesRef.current.delete(noteId);
    failedSavesRef.current.delete(noteId);
    const timer = saveTimersRef.current.get(noteId);
    if (timer) clearTimeout(timer);
    saveTimersRef.current.delete(noteId);
  }, []);
  const performPermanentDelete = useCallback(async (noteId: string) => {
    if (trashOperationsRef.current.has(noteId) || emptyingTrashRef.current) throw new ApiError(409, "TRASH_BUSY", "回收站正在处理其他操作，请稍后重试");
    trashOperationsRef.current.add(noteId);
    setPendingTrashCount(trashOperationsRef.current.size);
    invalidateCollections();
    try {
      await runSave(noteId);
      const note = selectedRef.current?.id === noteId ? selectedRef.current : (await offlineSync.getLocalSnapshot()).notes.find((item) => item.id === noteId);
      if (!note) throw new Error("note-not-found");
      const result = await offlineSync.permanentlyDeleteNote(note);
      removeFromList(noteId);
      discardNoteDraft(noteId);
      setToast(result.offline ? "已在本机彻底删除，联网后自动同步" : "已彻底删除笔记");
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
  const reloadSelectedNote = useCallback(async () => {
    const current = selectedRef.current;
    if (!current) return;
    pendingSavesRef.current.delete(current.id);
    const timer = saveTimersRef.current.get(current.id);
    if (timer) clearTimeout(timer);
    saveTimersRef.current.delete(current.id);
    setIsNoteLoading(true);
    try {
      const result = await api.getNote(current.id);
      if (selectedRef.current?.id !== result.note.id) return;
      selectedRef.current = result.note;
      setSelectedNote(result.note);
      setNoteReloadToken((value) => value + 1);
      setSaveState("idle");
      failedSavesRef.current.delete(current.id);
      setToast("已重新载入最新版本");
    } catch {
      setToast("重新载入失败，请重试");
    } finally {
      setIsNoteLoading(false);
    }
  }, []);
  const requestConflictReload = useCallback(() => {
    requestConfirm({
      eyebrow: "版本冲突",
      title: "重新载入最新版本？",
      description: "这篇笔记已在别处更新。重新载入会使用服务器上的最新内容替换当前编辑，本地尚未保存的修改将丢失。",
      confirmLabel: "重新载入",
      onConfirm: () => void reloadSelectedNote(),
    });
  }, [reloadSelectedNote, requestConfirm]);
  const selectView = useCallback((next: NoteView) => { searchOriginRef.current = null; setQuery(""); setView(next); setNotebookId(undefined); setMobileSidebarOpen(false); }, []);
  const selectNotebook = useCallback((notebookIdToSelect: string) => { searchOriginRef.current = null; setQuery(""); setNotebookId(notebookIdToSelect); setView("all"); setMobileSidebarOpen(false); }, []);
  const changeQuery = useCallback((next: string) => {
    if (next) {
      if (!query) searchOriginRef.current = { view, notebookId };
      setQuery(next);
      setView("all");
      setNotebookId(undefined);
      return;
    }
    const origin = searchOriginRef.current;
    searchOriginRef.current = null;
    setQuery("");
    setView(origin?.view ?? "all");
    setNotebookId(origin?.notebookId);
  }, [notebookId, query, view]);
  const closeCommandMenu = useCallback(() => {
    setCommandOpen(false);
    setCommandNoteQuery("");
    setCommandInitialQuery("");
  }, []);
  const handleCommandNoteQueryChange = useCallback((next: string) => {
    setCommandNoteQuery(next);
  }, []);
  const handleSearchInCurrentNote = useCallback((term: string) => {
    const normalized = term.trim();
    if (!normalized) return;
    setInNoteSearchQuery(normalized);
  }, []);
  const handleClearSearch = useCallback(() => {
    setInNoteSearchQuery("");
    if (query) {
      changeQuery("");
    }
  }, [changeQuery, query]);
  const openCommandSearchResult = useCallback((noteId: string, searchQuery: string) => {

    const normalizedQuery = searchQuery.trim();
    if (!normalizedQuery) return;
    setInNoteSearchQuery("");
    changeQuery(normalizedQuery);
    selectNote(noteId);
    setMobileSidebarOpen(false);
  }, [changeQuery, selectNote]);
  const command = useCallback((id: CommandId) => {
    if (id === "new-note") void createNoteHere();
    if (id === "find-in-note") {
      const selectedText = window.getSelection()?.toString().trim() ?? "";
      const initial = selectedText && selectedText.length <= 50 ? selectedText : "";
      setCommandInitialQuery(initial);
      setCommandOpen(true);
    }
    if (id === "search") { setMobileSidebarOpen(true); requestAnimationFrame(() => searchRef.current?.focus()); }
    if (id === "toggle-sidebar") setSidebarCollapsed((value) => !value);
    if (id === "toggle-focus-mode") toggleFocusMode();
    if (id === "share" && selectedRef.current) setShareOpen(true);
    if (id === "favorite") toggleFavorite();
    if (id === "trash") moveToTrash();
    if (id === "restore") restoreFromTrash();
    if (id === "install-app") { if (pwaState.canInstall) void installPwa(); else if (pwaState.showIosInstallHint && !pwaState.standalone) setToast("请在 Safari 中点击分享，再选择“添加到主屏幕”"); }
  }, [createNoteHere, moveToTrash, pwaState, restoreFromTrash, toggleFavorite, toggleFocusMode]);
  useEffect(() => {
    if (!ready || shortcutHandledRef.current) return;
    const action = new URLSearchParams(window.location.search).get("action");
    if (action === "new-note") void createNoteHere();
    if (action === "search") { setMobileSidebarOpen(true); requestAnimationFrame(() => searchRef.current?.focus()); }
    shortcutHandledRef.current = true;
    if (action) window.history.replaceState(null, "", `${window.location.pathname}${window.location.hash}`);
  }, [createNoteHere, ready]);
  const logout = async () => {
    await flushPendingSaves("now");
    if (hasUnsavedWork()) {
      setToast("仍有内容未保存或存在同步冲突，请联网同步并处理后再退出");
      if (offlineSync.getState().conflictCount > 0) setConflictOpen(true);
      return;
    }
    await api.logout().catch(() => undefined);
    await offlineSync.clear();
    navigate("/login", { replace: true });
  };
  const updatePwa = useCallback(async () => {
    await flushPendingSaves("now");
    if (pendingSavesRef.current.size > 0 || failedSavesRef.current.size > 0) { setToast("仍有编辑内容未保存，更新已暂缓"); return; }
    await offlineSync.sync();
    const sync = offlineSync.getState();
    if (sync.pendingCount > 0) { setToast("仍有内容等待联网同步，更新已暂缓"); return; }
    if (sync.conflictCount > 0) { setToast("请先处理同步冲突，再更新应用"); setConflictOpen(true); return; }
    applyPwaUpdate();
  }, [flushPendingSaves]);
  const retrySync = useCallback(() => { void offlineSync.sync(); }, []);
  if (!ready) return <main className="app-loading"><span className="loading-ring" /><span>正在进入你的空间……</span></main>;
  const currentNotebook = notebookId ? notebooks.find((notebook) => notebook.id === notebookId) : undefined;
  const renderedNote = selectedNote && selectedRef.current?.id === selectedNote.id ? selectedRef.current : selectedNote;
  const commandNoteReady = Boolean(renderedNote && selectedRef.current?.id === renderedNote.id && !isNoteLoading);
  const activeSearchQuery = inNoteSearchQuery || query;
  const mobileNavigationOpen = mobileSidebarOpen || mobileListOpen;
  return <div className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${focusMode ? "is-focus-mode" : ""}`}>
    {mobileNavigationOpen && <button className="mobile-scrim is-visible" type="button" aria-label="关闭导航" onClick={() => { setMobileSidebarOpen(false); setMobileListOpen(false); }} />}
    <Sidebar view={view} setView={selectView} notebooks={notebooks} notebookId={notebookId} setNotebookId={selectNotebook} query={query} setQuery={changeQuery} searchRef={searchRef} onNewNote={() => void createNoteHere()} onCreateNotebook={() => void createNotebook()} onEditNotebook={(target) => setEditingNotebook(target)} collapsed={sidebarCollapsed} onCollapse={() => setSidebarCollapsed((value) => !value)} mobileOpen={mobileSidebarOpen} onLogout={logout} />
    <NoteListPanel notes={notes} total={totalNotes} sort={noteSort} setSort={setNoteSort} selectedId={selectedId} onSelect={(id) => { selectNote(id); setMobileListOpen(false); }} view={view} query={query} currentNotebookName={currentNotebook?.name} onEmptyTrash={view === "trash" ? emptyTrash : undefined} trashBusy={pendingTrashCount > 0 || emptyingTrash} onNewNote={currentNotebook ? () => void createNoteHere() : undefined} onClearQuery={() => changeQuery("")} mobileOpen={mobileListOpen} onOpenSidebar={() => setMobileSidebarOpen(true)} />
    <main className="editor-region">
      {renderedNote ? <Suspense fallback={<NoteLoadingState />}><LazyNoteEditor note={renderedNote} searchQuery={activeSearchQuery} onClearSearch={activeSearchQuery ? handleClearSearch : undefined} saveState={saveState} isLoading={isNoteLoading} trashBusy={emptyingTrash || (pendingTrashCount > 0 && trashOperationsRef.current.has(renderedNote.id))} reloadToken={noteReloadToken} focusRequested={editorFocusNoteId === renderedNote.id && !commandOpen} onFocusHandled={handleEditorFocus} onChange={onNoteChange} onSaveNow={saveNoteNow} onReloadNote={requestConflictReload} onShare={() => setShareOpen(true)} onToggleFavorite={toggleFavorite} onMoveToTrash={moveToTrash} onRestore={restoreFromTrash} onPermanentDelete={permanentDeleteNote} onOpenList={() => setMobileListOpen(true)} focusMode={focusMode} onToggleFocusMode={toggleFocusMode} /></Suspense> : isNoteLoading ? <NoteLoadingState /> : <EmptyEditor isTrash={view === "trash"} onNewNote={() => void createNoteHere()} onOpenList={() => setMobileListOpen(true)} />}
    </main>
    <CommandMenu open={commandOpen} onClose={closeCommandMenu} onCommand={command} onCreateNoteInNotebook={createNoteInNotebook} canRestore={Boolean(commandNoteReady && renderedNote?.deletedAt)} canMoveToTrash={Boolean(commandNoteReady && renderedNote && !renderedNote.deletedAt)} notebooks={notebooks} focusMode={focusMode} canInstallApp={pwaState.canInstall} showIosInstallHint={pwaState.showIosInstallHint} standalone={pwaState.standalone} noteResults={commandNoteResults} noteSearchLoading={commandNoteSearchLoading} onSearchQueryChange={handleCommandNoteQueryChange} onOpenSearchResult={openCommandSearchResult} hasSelectedNote={commandNoteReady} onSearchInCurrentNote={handleSearchInCurrentNote} initialQuery={commandInitialQuery} />


    {shareOpen && renderedNote && <ShareDialog note={renderedNote} onClose={() => setShareOpen(false)} onToast={setToast} />}
    {editingNotebook !== undefined && <NotebookDialog key={editingNotebook?.id ?? "new"} notebook={editingNotebook} onClose={() => setEditingNotebook(undefined)} onSave={saveNotebookDraft} onSaved={saveNotebook} onRequestDelete={(target) => requestConfirm({ eyebrow: "整理上下文", title: `删除笔记本“${target.name}”？`, description: "笔记本中的笔记会自动移入收件箱，笔记内容不会被删除。", confirmLabel: "删除笔记本", danger: true, onConfirm: () => void deleteNotebook(target.id) })} onToast={setToast} />}
    {conflictOpen && conflicts[0] && <ConflictDialog conflict={conflicts[0]} onClose={() => setConflictOpen(false)} onResolved={() => { setConflicts((current) => current.slice(1)); if (selectedRef.current?.id === conflicts[0]?.noteId) setNoteReloadToken((value) => value + 1); }} />}
    {confirmRequest && <ConfirmDialog key={confirmRequest.id} request={confirmRequest} onClose={() => setConfirmRequest(null)} />}
    <div className="system-notices"><SyncNotice state={syncState} pwa={pwaState} onRetry={retrySync} onUpdate={() => void updatePwa()} onConflicts={() => setConflictOpen(true)} />{toast && <div className="toast" role="status">{toast}</div>}</div>
  </div>;
}
