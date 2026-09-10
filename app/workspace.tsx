import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Archive, ChevronDown, ChevronLeft, FileText, Folder, Inbox, LayoutPanelLeft, Link2, LogOut, Menu, Pencil, Plus, RefreshCw, Search, Share2, Star, Trash2, UsersRound, X } from "lucide-react";
import { useNavigate } from "react-router";
import { ApiError, api } from "./api";
import { CommandId, CommandMenu } from "./command-menu";
import type { CreateNoteCommand } from "./command-parser";
import { BrandMark } from "./brand-mark";
import { NoteEditor, NoteLoadingState } from "./editor";
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

function noteSavePayload(draft: Note) {
  return { version: draft.version, title: draft.title, contentMarkdown: draft.contentMarkdown, notebookId: draft.notebookId, isFavorite: draft.isFavorite, deleted: Boolean(draft.deletedAt) };
}

type ConfirmRequest = {
  id: number;
  eyebrow: string;
  title: string;
  description: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
};

function ConfirmDialog({ request, onClose }: { request: ConfirmRequest; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = dialogRef.current; if (!dialog) return; dialog.showModal(); return () => { if (dialog.open) dialog.close(); }; }, []);
  return <dialog ref={dialogRef} className="confirm-dialog" aria-labelledby="confirm-dialog-title" aria-describedby="confirm-dialog-description" onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <div className="dialog-heading">
      <div>
        <span className={`dialog-eyebrow ${request.danger ? "is-danger" : ""}`}>{request.danger ? <AlertTriangle size={15} /> : <RefreshCw size={15} />}{request.eyebrow}</span>
        <h2 id="confirm-dialog-title">{request.title}</h2>
        <p id="confirm-dialog-description">{request.description}</p>
      </div>
    </div>
    <div className="dialog-actions">
      <button className="secondary-button" type="button" onClick={onClose}>取消</button>
      <button className={`primary-button ${request.danger ? "danger-primary" : ""}`} type="button" onClick={() => { request.onConfirm(); onClose(); }}>{request.confirmLabel}</button>
    </div>
  </dialog>;
}

export function Workspace() {
  const navigate = useNavigate();
  const [view, setView] = useState<NoteView>("all");
  const [notebookId, setNotebookId] = useState<string>();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [notesReloadToken, setNotesReloadToken] = useState(0);
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedNote, setSelectedNote] = useState<Note | null>(null);
  const selectedRef = useRef<Note | null>(null);
  const activeNoteIdRef = useRef<string | null>(null);
  const noteLoadRequestRef = useRef(0);
  const saveTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const pendingSavesRef = useRef(new Map<string, Note>());
  const searchRef = useRef<HTMLInputElement>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "conflict" | "error">("idle");
  const [isNoteLoading, setIsNoteLoading] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
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
    setConfirmRequest({ ...request, id: confirmIdRef.current });
  }, []);

  useEffect(() => { selectedRef.current = selectedNote; }, [selectedNote]);
  useEffect(() => { void api.bootstrap().then(async (status) => { if (!status.configured) { navigate("/setup", { replace: true }); return; } try { await api.me(); setReady(true); } catch { navigate("/login", { replace: true }); } }).catch(() => navigate("/login", { replace: true })); }, [navigate]);

  const loadNotes = useCallback(async () => {
    try {
      const result = await api.listNotes({ view, query: deferredQuery, notebookId });
      setNotes(result.notes);
      setSelectedId((current) => current && result.notes.some((note) => note.id === current) ? current : result.notes[0]?.id ?? null);
    } catch (reason) { if (reason instanceof ApiError && reason.status === 401) navigate("/login", { replace: true }); }
  }, [deferredQuery, navigate, notebookId, notesReloadToken, view]);
  const reloadNotes = useCallback(() => setNotesReloadToken((value) => value + 1), []);
  const removeFromList = useCallback((noteId: string) => { setNotes((current) => current.filter((note) => note.id !== noteId)); }, []);
  const loadSelectedNote = useCallback(async (id: string) => {
    const requestId = ++noteLoadRequestRef.current;
    const previousNote = selectedRef.current;
    const pendingNote = pendingSavesRef.current.get(id);
    activeNoteIdRef.current = id;
    selectedRef.current = null;
    setIsNoteLoading(true);
    setSaveState(pendingNote ? "saving" : "idle");
    try {
      const result = await api.getNote(id);
      if (requestId !== noteLoadRequestRef.current || activeNoteIdRef.current !== id) return;
      const nextNote = pendingSavesRef.current.get(id) ?? result.note;
      selectedRef.current = nextNote;
      setSelectedNote(nextNote);
      setIsNoteLoading(false);
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
  useEffect(() => { if (!ready) return; void api.listNotebooks().then((result) => setNotebooks(result.notebooks)); }, [ready]);
  useEffect(() => { if (!ready) return; const timer = setTimeout(() => void loadNotes(), 180); return () => clearTimeout(timer); }, [loadNotes, ready]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isMod = event.ctrlKey || event.metaKey;
      if (isMod && (event.key === "/" || event.key === "k" || event.key === "K")) {
        event.preventDefault();
        setCommandOpen(true);
      } else if (isMod && event.key === "\\") {
        event.preventDefault();
        setSidebarCollapsed((value) => !value);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(""), 3000); return () => clearTimeout(timer); }, [toast]);

  const persistRef = useRef<(draft: Note) => void>(() => undefined);
  const runSave = useCallback(async (draft: Note) => {
    try {
      const result = await api.updateNote(draft.id, noteSavePayload(draft));
      setNotes((current) => current.map((note) => note.id === result.note.id ? { ...note, ...result.note } : note));
      if (activeNoteIdRef.current !== draft.id) return;
      const latestDraft = pendingSavesRef.current.get(draft.id);
      if (latestDraft && latestDraft.title === draft.title && latestDraft.contentMarkdown === draft.contentMarkdown && latestDraft.notebookId === draft.notebookId && latestDraft.isFavorite === draft.isFavorite && latestDraft.deletedAt === draft.deletedAt && latestDraft.version === draft.version) {
        pendingSavesRef.current.delete(draft.id);
        setSelectedNote(result.note);
        selectedRef.current = result.note;
        setSaveState("saved");
      } else if (latestDraft) {
        const nextDraft = { ...latestDraft, version: result.note.version };
        pendingSavesRef.current.set(draft.id, nextDraft);
        setSelectedNote((current) => current?.id === draft.id ? { ...current, version: result.note.version } : current);
        selectedRef.current = selectedRef.current?.id === draft.id ? { ...selectedRef.current, version: result.note.version } : selectedRef.current;
        persistRef.current(nextDraft);
      }
    } catch (reason) { if (activeNoteIdRef.current !== draft.id) return; if (reason instanceof ApiError && reason.code === "VERSION_CONFLICT") { setSaveState("conflict"); setToast("这篇笔记已在别处更新，请重新载入"); } else { setSaveState("error"); setToast("保存失败，请检查网络后重试"); } }
  }, []);
  const persist = useCallback((draft: Note) => {
    pendingSavesRef.current.set(draft.id, draft);
    if (activeNoteIdRef.current === draft.id) setSaveState("saving");
    const existingTimer = saveTimersRef.current.get(draft.id);
    if (existingTimer) clearTimeout(existingTimer);
    const timer = setTimeout(() => {
      saveTimersRef.current.delete(draft.id);
      const requestDraft = pendingSavesRef.current.get(draft.id);
      if (!requestDraft) return;
      void runSave(requestDraft);
    }, 800);
    saveTimersRef.current.set(draft.id, timer);
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
    void runSave(pending);
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
      if (mode === "keepalive") {
        pendingSavesRef.current.delete(id);
        await api.updateNote(id, noteSavePayload(draft), { keepalive: true }).catch(() => undefined);
        return;
      }
      await runSave(draft);
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
    pendingSavesRef.current.clear();
  }, [flushPendingSaves]);
  const refreshNotebooks = useCallback(() => { void api.listNotebooks().then((result) => setNotebooks(result.notebooks)); }, []);
  const onNoteChange = useCallback((patch: { title?: string; contentMarkdown?: string; notebookId?: string }) => {
    const current = selectedRef.current;
    if (!current) return;
    if ((patch.title === undefined || patch.title === current.title) && (patch.contentMarkdown === undefined || patch.contentMarkdown === current.contentMarkdown) && (patch.notebookId === undefined || patch.notebookId === current.notebookId)) return;
    const targetNotebook = patch.notebookId ? notebooks.find((nb) => nb.id === patch.notebookId) : undefined;
    const next = { ...current, ...patch, ...(targetNotebook ? { notebookName: targetNotebook.name } : {}) };
    selectedRef.current = next;
    setSelectedNote(next);
    persist(next);
    if (patch.notebookId && patch.notebookId !== current.notebookId) {
      refreshNotebooks();
      setToast(targetNotebook ? `已移至“${targetNotebook.name}”` : "已变更所属笔记本");
    }
  }, [notebooks, persist, refreshNotebooks]);
  const revealCreatedNote = useCallback((note: Note, target: { view: NoteView; notebookId?: string }, message: string) => {
    setView(target.view);
    setNotebookId(target.notebookId);
    setQuery("");
    setNotes((current) => [note, ...current.filter((currentNote) => currentNote.id !== note.id)]);
    setSelectedNote(note);
    selectedRef.current = note;
    activeNoteIdRef.current = note.id;
    pendingSavesRef.current.delete(note.id);
    setSelectedId(note.id);
    setMobileListOpen(false);
    setToast(message);
  }, []);
  const createNoteInInbox = useCallback(async () => {
    try {
      const result = await api.createNote({});
      revealCreatedNote(result.note, { view: "inbox" }, "已在收件箱中创建新笔记");
      refreshNotebooks();
    } catch { setToast("创建笔记失败"); }
  }, [refreshNotebooks, revealCreatedNote]);
  const createNoteInCurrentNotebook = useCallback(async () => {
    const currentNotebook = notebookId ? notebooks.find((notebook) => notebook.id === notebookId) : undefined;
    if (!currentNotebook) {
      await createNoteInInbox();
      return;
    }
    try {
      const result = await api.createNote({ notebookId: currentNotebook.id });
      revealCreatedNote(result.note, { view: "all", notebookId: currentNotebook.id }, `已在“${currentNotebook.name}”中创建新笔记`);
      refreshNotebooks();
    } catch { setToast("创建笔记失败"); }
  }, [createNoteInInbox, notebookId, notebooks, refreshNotebooks, revealCreatedNote]);
  const createNoteInNotebook = useCallback(async (commandToCreate: CreateNoteCommand) => { try { const result = await api.createNote({ notebookId: commandToCreate.notebookId, title: commandToCreate.title }); revealCreatedNote(result.note, { view: "all", notebookId: commandToCreate.notebookId }, `已在“${commandToCreate.notebookName}”中创建“${commandToCreate.title}”`); refreshNotebooks(); } catch (reason) { if (reason instanceof ApiError && reason.status === 401) navigate("/login", { replace: true }); setToast("创建笔记失败，请稍后重试"); } }, [navigate, refreshNotebooks, revealCreatedNote]);
  const createNotebook = useCallback(() => setEditingNotebook(null), []);
  const saveNotebook = useCallback((saved: Notebook) => {
    setNotebooks((current) => {
      const exists = current.some((nb) => nb.id === saved.id);
      return exists ? current.map((nb) => nb.id === saved.id ? { ...nb, name: saved.name, color: saved.color } : nb) : [...current, saved];
    });
    if (editingNotebook) {
      if (selectedNote?.notebookId === saved.id) {
        setSelectedNote((prev) => prev ? { ...prev, notebookName: saved.name } : prev);
      }
      setToast(`已更新笔记本“${saved.name}”`);
    } else {
      setNotebookId(saved.id);
      setView("all");
      setMobileSidebarOpen(false);
      setToast(`已创建笔记本“${saved.name}”`);
    }
    setEditingNotebook(undefined);
  }, [editingNotebook, selectedNote?.notebookId]);
  const deleteNotebook = useCallback(async (id: string) => {
    try {
      await api.deleteNotebook(id);
      setNotebooks((current) => current.filter((nb) => nb.id !== id));
      if (notebookId === id) setNotebookId(undefined);
      refreshNotebooks();
      void loadNotes();
      setToast("已删除笔记本，原笔记已归入收件箱");
      setEditingNotebook(undefined);
    } catch {
      setToast("删除笔记本失败");
    }
  }, [loadNotes, notebookId, refreshNotebooks]);
  const toggleFavorite = useCallback(() => { const current = selectedRef.current; if (!current) return; const next = { ...current, isFavorite: !current.isFavorite }; selectedRef.current = next; setSelectedNote(next); persist(next); if (view === "favorites" && !next.isFavorite) removeFromList(current.id); }, [persist, removeFromList, view]);
  const moveToTrash = useCallback(() => { const current = selectedRef.current; if (!current) return; const next = { ...current, deletedAt: Math.floor(Date.now() / 1000) }; selectedRef.current = next; setSelectedNote(next); persist(next); removeFromList(current.id); refreshNotebooks(); setToast("已移入回收站"); }, [persist, refreshNotebooks, removeFromList]);
  const restoreFromTrash = useCallback(() => { const current = selectedRef.current; if (!current) return; const next = { ...current, deletedAt: null }; selectedRef.current = next; setSelectedNote(next); persist(next); setView("all"); setNotebookId(undefined); refreshNotebooks(); reloadNotes(); setToast("已恢复笔记"); }, [persist, refreshNotebooks, reloadNotes]);
  const performPermanentDelete = useCallback(async (noteId: string) => {
    try {
      await api.deleteNote(noteId);
      setNotes((prev) => prev.filter((note) => note.id !== noteId));
      setSelectedId(null);
      setSelectedNote(null);
      selectedRef.current = null;
      activeNoteIdRef.current = null;
      pendingSavesRef.current.delete(noteId);
      const timer = saveTimersRef.current.get(noteId);
      if (timer) clearTimeout(timer);
      saveTimersRef.current.delete(noteId);
      setToast("已彻底删除笔记");
      refreshNotebooks();
    } catch {
      setToast("彻底删除笔记失败，请重试");
    }
  }, [refreshNotebooks]);
  const permanentDeleteNote = useCallback(async () => {
    const current = selectedRef.current;
    if (!current) return;
    requestConfirm({
      eyebrow: "不可撤销",
      title: `彻底删除“${current.title.trim() || "未命名笔记"}”？`,
      description: "这篇笔记会从数据库中永久移除，回收站不再保留，已生成的分享链接也会同时失效。",
      confirmLabel: "彻底删除",
      danger: true,
      onConfirm: () => void performPermanentDelete(current.id),
    });
  }, [performPermanentDelete, requestConfirm]);
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
  const command = useCallback((id: CommandId) => { if (id === "new-note") void createNoteInInbox(); if (id === "search") { setView("all"); setMobileSidebarOpen(true); requestAnimationFrame(() => searchRef.current?.focus()); } if (id === "toggle-sidebar") setSidebarCollapsed((value) => !value); if (id === "share" && selectedNote) setShareOpen(true); if (id === "favorite") toggleFavorite(); if (id === "trash") moveToTrash(); if (id === "restore") restoreFromTrash(); }, [createNoteInInbox, moveToTrash, restoreFromTrash, selectedNote, toggleFavorite]);
  const logout = async () => { await flushPendingSaves("now"); await api.logout().catch(() => undefined); navigate("/login", { replace: true }); };
  if (!ready) return <main className="app-loading"><span className="loading-ring" /><span>正在进入你的空间……</span></main>;
  const currentNotebook = notebookId ? notebooks.find((notebook) => notebook.id === notebookId) : undefined;
  return <div className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
    <button className={`mobile-scrim ${mobileSidebarOpen || mobileListOpen ? "is-visible" : ""}`} type="button" aria-label="关闭导航" onClick={() => { setMobileSidebarOpen(false); setMobileListOpen(false); }} />
    <Sidebar view={view} setView={(next) => { setView(next); setNotebookId(undefined); setMobileSidebarOpen(false); }} notebooks={notebooks} notebookId={notebookId} setNotebookId={(id) => { setNotebookId(id); setView("all"); setMobileSidebarOpen(false); }} query={query} setQuery={setQuery} searchRef={searchRef} onNewNote={() => void createNoteInInbox()} onCreateNotebook={() => void createNotebook()} onEditNotebook={(target) => setEditingNotebook(target)} collapsed={sidebarCollapsed} onCollapse={() => setSidebarCollapsed((value) => !value)} mobileOpen={mobileSidebarOpen} onLogout={logout} />
    <NoteListPanel notes={notes} selectedId={selectedId} onSelect={(id) => { setSelectedId(id); setMobileListOpen(false); }} view={view} query={query} currentNotebookName={currentNotebook?.name} onNewNote={currentNotebook ? () => void createNoteInCurrentNotebook() : undefined} mobileOpen={mobileListOpen} onOpenSidebar={() => setMobileSidebarOpen(true)} />
    <main className="editor-region">
      {selectedNote ? <NoteEditor note={selectedNote} saveState={saveState} isLoading={isNoteLoading} reloadToken={noteReloadToken} onChange={onNoteChange} onSaveNow={saveNoteNow} onReloadNote={requestConflictReload} onShare={() => setShareOpen(true)} onToggleFavorite={toggleFavorite} onMoveToTrash={moveToTrash} onRestore={restoreFromTrash} onPermanentDelete={permanentDeleteNote} onOpenList={() => setMobileListOpen(true)} /> : isNoteLoading ? <NoteLoadingState /> : <EmptyEditor onNewNote={() => void createNoteInCurrentNotebook()} onOpenList={() => setMobileListOpen(true)} />}
    </main>
    <CommandMenu open={commandOpen} onClose={() => setCommandOpen(false)} onCommand={command} onCreateNoteInNotebook={createNoteInNotebook} canRestore={Boolean(selectedNote?.deletedAt)} notebooks={notebooks} />
    {shareOpen && selectedNote && <ShareDialog note={selectedNote} onClose={() => setShareOpen(false)} onToast={setToast} />}
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
    <label className="search-box"><Search size={17} /><input ref={searchRef} value={query} onChange={(event) => { setQuery(event.target.value); setView("all"); }} placeholder="搜索笔记……" aria-label="搜索笔记" /><kbd>{modKey} /</kbd></label>
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

function NoteListPanel({ notes, selectedId, onSelect, view, query, currentNotebookName, onNewNote, mobileOpen, onOpenSidebar }: { notes: NoteSummary[]; selectedId: string | null; onSelect: (id: string) => void; view: NoteView; query: string; currentNotebookName?: string; onNewNote?: () => void; mobileOpen: boolean; onOpenSidebar: () => void }) {
  const [sort, setSort] = useState<"updated" | "created" | "title">("updated");
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

  const sortedNotes = useMemo(() => {
    const list = [...notes];
    if (sort === "created") return list.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    if (sort === "title") return list.sort((a, b) => (a.title || "未命名笔记").localeCompare(b.title || "未命名笔记", "zh-CN"));
    return list.sort((a, b) => b.updatedAt - a.updatedAt);
  }, [notes, sort]);

  const sortLabels: Record<"updated" | "created" | "title", string> = {
    updated: "最近更新",
    created: "创建时间",
    title: "标题排序",
  };

  const heading = query ? "搜索结果" : currentNotebookName ?? viewLabel(view);
  return <section className={`note-list-panel ${mobileOpen ? "is-mobile-open" : ""}`} aria-label="笔记列表">
    <header className="list-header">
      <button className="icon-button mobile-only" type="button" aria-label="打开导航" onClick={onOpenSidebar}><Menu size={20} /></button>
      <div className="list-header-main">
        <h2>{heading}</h2>
        <p>{query ? `包含“${query}”的笔记` : `${notes.length} 篇笔记`}</p>
      </div>
      <div className="list-header-controls">
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
      <div id="note-list-scroll-region" className="note-list floating-scrollbar-target" ref={noteListRef} role="list">
        {sortedNotes.map((note) => <button key={note.id} role="listitem" type="button" className={`note-row ${selectedId === note.id ? "is-selected" : ""}`} onClick={() => onSelect(note.id)}><span className="note-row-title">{note.title || "未命名笔记"}{note.isFavorite && <Star size={13} fill="currentColor" />}</span><span className="note-row-preview">{note.preview || "还没有内容，开始写下第一句话。"}</span><span className="note-row-meta"><span>{note.notebookName}</span><time>{relativeDate(note.updatedAt)}</time></span></button>)}
        {!sortedNotes.length && <div className="list-empty"><span className="empty-icon"><Archive size={23} /></span><strong>这里还没有笔记</strong><span>按下“新建笔记”，让一个想法有地方落脚。</span></div>}
      </div>
      <FloatingScrollbar scrollTargetRef={noteListRef} controlsId="note-list-scroll-region" ariaLabel="笔记列表滚动条" placement="left" />
    </div>
  </section>;
}

function EmptyEditor({ onNewNote, onOpenList }: { onNewNote: () => void; onOpenList: () => void }) { return <section className="empty-editor"><button className="icon-button mobile-only empty-back" type="button" aria-label="打开笔记列表" onClick={onOpenList}><ChevronLeft size={20} /></button><BrandMark className="empty-editor-mark" /><h1>让想法有地方落脚</h1><p>创建一篇笔记，记录此刻值得留下的东西。</p><button className="primary-button" type="button" onClick={onNewNote}><Plus size={18} />新建笔记</button><span className="empty-shortcut">或按 {modKey} / 打开命令菜单</span></section>; }

function ShareDialog({ note, onClose, onToast }: { note: Note; onClose: () => void; onToast: (message: string) => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [shares, setShares] = useState<Share[]>([]);
  const [newUrl, setNewUrl] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { const dialog = dialogRef.current; if (!dialog) return; dialog.showModal(); void api.listShares(note.id).then((result) => setShares(result.shares)); return () => { if (dialog.open) dialog.close(); }; }, [note.id]);
  const create = async () => { setBusy(true); try { const result = await api.createShare(note.id); setShares((current) => [result.share, ...current]); setNewUrl(result.share.url ?? ""); onToast("分享链接已生成"); } catch { onToast("生成分享链接失败"); } finally { setBusy(false); } };
  const copy = async (url: string) => { await navigator.clipboard?.writeText(url); onToast("链接已复制"); };
  const revoke = async (id: string) => { await api.revokeShare(id).catch(() => undefined); setShares((current) => current.map((share) => share.id === id ? { ...share, revokedAt: Math.floor(Date.now() / 1000) } : share)); onToast("分享已撤销"); };
  return <dialog ref={dialogRef} className="share-dialog" aria-labelledby="share-dialog-title" aria-describedby="share-dialog-description" onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <div className="dialog-heading share-dialog-heading">
      <div><span className="dialog-eyebrow"><Share2 size={15} />只读快照</span><h2 id="share-dialog-title">分享这篇笔记</h2><p id="share-dialog-description">生成一个 7 天有效的公开阅读链接。</p></div>
      <button className="icon-button" type="button" aria-label="关闭分享窗口" onClick={onClose}><X size={18} /></button>
    </div>
    <div className="share-note-context"><span className="share-note-context-icon"><FileText size={18} /></span><div><strong>{note.title || "未命名笔记"}</strong><span>公开只读 · 快照有效 7 天</span></div></div>
    {newUrl && <div className="share-result"><span className="share-result-icon"><Link2 size={18} /></span><div><strong>链接已准备好</strong><input value={newUrl} readOnly aria-label="分享链接" /></div><button className="secondary-button" type="button" onClick={() => void copy(newUrl)}>复制</button></div>}
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
    } catch {
      onToast(isEditing ? "更新笔记本失败" : "创建笔记本失败");
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
