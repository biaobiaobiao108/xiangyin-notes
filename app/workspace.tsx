import { lazy, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Archive, ChevronDown, ChevronLeft, FileText, Folder, Inbox, LayoutPanelLeft, Link2, LogOut, Menu, Pencil, Plus, RefreshCw, Search, Share2, Star, Trash2, UsersRound, X } from "lucide-react";
import { useNavigate } from "react-router";
import { ApiError, api } from "./api";
import { CommandId, CommandMenu } from "./command-menu";
import type { CreateNoteCommand } from "./command-parser";
import { BrandMark } from "./brand-mark";
import { FloatingScrollbar } from "./floating-scrollbar";
import { modKey } from "./platform";
import type { Note, NoteSummary, NoteView, Notebook, Share } from "../shared/types";

const navItems: Array<{ id: NoteView; label: string; icon: typeof Inbox }> = [
  { id: "inbox", label: "收件箱", icon: Inbox },
  { id: "all", label: "全部笔记", icon: FileText },
  { id: "favorites", label: "收藏", icon: Star },
  { id: "shared", label: "已分享", icon: UsersRound },
  { id: "trash", label: "回收站", icon: Trash2 },
];

const notebookColorOptions = ["#d96245", "#718077", "#5b7899", "#9c765f", "#aa6f8e", "#8b7c54", "#6b72a8", "#6f7d83"];

const LazyNoteEditor = lazy(() => import("./editor").then(({ NoteEditor }) => ({ default: NoteEditor })));

type NoteDraft = Pick<Note, "id" | "version" | "title" | "contentMarkdown" | "notebookId" | "isFavorite" | "deletedAt">;

function toNoteDraft(note: Note | NoteDraft): NoteDraft {
  return {
    id: note.id,
    version: note.version,
    title: note.title,
    contentMarkdown: note.contentMarkdown,
    notebookId: note.notebookId,
    isFavorite: note.isFavorite,
    deletedAt: note.deletedAt,
  };
}

function noteSavePayload(draft: NoteDraft) {
  return { version: draft.version, title: draft.title, contentMarkdown: draft.contentMarkdown, notebookId: draft.notebookId, isFavorite: draft.isFavorite, deleted: Boolean(draft.deletedAt) };
}

function errorMessage(reason: unknown, fallback: string) {
  return reason instanceof ApiError && reason.message ? reason.message : fallback;
}

type NoteSort = "updated" | "created" | "title";

function sortNotes(notes: NoteSummary[], sort: NoteSort) {
  return [...notes].sort((a, b) => sort === "created" ? b.createdAt - a.createdAt : sort === "title" ? (a.title || "未命名笔记").localeCompare(b.title || "未命名笔记", "zh-CN") : b.updatedAt - a.updatedAt);
}

type ConfirmRequest = {
  id: number;
  eyebrow: string;
  title: string;
  description: string;
  confirmLabel: string;
  danger?: boolean;
  returnFocus?: HTMLElement | null;
  onConfirm: () => void | Promise<void>;
};

function ConfirmDialog({ request, onClose }: { request: ConfirmRequest; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const submittingRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      const trigger = request.returnFocus;
      const target = trigger?.isConnected && !trigger.matches(":disabled") ? trigger
        : document.querySelector<HTMLElement>(".note-row.is-selected") ?? document.querySelector<HTMLElement>(".note-list-panel.is-mobile-open .list-header h2, .empty-editor h1");
      target?.focus({ preventScroll: true });
    };
  }, [request]);
  const confirm = async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setBusy(true);
    setError("");
    try { await request.onConfirm(); onClose(); }
    catch (reason) { setError(errorMessage(reason, "操作失败，请重试")); }
    finally { submittingRef.current = false; setBusy(false); }
  };
  return <dialog ref={dialogRef} className="confirm-dialog" aria-labelledby="confirm-dialog-title" aria-describedby="confirm-dialog-description" aria-busy={busy} onCancel={(event) => { event.preventDefault(); if (!submittingRef.current) onClose(); }}>
    <div className="dialog-heading">
      <div>
        <span className={`dialog-eyebrow ${request.danger ? "is-danger" : ""}`}>{request.danger ? <AlertTriangle size={15} /> : <RefreshCw size={15} />}{request.eyebrow}</span>
        <h2 id="confirm-dialog-title">{request.title}</h2>
        <p id="confirm-dialog-description">{request.description}</p>
        {error && <p className="text-danger" role="alert">{error}</p>}
      </div>
    </div>
    <div className="dialog-actions">
      <button className="secondary-button" type="button" autoFocus disabled={busy} onClick={onClose}>取消</button>
      <button className={`primary-button ${request.danger ? "danger-primary" : ""}`} type="button" disabled={busy} onClick={() => void confirm()}>{busy ? "正在处理……" : request.confirmLabel}</button>
    </div>
  </dialog>;
}

function NoteLoadingState() {
  return <section className="editor-panel editor-loading-shell" aria-label="笔记编辑器" aria-busy="true"><div className="editor-switch-overlay editor-switch-overlay--visible" role="status" aria-live="polite"><div className="editor-switch-card"><BrandMark className="editor-switch-mark" /><div className="editor-switch-lines" aria-hidden="true"><span /><span /><span /></div><strong>正在打开笔记…</strong></div></div></section>;
}

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
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "conflict" | "error">("idle");
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
  const [shareOpen, setShareOpen] = useState(false);
  const [editingNotebook, setEditingNotebook] = useState<Notebook | null | undefined>(undefined);
  const [toast, setToast] = useState("");
  const [ready, setReady] = useState(false);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const [noteReloadToken, setNoteReloadToken] = useState(0);
  const confirmIdRef = useRef(0);
  const requestConfirm = useCallback((request: Omit<ConfirmRequest, "id">) => {
    confirmIdRef.current += 1;
    setConfirmRequest({ ...request, id: confirmIdRef.current, returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null });
  }, []);

  useEffect(() => { void api.bootstrap().then(async (status) => { if (!status.configured) { navigate("/setup", { replace: true }); return; } try { await api.me(); setReady(true); } catch { navigate("/login", { replace: true }); } }).catch(() => navigate("/login", { replace: true })); }, [navigate]);

  const replaceList = useCallback((next: NoteSummary[]) => { notesRef.current = next; setNotes(next); }, []);
  const invalidateCollections = useCallback(() => { listRequestRef.current += 1; notebooksRequestRef.current += 1; }, []);
  const refreshNotebooks = useCallback(async () => {
    const requestId = ++notebooksRequestRef.current;
    try {
      const result = await api.listNotebooks();
      if (requestId === notebooksRequestRef.current && !trashOperationsRef.current.size && !emptyingTrashRef.current) setNotebooks(result.notebooks);
    } catch { /* Keep the last known counts if refreshing fails. */ }
  }, []);
  const loadNotes = useCallback(async () => {
    const requestId = ++listRequestRef.current;
    try {
      const result = await api.listNotes({ view, query: deferredQuery, notebookId });
      if (requestId !== listRequestRef.current || listScope !== listScopeRef.current || trashOperationsRef.current.size || emptyingTrashRef.current) return;
      replaceList(result.notes);
      setTotalNotes(result.total);
      setSelectedId((current) => current && result.notes.some((note) => note.id === current) ? current : result.notes[0]?.id ?? null);
    } catch (reason) { if (reason instanceof ApiError && reason.status === 401) navigate("/login", { replace: true }); }
  }, [deferredQuery, listScope, navigate, notebookId, notesReloadToken, replaceList, view]);
  const reloadNotes = useCallback(() => setNotesReloadToken((value) => value + 1), []);
  const selectNote = useCallback((id: string | null) => {
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
      if (reason instanceof ApiError && reason.status === 401) navigate("/login", { replace: true });
      else setToast("无法打开这篇笔记");
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
  const focusModeRef = useRef(focusMode);
  focusModeRef.current = focusMode;
  const hasModalOpenRef = useRef(false);
  hasModalOpenRef.current = Boolean(commandOpen || shareOpen || editingNotebook !== undefined || confirmRequest);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isMod = event.ctrlKey || event.metaKey;
      if (isMod && (event.key === "/" || event.key === "k" || event.key === "K")) {
        event.preventDefault();
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
          const result = await api.updateNote(noteId, noteSavePayload(draft), { keepalive });
          const latest = pendingSavesRef.current.get(noteId);
          const next = latest && latest !== draft ? { ...result.note, ...latest, version: result.note.version } : undefined;
          if (next) pendingSavesRef.current.set(noteId, next);
          else pendingSavesRef.current.delete(noteId);
          failedSavesRef.current.delete(noteId);
          replaceList(notesRef.current.map((note) => note.id === noteId ? { ...note, ...result.note, ...next } : note));
          if (activeNoteIdRef.current === noteId) {
            selectedRef.current = next ?? result.note;
            setSelectedNote(selectedRef.current);
            setSaveState(next ? "saving" : "saved");
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
    const staysInView = Boolean(currentNotebook) || view === "all" || view === "inbox";
    try {
      const result = await api.createNote(currentNotebook ? { notebookId: currentNotebook.id } : {});
      revealCreatedNote(result.note, { view: currentNotebook || !staysInView ? "all" : view, notebookId: currentNotebook?.id }, currentNotebook ? `已在“${currentNotebook.name}”中创建新笔记` : "已在收件箱中创建新笔记");
      refreshNotebooks();
    } catch (reason) { setToast(errorMessage(reason, "创建笔记失败")); }
  }, [notebookId, notebooks, refreshNotebooks, revealCreatedNote, view]);
  const createNoteInNotebook = useCallback(async (commandToCreate: CreateNoteCommand) => { try { const result = await api.createNote({ notebookId: commandToCreate.notebookId, title: commandToCreate.title }); revealCreatedNote(result.note, { view: "all", notebookId: commandToCreate.notebookId }, `已在“${commandToCreate.notebookName}”中创建“${commandToCreate.title}”`); setEditorFocusNoteId(result.note.id); refreshNotebooks(); } catch (reason) { if (reason instanceof ApiError && reason.status === 401) navigate("/login", { replace: true }); setToast(errorMessage(reason, "创建笔记失败，请稍后重试")); } }, [navigate, refreshNotebooks, revealCreatedNote]);
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
  const deleteNotebook = useCallback(async (id: string) => {
    try {
      await api.deleteNotebook(id);
      setNotebooks((current) => current.filter((nb) => nb.id !== id));
      if (notebookId === id) setNotebookId(undefined);
      refreshNotebooks();
      void loadNotes();
      setToast("已删除笔记本，原笔记已归入收件箱");
      setEditingNotebook(undefined);
    } catch (reason) {
      setToast(errorMessage(reason, "删除笔记本失败"));
    }
  }, [loadNotes, notebookId, refreshNotebooks]);
  const toggleFavorite = useCallback(() => { const current = selectedRef.current; if (!current) return; const next = { ...current, isFavorite: !current.isFavorite }; selectedRef.current = next; setSelectedNote(next); persist(next); if (view === "favorites" && !next.isFavorite) removeFromList(current.id); }, [persist, removeFromList, view]);
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
    const index = notesRef.current.findIndex((note) => note.id === current.id);
    const next = { ...current, deletedAt: deleted ? Math.floor(Date.now() / 1000) : null };
    trashOperationsRef.current.add(current.id);
    setPendingTrashCount(trashOperationsRef.current.size);
    invalidateCollections();
    const timer = saveTimersRef.current.get(current.id);
    if (timer) clearTimeout(timer);
    saveTimersRef.current.delete(current.id);
    pendingSavesRef.current.set(current.id, toNoteDraft(next));
    setNotebooks((items) => items.map((notebook) => notebook.id === current.notebookId ? { ...notebook, count: Math.max(0, notebook.count + (deleted ? -1 : 1)) } : notebook));
    removeFromList(current.id);
    try {
      await runSave(current.id);
      setToast(deleted ? "已移入回收站" : "已恢复笔记");
    } catch (reason) {
      const restored = { ...current, ...(pendingSavesRef.current.get(current.id) ?? {}), deletedAt: current.deletedAt };
      pendingSavesRef.current.set(current.id, toNoteDraft(restored));
      setNotebooks((items) => items.map((notebook) => notebook.id === current.notebookId ? { ...notebook, count: Math.max(0, notebook.count + (deleted ? 1 : -1)) } : notebook));
      if (scope === listScopeRef.current && index !== -1 && !notesRef.current.some((note) => note.id === current.id)) {
        const list = [...notesRef.current];
        list.splice(index, 0, restored);
        replaceList(list);
        setTotalNotes((total) => total + 1);
        if (!activeNoteIdRef.current) selectNote(current.id);
      }
      setToast(reason instanceof ApiError && reason.code === "VERSION_CONFLICT" ? "这篇笔记已在别处更新，操作未完成，本地草稿已保留" : errorMessage(reason, deleted ? "移入回收站失败，请重试" : "恢复笔记失败，请重试"));
    } finally { finishTrashOperation(current.id); }
  }, [finishTrashOperation, invalidateCollections, removeFromList, replaceList, runSave, selectNote]);
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
  const command = useCallback((id: CommandId) => { if (id === "new-note") void createNoteHere(); if (id === "search") { setMobileSidebarOpen(true); requestAnimationFrame(() => searchRef.current?.focus()); } if (id === "toggle-sidebar") setSidebarCollapsed((value) => !value); if (id === "toggle-focus-mode") toggleFocusMode(); if (id === "share" && selectedRef.current) setShareOpen(true); if (id === "favorite") toggleFavorite(); if (id === "trash") moveToTrash(); if (id === "restore") restoreFromTrash(); }, [createNoteHere, moveToTrash, restoreFromTrash, toggleFavorite, toggleFocusMode]);
  const logout = async () => { await flushPendingSaves("now"); await api.logout().catch(() => undefined); navigate("/login", { replace: true }); };
  if (!ready) return <main className="app-loading"><span className="loading-ring" /><span>正在进入你的空间……</span></main>;
  const currentNotebook = notebookId ? notebooks.find((notebook) => notebook.id === notebookId) : undefined;
  const renderedNote = selectedNote && selectedRef.current?.id === selectedNote.id ? selectedRef.current : selectedNote;
  return <div className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${focusMode ? "is-focus-mode" : ""}`}>
    <button className={`mobile-scrim ${mobileSidebarOpen || mobileListOpen ? "is-visible" : ""}`} type="button" aria-label="关闭导航" onClick={() => { setMobileSidebarOpen(false); setMobileListOpen(false); }} />
    <Sidebar view={view} setView={selectView} notebooks={notebooks} notebookId={notebookId} setNotebookId={selectNotebook} query={query} setQuery={changeQuery} searchRef={searchRef} onNewNote={() => void createNoteHere()} onCreateNotebook={() => void createNotebook()} onEditNotebook={(target) => setEditingNotebook(target)} collapsed={sidebarCollapsed} onCollapse={() => setSidebarCollapsed((value) => !value)} mobileOpen={mobileSidebarOpen} onLogout={logout} />
    <NoteListPanel notes={notes} total={totalNotes} sort={noteSort} setSort={setNoteSort} selectedId={selectedId} onSelect={(id) => { selectNote(id); setMobileListOpen(false); }} view={view} query={query} currentNotebookName={currentNotebook?.name} onEmptyTrash={view === "trash" ? emptyTrash : undefined} trashBusy={pendingTrashCount > 0 || emptyingTrash} onNewNote={currentNotebook ? () => void createNoteHere() : undefined} onClearQuery={() => changeQuery("")} mobileOpen={mobileListOpen} onOpenSidebar={() => setMobileSidebarOpen(true)} />
    <main className="editor-region">
      {renderedNote ? <Suspense fallback={<NoteLoadingState />}><LazyNoteEditor note={renderedNote} saveState={saveState} isLoading={isNoteLoading} trashBusy={emptyingTrash || (pendingTrashCount > 0 && trashOperationsRef.current.has(renderedNote.id))} reloadToken={noteReloadToken} focusRequested={editorFocusNoteId === renderedNote.id && !commandOpen} onFocusHandled={handleEditorFocus} onChange={onNoteChange} onSaveNow={saveNoteNow} onReloadNote={requestConflictReload} onShare={() => setShareOpen(true)} onToggleFavorite={toggleFavorite} onMoveToTrash={moveToTrash} onRestore={restoreFromTrash} onPermanentDelete={permanentDeleteNote} onOpenList={() => setMobileListOpen(true)} focusMode={focusMode} onToggleFocusMode={toggleFocusMode} /></Suspense> : isNoteLoading ? <NoteLoadingState /> : <EmptyEditor isTrash={view === "trash"} onNewNote={() => void createNoteHere()} onOpenList={() => setMobileListOpen(true)} />}
    </main>
    <CommandMenu open={commandOpen} onClose={() => setCommandOpen(false)} onCommand={command} onCreateNoteInNotebook={createNoteInNotebook} canRestore={Boolean(renderedNote?.deletedAt)} notebooks={notebooks} focusMode={focusMode} />
    {shareOpen && renderedNote && <ShareDialog note={renderedNote} onClose={() => setShareOpen(false)} onToast={setToast} />}
    {editingNotebook !== undefined && <NotebookDialog key={editingNotebook?.id ?? "new"} notebook={editingNotebook} onClose={() => setEditingNotebook(undefined)} onSaved={saveNotebook} onRequestDelete={(target) => requestConfirm({ eyebrow: "整理上下文", title: `删除笔记本“${target.name}”？`, description: "笔记本中的笔记会自动移入收件箱，笔记内容不会被删除。", confirmLabel: "删除笔记本", danger: true, onConfirm: () => void deleteNotebook(target.id) })} onToast={setToast} />}
    {confirmRequest && <ConfirmDialog key={confirmRequest.id} request={confirmRequest} onClose={() => setConfirmRequest(null)} />}
    {toast && <div className="toast" role="status">{toast}</div>}
  </div>;
}

function Sidebar({ view, setView, notebooks, notebookId, setNotebookId, query, setQuery, searchRef, onNewNote, onCreateNotebook, onEditNotebook, collapsed, onCollapse, mobileOpen, onLogout }: { view: NoteView; setView: (view: NoteView) => void; notebooks: Notebook[]; notebookId?: string; setNotebookId: (id: string) => void; query: string; setQuery: (query: string) => void; searchRef: React.RefObject<HTMLInputElement | null>; onNewNote: () => void; onCreateNotebook: () => void; onEditNotebook: (notebook: Notebook) => void; collapsed: boolean; onCollapse: () => void; mobileOpen: boolean; onLogout: () => void }) {
  const notebookListRef = useRef<HTMLDivElement>(null);

  return <aside className={`sidebar ${mobileOpen ? "is-mobile-open" : ""}`} aria-label="主导航">
    <div className="brand-row"><BrandMark /><span className="brand-name">象映笔记</span><button className="icon-button collapse-button" type="button" onClick={onCollapse} aria-label={collapsed ? "展开侧栏" : "收起侧栏"}><LayoutPanelLeft size={18} /></button></div>
    <button className="primary-button new-note-button" type="button" onClick={onNewNote}><Plus size={18} />新建笔记</button>
    <label className="search-box"><Search size={17} /><input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索笔记……" aria-label="搜索笔记" />{query ? <button className="search-clear" type="button" aria-label="清空搜索" title="清空搜索" onClick={() => setQuery("")}><X size={15} /></button> : <kbd>{modKey} /</kbd>}</label>
    <nav className="main-nav"><ul>{navItems.map((item) => { const Icon = item.icon; return <li key={item.id}><button className={`nav-item ${view === item.id && !notebookId ? "is-active" : ""}`} type="button" onClick={() => setView(item.id)}><Icon size={18} /><span>{item.label}</span></button></li>; })}</ul></nav>
    <div className="notebook-section">
      <div className="section-heading"><span>笔记本</span><button className="icon-button tiny-button" type="button" aria-label="新建笔记本" title="新建笔记本" onClick={onCreateNotebook}><Plus size={16} /></button></div>
      <div className="notebook-list-scroll-shell">
        <div id="notebook-list-scroll-region" className="notebook-list-scroll floating-scrollbar-target" ref={notebookListRef}>
          <ul>{notebooks.map((notebook) => <li key={notebook.id} className="notebook-row-item"><div className={`notebook-row-wrap ${notebook.id === notebookId ? "is-active" : ""}`}><button className="notebook-item" type="button" aria-label={`${notebook.name}，${notebook.count} 篇笔记`} onClick={() => setNotebookId(notebook.id)}><span className="notebook-dot" style={{ background: notebook.color }} /><span>{notebook.name}</span><em>{notebook.count}</em></button>{notebook.isSystem ? <span className="notebook-edit-spacer" aria-hidden="true" /> : <button className="icon-button tiny-button notebook-edit-button" type="button" aria-label={`管理笔记本“${notebook.name}”`} title="管理笔记本" onClick={(e) => { e.stopPropagation(); onEditNotebook(notebook); }}><Pencil size={12} /></button>}</div></li>)}</ul>
        </div>
        <FloatingScrollbar scrollTargetRef={notebookListRef} controlsId="notebook-list-scroll-region" ariaLabel="笔记本列表滚动条" placement="left" />
      </div>
    </div>
    <div className="sidebar-bottom"><button className="nav-item" type="button" onClick={onLogout}><LogOut size={18} /><span>退出登录</span></button><div className="sidebar-hint"><span className="status-pulse" />数据安全保存在你的空间</div></div>
  </aside>;
}

function NoteListPanel({ notes, total, sort, setSort, selectedId, onSelect, view, query, currentNotebookName, onNewNote, onEmptyTrash, trashBusy, onClearQuery, mobileOpen, onOpenSidebar }: { notes: NoteSummary[]; total: number; sort: NoteSort; setSort: (sort: NoteSort) => void; selectedId: string | null; onSelect: (id: string) => void; view: NoteView; query: string; currentNotebookName?: string; onNewNote?: () => void; onEmptyTrash?: () => void; trashBusy: boolean; onClearQuery: () => void; mobileOpen: boolean; onOpenSidebar: () => void }) {
  const [sortOpen, setSortOpen] = useState(false);
  const sortRef = useRef<HTMLDivElement>(null);
  const noteListRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!sortOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !sortRef.current?.contains(event.target)) setSortOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSortOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [sortOpen]);

  const sortedNotes = useMemo(() => sortNotes(notes, sort), [notes, sort]);

  const sortLabels: Record<"updated" | "created" | "title", string> = {
    updated: "最近更新",
    created: "创建时间",
    title: "标题排序",
  };

  const heading = query ? "搜索结果" : currentNotebookName ?? viewLabel(view);
  const truncated = total > notes.length;
  return <section className={`note-list-panel ${mobileOpen ? "is-mobile-open" : ""}`} aria-label="笔记列表">
    <header className="list-header">
      <button className="icon-button mobile-only" type="button" aria-label="打开导航" onClick={onOpenSidebar}><Menu size={20} /></button>
      <div className="list-header-main">
        <h2 tabIndex={-1}>{heading}</h2>
        <p>{query ? `包含“${query}”的笔记` : `${truncated ? total : notes.length} 篇笔记`}{truncated && <> · 已显示最近 {notes.length} 篇</>}</p>
      </div>
      <div className="list-header-controls">
        {onEmptyTrash && <button className="text-button text-danger empty-trash-button" type="button" onClick={onEmptyTrash} disabled={trashBusy || total === 0}><Trash2 size={15} aria-hidden="true" />清空回收站</button>}
        {onNewNote && <button className="icon-button list-new-note-button" type="button" aria-label={`在${currentNotebookName}中新建笔记`} title={`在${currentNotebookName}中新建笔记`} onClick={onNewNote}><Plus size={18} /></button>}
        <div className="sort-menu-wrap" ref={sortRef}>
          <button className="sort-button" type="button" aria-haspopup="listbox" aria-expanded={sortOpen} onClick={() => setSortOpen((open) => !open)}>
            {sortLabels[sort]} <ChevronDown size={15} />
          </button>
          {sortOpen && (
            <div className="sort-dropdown" role="listbox" aria-label="笔记排序方式">
              <button type="button" className={`sort-option ${sort === "updated" ? "is-active" : ""}`} onClick={() => { setSort("updated"); setSortOpen(false); }}>最近更新</button>
              <button type="button" className={`sort-option ${sort === "created" ? "is-active" : ""}`} onClick={() => { setSort("created"); setSortOpen(false); }}>创建时间</button>
              <button type="button" className={`sort-option ${sort === "title" ? "is-active" : ""}`} onClick={() => { setSort("title"); setSortOpen(false); }}>标题排序</button>
            </div>
          )}
        </div>
      </div>
    </header>
    <div className="note-list-scroll-shell">
      <div id="note-list-scroll-region" className="note-list floating-scrollbar-target" ref={noteListRef}>
        <ul className="note-list-items" role="list">
          {sortedNotes.map((note) => <li key={note.id}><button type="button" className={`note-row ${selectedId === note.id ? "is-selected" : ""}`} onClick={() => onSelect(note.id)}><span className="note-row-title">{note.title || "未命名笔记"}{note.isFavorite && <Star size={13} fill="currentColor" />}</span><span className="note-row-preview">{note.preview || "还没有内容，开始写下第一句话。"}</span><span className="note-row-meta"><span>{note.notebookName}</span><time>{relativeDate(note.updatedAt)}</time></span></button></li>)}
        </ul>
        {!sortedNotes.length && (query ? <div className="list-empty"><span className="empty-icon"><Search size={23} /></span><strong>没有找到匹配的笔记</strong><span>试试更短的关键词，或清空搜索查看全部内容。</span><button className="secondary-button" type="button" onClick={onClearQuery}>清空搜索</button></div> : <div className="list-empty"><span className="empty-icon"><Archive size={23} /></span><strong>{view === "trash" ? "回收站是空的" : "这里还没有笔记"}</strong><span>{view === "trash" ? "移入回收站的笔记会显示在这里。" : "按下“新建笔记”，让一个想法有地方落脚。"}</span></div>)}
      </div>
      <FloatingScrollbar scrollTargetRef={noteListRef} controlsId="note-list-scroll-region" ariaLabel="笔记列表滚动条" placement="left" />
    </div>
  </section>;
}

function EmptyEditor({ isTrash, onNewNote, onOpenList }: { isTrash: boolean; onNewNote: () => void; onOpenList: () => void }) { return <section className="empty-editor"><button className="icon-button mobile-only empty-back" type="button" aria-label="打开笔记列表" onClick={onOpenList}><ChevronLeft size={20} /></button><BrandMark className="empty-editor-mark" /><h1 tabIndex={-1}>{isTrash ? "回收站是空的" : "让想法有地方落脚"}</h1><p>{isTrash ? "没有需要清理或恢复的笔记。" : "创建一篇笔记，记录此刻值得留下的东西。"}</p>{!isTrash && <><button className="primary-button" type="button" onClick={onNewNote}><Plus size={18} />新建笔记</button><span className="empty-shortcut">或按 {modKey} / 打开命令菜单</span></>}</section>; }

function ShareDialog({ note, onClose, onToast }: { note: Note; onClose: () => void; onToast: (message: string) => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const shareUrlRef = useRef<HTMLInputElement>(null);
  const [shares, setShares] = useState<Share[]>([]);
  const [newUrl, setNewUrl] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { const dialog = dialogRef.current; if (!dialog) return; dialog.showModal(); void api.listShares(note.id).then((result) => setShares(result.shares)).catch(() => onToast("加载分享记录失败")); return () => { if (dialog.open) dialog.close(); }; }, [note.id]);
  const create = async () => { setBusy(true); try { const result = await api.createShare(note.id); setShares((current) => [result.share, ...current]); setNewUrl(result.share.url ?? ""); onToast("分享链接已生成"); } catch { onToast("生成分享链接失败"); } finally { setBusy(false); } };
  const copy = async (url: string) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard-unavailable");
      await navigator.clipboard.writeText(url);
      onToast("链接已复制");
    } catch {
      shareUrlRef.current?.select();
      onToast("复制失败，请手动复制选中的链接");
    }
  };
  const revoke = async (id: string) => {
    try {
      await api.revokeShare(id);
      setShares((current) => current.map((share) => share.id === id ? { ...share, revokedAt: Math.floor(Date.now() / 1000) } : share));
      onToast("分享已撤销");
    } catch {
      onToast("撤销分享失败，请重试");
    }
  };
  return <dialog ref={dialogRef} className="share-dialog" aria-labelledby="share-dialog-title" aria-describedby="share-dialog-description" onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <div className="dialog-heading share-dialog-heading">
      <div><span className="dialog-eyebrow"><Share2 size={15} />只读快照</span><h2 id="share-dialog-title">分享这篇笔记</h2><p id="share-dialog-description">生成一个 7 天有效的公开阅读链接。</p></div>
      <button className="icon-button" type="button" aria-label="关闭分享窗口" onClick={onClose}><X size={18} /></button>
    </div>
    <div className="share-note-context"><span className="share-note-context-icon"><FileText size={18} /></span><div><strong>{note.title || "未命名笔记"}</strong><span>公开只读 · 快照有效 7 天</span></div></div>
    {newUrl && <div className="share-result"><span className="share-result-icon"><Link2 size={18} /></span><div><strong>链接已准备好</strong><input ref={shareUrlRef} value={newUrl} readOnly aria-label="分享链接" /></div><button className="secondary-button" type="button" onClick={() => void copy(newUrl)}>复制</button></div>}
    <div className="share-dialog-actions"><button className="primary-button share-create-button" type="button" onClick={() => void create()} disabled={busy}><Plus size={18} />{busy ? "正在生成……" : "生成新链接"}</button><p>快照创建后保持不变，原笔记的后续修改不会影响分享内容。</p></div>
    {shares.length > 0 && <div className="share-history"><div className="share-history-heading"><h3>分享记录</h3><span>{shares.length}</span></div>{shares.map((share) => <div className="share-history-row" key={share.id}><span className={`share-status-dot ${share.revokedAt || share.expiresAt * 1000 < Date.now() ? "is-inactive" : ""}`} /><span>{share.revokedAt ? "已撤销" : share.expiresAt * 1000 < Date.now() ? "已过期" : `有效至 ${formatDate(share.expiresAt)}`}</span>{!share.revokedAt && share.expiresAt * 1000 >= Date.now() && <button className="text-button" type="button" onClick={() => void revoke(share.id)}>撤销</button>}</div>)}</div>}
  </dialog>;
}

function NotebookDialog({ notebook, onClose, onSaved, onRequestDelete, onToast }: { notebook?: Notebook | null; onClose: () => void; onSaved: (notebook: Notebook) => void; onRequestDelete?: (notebook: Notebook) => void; onToast: (message: string) => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(notebook?.name ?? "");
  const [color, setColor] = useState(notebook?.color ?? "#718077");
  const [colorError, setColorError] = useState("");
  const [busy, setBusy] = useState(false);
  const isEditing = Boolean(notebook);
  useEffect(() => { const dialog = dialogRef.current; if (!dialog) return; dialog.showModal(); requestAnimationFrame(() => inputRef.current?.focus()); return () => { if (dialog.open) dialog.close(); }; }, []);
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = name.trim();
    const normalizedColor = color.trim().toLowerCase();
    if (!trimmed) return;
    if (!/^#[0-9a-f]{6}$/i.test(normalizedColor)) {
      setColorError("请输入 6 位十六进制颜色，例如 #718077");
      return;
    }
    setColorError("");
    setBusy(true);
    try {
      if (isEditing && notebook) {
        const result = await api.updateNotebook(notebook.id, { name: trimmed, color: normalizedColor });
        onSaved(result.notebook);
      } else {
        const result = await api.createNotebook({ name: trimmed, color: normalizedColor });
        onSaved(result.notebook);
      }
      onClose();
    } catch (reason) {
      onToast(errorMessage(reason, isEditing ? "更新笔记本失败" : "创建笔记本失败"));
    } finally { setBusy(false); }
  };
  const handleDelete = () => {
    if (!notebook || !onRequestDelete) return;
    onRequestDelete(notebook);
  };
  return <dialog ref={dialogRef} className="notebook-dialog" onCancel={(event) => { event.preventDefault(); onClose(); }}><form onSubmit={(event) => void submit(event)}><div className="dialog-heading"><div><span className="dialog-eyebrow"><Folder size={15} />整理上下文</span><h2>{isEditing ? "编辑笔记本" : "新建笔记本"}</h2><p>{isEditing ? "修改笔记本名称或管理该分类。" : "给一组想法一个清晰的落点。"}</p></div><button className="icon-button" type="button" aria-label="关闭新建笔记本窗口" onClick={onClose}><X size={18} /></button></div><label className="dialog-field"><span>名称</span><input ref={inputRef} value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：项目资料" maxLength={40} autoComplete="off" /></label><fieldset className="notebook-color-field"><legend>颜色</legend><div className="notebook-color-options" role="radiogroup" aria-label="选择笔记本颜色">{notebookColorOptions.map((option) => <button key={option} className="notebook-color-option" type="button" role="radio" aria-checked={color.toLowerCase() === option} aria-label={`选择颜色 ${option}`} onClick={() => { setColor(option); setColorError(""); }}><span className="notebook-color-swatch" style={{ backgroundColor: option }} /></button>)}</div><label className="notebook-color-custom"><span>自定义色值</span><input value={color} onChange={(event) => { setColor(event.target.value); setColorError(""); }} placeholder="#718077" maxLength={7} inputMode="text" spellCheck={false} aria-invalid={Boolean(colorError)} aria-describedby={colorError ? "notebook-color-error" : undefined} /></label>{colorError && <span className="dialog-error" id="notebook-color-error" role="alert">{colorError}</span>}</fieldset><div className="dialog-actions">{isEditing && !notebook?.isSystem && onRequestDelete && <button className="text-button text-danger" type="button" onClick={handleDelete} disabled={busy} style={{ marginRight: "auto" }}>删除笔记本</button>}<button className="secondary-button" type="button" onClick={onClose}>取消</button><button className="primary-button" type="submit" disabled={busy || !name.trim()}>{busy ? "正在保存……" : isEditing ? "保存修改" : "创建笔记本"}</button></div></form></dialog>;
}

function viewLabel(view: NoteView) { return ({ all: "全部笔记", inbox: "收件箱", favorites: "收藏", shared: "已分享", trash: "回收站" })[view]; }
function relativeDate(timestamp: number) { const delta = Math.floor(Date.now() / 1000) - timestamp; if (delta < 60) return "刚刚"; if (delta < 3600) return `${Math.floor(delta / 60)} 分钟前`; if (delta < 86400) return `${Math.floor(delta / 3600)} 小时前`; return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(timestamp * 1000)); }
function formatDate(timestamp: number) { return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(timestamp * 1000)); }
