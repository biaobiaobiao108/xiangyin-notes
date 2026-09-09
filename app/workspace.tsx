import { useCallback, useDeferredValue, useEffect, useRef, useState } from "react";
import { Archive, ChevronDown, ChevronLeft, FileText, Folder, Inbox, LayoutPanelLeft, Link2, LogOut, Menu, Pencil, Plus, Search, Share2, Star, Trash2, UsersRound, X } from "lucide-react";
import { useNavigate } from "react-router";
import { ApiError, api } from "./api";
import { CommandId, CommandMenu } from "./command-menu";
import type { CreateNoteCommand } from "./command-parser";
import { NoteEditor } from "./editor";
import type { Note, NoteSummary, NoteView, Notebook, Share } from "../shared/types";

const navItems: Array<{ id: NoteView; label: string; icon: typeof Inbox }> = [
  { id: "inbox", label: "收件箱", icon: Inbox },
  { id: "all", label: "全部笔记", icon: FileText },
  { id: "favorites", label: "收藏", icon: Star },
  { id: "shared", label: "已分享", icon: UsersRound },
  { id: "trash", label: "回收站", icon: Trash2 },
];

export function Workspace() {
  const navigate = useNavigate();
  const [view, setView] = useState<NoteView>("all");
  const [notebookId, setNotebookId] = useState<string>();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedNote, setSelectedNote] = useState<Note | null>(null);
  const selectedRef = useRef<Note | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<Note | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "conflict" | "error">("idle");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [mobileListOpen, setMobileListOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [editingNotebook, setEditingNotebook] = useState<Notebook | null | undefined>(undefined);
  const [toast, setToast] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => { selectedRef.current = selectedNote; }, [selectedNote]);
  useEffect(() => { void api.bootstrap().then(async (status) => { if (!status.configured) { navigate("/setup", { replace: true }); return; } try { await api.me(); setReady(true); } catch { navigate("/login", { replace: true }); } }).catch(() => navigate("/login", { replace: true })); }, [navigate]);

  const loadNotes = useCallback(async () => {
    try {
      const result = await api.listNotes({ view, query: deferredQuery, notebookId });
      setNotes(result.notes);
      setSelectedId((current) => current && result.notes.some((note) => note.id === current) ? current : result.notes[0]?.id ?? null);
    } catch (reason) { if (reason instanceof ApiError && reason.status === 401) navigate("/login", { replace: true }); }
  }, [deferredQuery, navigate, notebookId, view]);
  useEffect(() => { if (!ready) return; void api.listNotebooks().then((result) => setNotebooks(result.notebooks)); }, [ready]);
  useEffect(() => { if (!ready) return; const timer = setTimeout(() => void loadNotes(), 180); return () => clearTimeout(timer); }, [loadNotes, ready]);
  useEffect(() => { if (!selectedId) { setSelectedNote(null); return; } void api.getNote(selectedId).then((result) => { setSelectedNote(result.note); pendingRef.current = result.note; setSaveState("saved"); }).catch(() => setSelectedNote(null)); }, [selectedId]);
  useEffect(() => { const onKeyDown = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key === "/") { event.preventDefault(); setCommandOpen(true); } }; window.addEventListener("keydown", onKeyDown); return () => window.removeEventListener("keydown", onKeyDown); }, []);
  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(""), 3000); return () => clearTimeout(timer); }, [toast]);

  const persistRef = useRef<(draft: Note) => void>(() => undefined);
  const persist = useCallback((draft: Note) => {
    pendingRef.current = draft;
    setSaveState("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      const requestDraft = pendingRef.current;
      if (!requestDraft) return;
      try {
        const result = await api.updateNote(requestDraft.id, { version: requestDraft.version, title: requestDraft.title, contentMarkdown: requestDraft.contentMarkdown, notebookId: requestDraft.notebookId, isFavorite: requestDraft.isFavorite, deleted: Boolean(requestDraft.deletedAt) });
        if (pendingRef.current?.title === requestDraft.title && pendingRef.current?.contentMarkdown === requestDraft.contentMarkdown && pendingRef.current?.version === requestDraft.version) {
          pendingRef.current = result.note;
          setSelectedNote(result.note);
          setSaveState("saved");
        } else {
          pendingRef.current = { ...pendingRef.current!, version: result.note.version };
          setSelectedNote((current) => current ? { ...current, version: result.note.version } : current);
          persistRef.current(pendingRef.current);
        }
        setNotes((current) => current.map((note) => note.id === result.note.id ? { ...note, ...result.note } : note));
      } catch (reason) { if (reason instanceof ApiError && reason.code === "VERSION_CONFLICT") { setSaveState("conflict"); setToast("这篇笔记已在别处更新，请重新载入"); } else { setSaveState("error"); setToast("保存失败，请检查网络后重试"); } }
    }, 800);
  }, []);
  persistRef.current = persist;
  const refreshNotebooks = useCallback(() => { void api.listNotebooks().then((result) => setNotebooks(result.notebooks)); }, []);
  const onNoteChange = useCallback((patch: { title?: string; contentMarkdown?: string; notebookId?: string }) => {
    const current = selectedRef.current;
    if (!current) return;
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
  const revealCreatedNote = useCallback((note: Note, targetNotebookId: string | undefined, message: string) => {
    setView("all");
    setNotebookId(targetNotebookId);
    setQuery("");
    setNotes((current) => [note, ...current.filter((currentNote) => currentNote.id !== note.id)]);
    setSelectedNote(note);
    selectedRef.current = note;
    pendingRef.current = note;
    setSelectedId(note.id);
    setMobileListOpen(false);
    setToast(message);
  }, []);
  const createNote = useCallback(async () => { try { const result = await api.createNote({ notebookId: notebooks.find((notebook) => notebook.isSystem)?.id }); revealCreatedNote(result.note, undefined, "已创建新笔记"); refreshNotebooks(); } catch { setToast("创建笔记失败"); } }, [notebooks, refreshNotebooks, revealCreatedNote]);
  const createNoteInNotebook = useCallback(async (commandToCreate: CreateNoteCommand) => { try { const result = await api.createNote({ notebookId: commandToCreate.notebookId, title: commandToCreate.title }); revealCreatedNote(result.note, commandToCreate.notebookId, `已在“${commandToCreate.notebookName}”中创建“${commandToCreate.title}”`); refreshNotebooks(); } catch (reason) { if (reason instanceof ApiError && reason.status === 401) navigate("/login", { replace: true }); setToast("创建笔记失败，请稍后重试"); } }, [navigate, refreshNotebooks, revealCreatedNote]);
  const createNotebook = useCallback(() => setEditingNotebook(null), []);
  const saveNotebook = useCallback((saved: Notebook) => {
    setNotebooks((current) => {
      const exists = current.some((nb) => nb.id === saved.id);
      return exists ? current.map((nb) => nb.id === saved.id ? { ...nb, name: saved.name } : nb) : [...current, saved];
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
  const toggleFavorite = useCallback(() => { const current = selectedRef.current; if (!current) return; const next = { ...current, isFavorite: !current.isFavorite }; selectedRef.current = next; setSelectedNote(next); persist(next); }, [persist]);
  const moveToTrash = useCallback(() => { const current = selectedRef.current; if (!current) return; const next = { ...current, deletedAt: Math.floor(Date.now() / 1000) }; selectedRef.current = next; setSelectedNote(next); persist(next); setToast("已移入回收站"); }, [persist]);
  const restoreFromTrash = useCallback(() => { const current = selectedRef.current; if (!current) return; const next = { ...current, deletedAt: null }; selectedRef.current = next; setSelectedNote(next); persist(next); setView("all"); setNotebookId(undefined); setToast("已恢复笔记"); }, [persist]);
  const permanentDeleteNote = useCallback(async () => {
    const current = selectedRef.current;
    if (!current) return;
    if (!window.confirm(`确定要彻底删除笔记“${current.title || "未命名笔记"}”吗？此操作无法撤销。`)) return;
    try {
      await api.deleteNote(current.id);
      setNotes((prev) => prev.filter((note) => note.id !== current.id));
      setSelectedId(null);
      setSelectedNote(null);
      selectedRef.current = null;
      pendingRef.current = null;
      setToast("已彻底删除笔记");
      refreshNotebooks();
    } catch {
      setToast("彻底删除笔记失败，请重试");
    }
  }, [refreshNotebooks]);
  const command = useCallback((id: CommandId) => { if (id === "new-note") void createNote(); if (id === "search") { setView("all"); setMobileSidebarOpen(true); requestAnimationFrame(() => searchRef.current?.focus()); } if (id === "toggle-sidebar") setSidebarCollapsed((value) => !value); if (id === "share" && selectedNote) setShareOpen(true); if (id === "favorite") toggleFavorite(); if (id === "trash") moveToTrash(); if (id === "restore") restoreFromTrash(); }, [createNote, moveToTrash, restoreFromTrash, selectedNote, toggleFavorite]);
  const logout = async () => { await api.logout().catch(() => undefined); navigate("/login", { replace: true }); };
  if (!ready) return <main className="app-loading"><span className="loading-ring" /><span>正在进入你的空间……</span></main>;
  return <div className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
    <button className={`mobile-scrim ${mobileSidebarOpen || mobileListOpen ? "is-visible" : ""}`} type="button" aria-label="关闭导航" onClick={() => { setMobileSidebarOpen(false); setMobileListOpen(false); }} />
    <Sidebar view={view} setView={(next) => { setView(next); setNotebookId(undefined); setMobileSidebarOpen(false); }} notebooks={notebooks} notebookId={notebookId} setNotebookId={(id) => { setNotebookId(id); setView("all"); setMobileSidebarOpen(false); }} query={query} setQuery={setQuery} searchRef={searchRef} onNewNote={() => void createNote()} onCreateNotebook={() => void createNotebook()} onEditNotebook={(target) => setEditingNotebook(target)} collapsed={sidebarCollapsed} onCollapse={() => setSidebarCollapsed((value) => !value)} mobileOpen={mobileSidebarOpen} onLogout={logout} />
    <NoteListPanel notes={notes} selectedId={selectedId} onSelect={(id) => { setSelectedId(id); setMobileListOpen(false); }} view={view} query={query} mobileOpen={mobileListOpen} onOpenSidebar={() => setMobileSidebarOpen(true)} />
    <main className="editor-region">
      {selectedNote ? <NoteEditor key={selectedNote.id} note={selectedNote} notebooks={notebooks} saveState={saveState} onChange={onNoteChange} onShare={() => setShareOpen(true)} onToggleFavorite={toggleFavorite} onMoveToTrash={moveToTrash} onRestore={restoreFromTrash} onPermanentDelete={permanentDeleteNote} onOpenList={() => setMobileListOpen(true)} /> : <EmptyEditor onNewNote={() => void createNote()} onOpenList={() => setMobileListOpen(true)} />}
    </main>
    <CommandMenu open={commandOpen} onClose={() => setCommandOpen(false)} onCommand={command} onCreateNoteInNotebook={createNoteInNotebook} canRestore={Boolean(selectedNote?.deletedAt)} notebooks={notebooks} />
    {shareOpen && selectedNote && <ShareDialog note={selectedNote} onClose={() => setShareOpen(false)} onToast={setToast} />}
    {editingNotebook !== undefined && <NotebookDialog notebook={editingNotebook} onClose={() => setEditingNotebook(undefined)} onSaved={saveNotebook} onDeleted={deleteNotebook} onToast={setToast} />}
    {toast && <div className="toast" role="status">{toast}</div>}
  </div>;
}

function Sidebar({ view, setView, notebooks, notebookId, setNotebookId, query, setQuery, searchRef, onNewNote, onCreateNotebook, onEditNotebook, collapsed, onCollapse, mobileOpen, onLogout }: { view: NoteView; setView: (view: NoteView) => void; notebooks: Notebook[]; notebookId?: string; setNotebookId: (id: string) => void; query: string; setQuery: (query: string) => void; searchRef: React.RefObject<HTMLInputElement | null>; onNewNote: () => void; onCreateNotebook: () => void; onEditNotebook: (notebook: Notebook) => void; collapsed: boolean; onCollapse: () => void; mobileOpen: boolean; onLogout: () => void }) {
  return <aside className={`sidebar ${mobileOpen ? "is-mobile-open" : ""}`} aria-label="主导航"><div className="brand-row"><span className="brand-mark"><span className="brand-star">✦</span></span><span className="brand-name">Lumen Notes</span><button className="icon-button collapse-button" type="button" onClick={onCollapse} aria-label={collapsed ? "展开侧栏" : "收起侧栏"}><LayoutPanelLeft size={18} /></button></div><div className="workspace-picker"><span className="workspace-avatar">L</span><span className="workspace-name">个人空间</span><ChevronDown size={16} /></div><button className="primary-button new-note-button" type="button" onClick={onNewNote}><Plus size={18} />新建笔记</button><label className="search-box"><Search size={17} /><input ref={searchRef} value={query} onChange={(event) => { setQuery(event.target.value); setView("all"); }} placeholder="搜索笔记……" aria-label="搜索笔记" /><kbd>Ctrl /</kbd></label><nav className="main-nav"><ul>{navItems.map((item) => { const Icon = item.icon; return <li key={item.id}><button className={`nav-item ${view === item.id && !notebookId ? "is-active" : ""}`} type="button" onClick={() => setView(item.id)}><Icon size={18} /><span>{item.label}</span></button></li>; })}</ul></nav><div className="notebook-section"><div className="section-heading"><span>笔记本</span><button className="icon-button tiny-button" type="button" aria-label="新建笔记本" title="新建笔记本" onClick={onCreateNotebook}><Plus size={16} /></button></div><ul>{notebooks.map((notebook) => <li key={notebook.id} className="notebook-row-item"><div className="notebook-row-wrap"><button className={`notebook-item ${notebook.id === notebookId ? "is-active" : ""}`} type="button" aria-label={`${notebook.name}，${notebook.count} 篇笔记`} onClick={() => setNotebookId(notebook.id)}><span className="notebook-dot" style={{ background: notebook.color }} /><span>{notebook.name}</span><em>{notebook.count}</em></button>{!notebook.isSystem && <button className="icon-button tiny-button notebook-edit-button" type="button" aria-label={`管理笔记本“${notebook.name}”`} title="管理笔记本" onClick={(e) => { e.stopPropagation(); onEditNotebook(notebook); }}><Pencil size={12} /></button>}</div></li>)}</ul></div><div className="sidebar-bottom"><button className="nav-item" type="button" onClick={onLogout}><LogOut size={18} /><span>退出登录</span></button><div className="sidebar-hint"><span className="status-pulse" />数据安全保存在你的空间</div></div></aside>;
}

function NoteListPanel({ notes, selectedId, onSelect, view, query, mobileOpen, onOpenSidebar }: { notes: NoteSummary[]; selectedId: string | null; onSelect: (id: string) => void; view: NoteView; query: string; mobileOpen: boolean; onOpenSidebar: () => void }) {
  return <section className={`note-list-panel ${mobileOpen ? "is-mobile-open" : ""}`} aria-label="笔记列表"><header className="list-header"><button className="icon-button mobile-only" type="button" aria-label="打开导航" onClick={onOpenSidebar}><Menu size={20} /></button><div><h2>{query ? "搜索结果" : viewLabel(view)}</h2><p>{query ? `包含“${query}”的笔记` : `${notes.length} 篇笔记`}</p></div><button className="sort-button" type="button">最近更新 <ChevronDown size={15} /></button></header><div className="note-list" role="list">{notes.map((note) => <button key={note.id} role="listitem" type="button" className={`note-row ${selectedId === note.id ? "is-selected" : ""}`} onClick={() => onSelect(note.id)}><span className="note-row-title">{note.title || "未命名笔记"}{note.isFavorite && <Star size={13} fill="currentColor" />}</span><span className="note-row-preview">{note.preview || "还没有内容，开始写下第一句话。"}</span><span className="note-row-meta"><span>{note.notebookName}</span><time>{relativeDate(note.updatedAt)}</time></span></button>)}{!notes.length && <div className="list-empty"><span className="empty-icon"><Archive size={23} /></span><strong>这里还没有笔记</strong><span>按下“新建笔记”，让一个想法有地方落脚。</span></div>}</div></section>;
}

function EmptyEditor({ onNewNote, onOpenList }: { onNewNote: () => void; onOpenList: () => void }) { return <section className="empty-editor"><button className="icon-button mobile-only empty-back" type="button" aria-label="打开笔记列表" onClick={onOpenList}><ChevronLeft size={20} /></button><div className="empty-editor-mark"><span>✦</span></div><h1>让想法有地方落脚</h1><p>创建一篇笔记，记录此刻值得留下的东西。</p><button className="primary-button" type="button" onClick={onNewNote}><Plus size={18} />新建笔记</button><span className="empty-shortcut">或按 Ctrl / 打开命令菜单</span></section>; }

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

function NotebookDialog({ notebook, onClose, onSaved, onDeleted, onToast }: { notebook?: Notebook | null; onClose: () => void; onSaved: (notebook: Notebook) => void; onDeleted?: (id: string) => void; onToast: (message: string) => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(notebook?.name ?? "");
  const [busy, setBusy] = useState(false);
  const isEditing = Boolean(notebook);
  useEffect(() => { const dialog = dialogRef.current; if (!dialog) return; dialog.showModal(); requestAnimationFrame(() => inputRef.current?.focus()); return () => { if (dialog.open) dialog.close(); }; }, []);
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      if (isEditing && notebook) {
        const result = await api.updateNotebook(notebook.id, { name: trimmed });
        onSaved({ ...notebook, name: result.notebook.name });
      } else {
        const result = await api.createNotebook({ name: trimmed });
        onSaved(result.notebook);
      }
      onClose();
    } catch {
      onToast(isEditing ? "更新笔记本失败" : "创建笔记本失败");
    } finally { setBusy(false); }
  };
  const handleDelete = () => {
    if (!notebook || !onDeleted) return;
    if (!window.confirm(`确定要删除笔记本“${notebook.name}”吗？其中的笔记将自动移入收件箱。`)) return;
    onDeleted(notebook.id);
  };
  return <dialog ref={dialogRef} className="notebook-dialog" onCancel={(event) => { event.preventDefault(); onClose(); }}><form onSubmit={(event) => void submit(event)}><div className="dialog-heading"><div><span className="dialog-eyebrow"><Folder size={15} />整理上下文</span><h2>{isEditing ? "编辑笔记本" : "新建笔记本"}</h2><p>{isEditing ? "修改笔记本名称或管理该分类。" : "给一组想法一个清晰的落点。"}</p></div><button className="icon-button" type="button" aria-label="关闭新建笔记本窗口" onClick={onClose}><X size={18} /></button></div><label className="dialog-field"><span>名称</span><input ref={inputRef} value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：项目资料" maxLength={40} autoComplete="off" /></label><div className="dialog-actions">{isEditing && !notebook?.isSystem && onDeleted && <button className="text-button text-danger" type="button" onClick={handleDelete} disabled={busy} style={{ marginRight: "auto" }}>删除笔记本</button>}<button className="secondary-button" type="button" onClick={onClose}>取消</button><button className="primary-button" type="submit" disabled={busy || !name.trim()}>{busy ? "正在保存……" : isEditing ? "保存修改" : "创建笔记本"}</button></div></form></dialog>;
}

function viewLabel(view: NoteView) { return ({ all: "全部笔记", inbox: "收件箱", favorites: "收藏", shared: "已分享", trash: "回收站" })[view]; }
function relativeDate(timestamp: number) { const delta = Math.floor(Date.now() / 1000) - timestamp; if (delta < 60) return "刚刚"; if (delta < 3600) return `${Math.floor(delta / 60)} 分钟前`; if (delta < 86400) return `${Math.floor(delta / 3600)} 小时前`; return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(timestamp * 1000)); }
function formatDate(timestamp: number) { return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(timestamp * 1000)); }
