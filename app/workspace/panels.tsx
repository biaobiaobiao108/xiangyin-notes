import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Archive, ChevronDown, ChevronLeft, LayoutPanelLeft, LogOut, Menu, Pencil, Plus, RefreshCw, Search, Star, Trash2, X, AlertTriangle } from "lucide-react";
import type { NoteSummary, NoteView, Notebook } from "../../shared/types";
import { BrandMark } from "../brand-mark";
import { FloatingScrollbar } from "../floating-scrollbar";
import { modKey } from "../platform";
import type { OfflineSyncState } from "../offline-sync";
import { type PwaState } from "../pwa";
import { navItems, relativeDate, sortNotes, type NoteSort, viewLabel } from "./helpers";

export function NoteLoadingState() {
  return <section className="editor-panel editor-loading-shell" aria-label="笔记编辑器" aria-busy="true"><div className="editor-switch-overlay editor-switch-overlay--visible" role="status" aria-live="polite"><div className="editor-switch-card"><BrandMark className="editor-switch-mark" /><div className="editor-switch-lines" aria-hidden="true"><span /><span /><span /></div><strong>正在打开笔记…</strong></div></div></section>;
}

export function SyncNotice({ state, pwa, onRetry, onUpdate, onConflicts }: { state: OfflineSyncState; pwa: PwaState; onRetry: () => void; onUpdate: () => void; onConflicts: () => void }) {
  if (state.conflictCount > 0) {
    return <div className="sync-notice sync-notice--danger" role="alert" aria-labelledby="sync-notice-title"><div className="sync-notice-header"><AlertTriangle size={18} aria-hidden="true" /><div><strong id="sync-notice-title">有 {state.conflictCount} 个同步冲突</strong><p>本地内容已经保留，请处理冲突后继续同步。</p></div></div><div className="sync-notice-actions"><button className="text-button sync-notice-action" type="button" onClick={onConflicts}>查看冲突</button></div></div>;
  }
  if (state.status === "error") {
    return <div className="sync-notice sync-notice--danger" role="alert" aria-labelledby="sync-notice-title"><div className="sync-notice-header"><AlertTriangle size={18} aria-hidden="true" /><div><strong id="sync-notice-title">同步失败</strong><p>{state.lastError || "请重试同步，确认本地修改已经保存。"}</p></div></div><div className="sync-notice-actions"><button className="text-button sync-notice-action" type="button" onClick={onRetry}>重试</button></div></div>;
  }
  if (state.status === "offline" && state.pendingCount > 0) {
    return <div className="sync-notice sync-notice--offline" role="status" aria-live="polite" aria-labelledby="sync-notice-title"><div className="sync-notice-header"><RefreshCw size={18} aria-hidden="true" /><div><strong id="sync-notice-title">已离线，等待同步 {state.pendingCount} 项</strong><p>恢复联网后会自动继续同步。</p></div></div><div className="sync-notice-actions"><button className="text-button sync-notice-action" type="button" onClick={onRetry}>重试</button></div></div>;
  }
  if (pwa.updateAvailable) {
    return <div className="sync-notice sync-notice--update" role="status" aria-live="polite" aria-labelledby="sync-notice-title"><div className="sync-notice-header"><RefreshCw size={18} aria-hidden="true" /><div><strong id="sync-notice-title">发现新版本</strong><p>完成待同步内容后即可更新应用。</p></div></div><div className="sync-notice-actions"><button className="text-button sync-notice-action" type="button" onClick={onUpdate}>更新</button></div></div>;
  }
  return null;
}

export function Sidebar({ view, setView, notebooks, notebookId, setNotebookId, query, setQuery, searchRef, onNewNote, onCreateNotebook, onEditNotebook, collapsed, onCollapse, mobileOpen, onLogout }: { view: NoteView; setView: (view: NoteView) => void; notebooks: Notebook[]; notebookId?: string; setNotebookId: (id: string) => void; query: string; setQuery: (query: string) => void; searchRef: RefObject<HTMLInputElement | null>; onNewNote: () => void; onCreateNotebook: () => void; onEditNotebook: (notebook: Notebook) => void; collapsed: boolean; onCollapse: () => void; mobileOpen: boolean; onLogout: () => void }) {
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
          <ul>{notebooks.filter((notebook) => !notebook.isSystem).map((notebook) => <li key={notebook.id} className="notebook-row-item"><div className={`notebook-row-wrap ${notebook.id === notebookId ? "is-active" : ""}`}><button className="notebook-item" type="button" aria-label={`${notebook.name}，${notebook.count} 篇笔记`} onClick={() => setNotebookId(notebook.id)}><span className="notebook-dot" style={{ background: notebook.color }} /><span>{notebook.name}</span><em>{notebook.count}</em></button><button className="icon-button tiny-button notebook-edit-button" type="button" aria-label={`管理笔记本“${notebook.name}”`} title="管理笔记本" onClick={(e) => { e.stopPropagation(); onEditNotebook(notebook); }}><Pencil size={12} /></button></div></li>)}</ul>
        </div>
        <FloatingScrollbar scrollTargetRef={notebookListRef} controlsId="notebook-list-scroll-region" ariaLabel="笔记本列表滚动条" placement="left" />
      </div>
    </div>
    <div className="sidebar-bottom"><button className="nav-item" type="button" aria-label="退出登录" onClick={onLogout}><LogOut size={18} /><span>退出登录</span></button></div>
  </aside>;
}

export function NoteListPanel({ notes, total, sort, setSort, selectedId, onSelect, view, query, currentNotebookName, onNewNote, onEmptyTrash, trashBusy, onClearQuery, mobileOpen, onOpenSidebar, transitionToken }: { notes: NoteSummary[]; total: number; sort: NoteSort; setSort: (sort: NoteSort) => void; selectedId: string | null; onSelect: (id: string) => void; view: NoteView; query: string; currentNotebookName?: string; onNewNote?: () => void; onEmptyTrash?: () => void; trashBusy: boolean; onClearQuery: () => void; mobileOpen: boolean; onOpenSidebar: () => void; transitionToken: number }) {
  const [sortOpen, setSortOpen] = useState(false);
  const sortRef = useRef<HTMLDivElement>(null);
  const noteListRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    if (transitionToken === 0 || !panelRef.current) return;
    const panel = panelRef.current;
    panel.classList.remove("is-view-transitioning");
    void panel.offsetWidth;
    panel.classList.add("is-view-transitioning");
  }, [transitionToken]);

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
  const sortLabels: Record<NoteSort, string> = { updated: "最近更新", created: "创建时间", title: "标题排序" };
  const heading = query ? "搜索结果" : currentNotebookName ?? viewLabel(view);
  const truncated = total > notes.length;
  return <section ref={panelRef} className={`note-list-panel ${mobileOpen ? "is-mobile-open" : ""}`} aria-label="笔记列表">
    <div className="note-list-content">
      <header className="list-header">
        <button className="icon-button mobile-only" type="button" aria-label="打开导航" onClick={onOpenSidebar}><Menu size={20} /></button>
        <div className="list-header-main"><h2 tabIndex={-1}>{heading}</h2><p>{query ? `包含“${query}”的笔记` : `${truncated ? total : notes.length} 篇笔记`}{truncated && <> · 已显示最近 {notes.length} 篇</>}</p></div>
        <div className="list-header-controls">
          {onEmptyTrash && <button className="text-button text-danger empty-trash-button" type="button" onClick={onEmptyTrash} disabled={trashBusy || total === 0}><Trash2 size={15} aria-hidden="true" />清空回收站</button>}
          {onNewNote && <button className="icon-button list-new-note-button" type="button" aria-label={`在${currentNotebookName}中新建笔记`} title={`在${currentNotebookName}中新建笔记`} onClick={onNewNote}><Plus size={18} /></button>}
          <div className="sort-menu-wrap" ref={sortRef}>
            <button className="sort-button" type="button" aria-haspopup="listbox" aria-expanded={sortOpen} onClick={() => setSortOpen((open) => !open)}>{sortLabels[sort]} <ChevronDown size={15} /></button>
            {sortOpen && <div className="sort-dropdown" role="listbox" aria-label="笔记排序方式"><button type="button" className={`sort-option ${sort === "updated" ? "is-active" : ""}`} onClick={() => { setSort("updated"); setSortOpen(false); }}>最近更新</button><button type="button" className={`sort-option ${sort === "created" ? "is-active" : ""}`} onClick={() => { setSort("created"); setSortOpen(false); }}>创建时间</button><button type="button" className={`sort-option ${sort === "title" ? "is-active" : ""}`} onClick={() => { setSort("title"); setSortOpen(false); }}>标题排序</button></div>}
          </div>
        </div>
      </header>
      <div className="note-list-scroll-shell"><div id="note-list-scroll-region" className="note-list floating-scrollbar-target" ref={noteListRef}><ul className="note-list-items" role="list">{sortedNotes.map((note) => <li key={note.id}><button type="button" className={`note-row ${selectedId === note.id ? "is-selected" : ""}`} onClick={() => onSelect(note.id)}><span className="note-row-title">{note.title || "未命名笔记"}{note.isFavorite && <Star size={13} fill="currentColor" />}</span><span className="note-row-preview">{note.preview || "还没有内容，开始写下第一句话。"}</span><span className="note-row-meta"><span>{note.notebookName}</span><time>{relativeDate(note.updatedAt)}</time></span></button></li>)}</ul>{!sortedNotes.length && (query ? <div className="list-empty"><span className="empty-icon"><Search size={23} /></span><strong>没有找到匹配的笔记</strong><span>试试更短的关键词，或清空搜索查看全部内容。</span><button className="secondary-button" type="button" onClick={onClearQuery}>清空搜索</button></div> : <div className="list-empty"><span className="empty-icon"><Archive size={23} /></span><strong>{view === "trash" ? "回收站是空的" : "这里还没有笔记"}</strong><span>{view === "trash" ? "移入回收站的笔记会显示在这里。" : "按下“新建笔记”，让一个想法有地方落脚。"}</span></div>)}</div><FloatingScrollbar scrollTargetRef={noteListRef} controlsId="note-list-scroll-region" ariaLabel="笔记列表滚动条" placement="left" /></div>
    </div>
  </section>;
}

export function EmptyEditor({ isTrash, onNewNote, onOpenList, transitionToken }: { isTrash: boolean; onNewNote: () => void; onOpenList: () => void; transitionToken: number }) {
  return <section key={transitionToken} className="empty-editor"><button className="icon-button mobile-only empty-back" type="button" aria-label="打开笔记列表" onClick={onOpenList}><ChevronLeft size={20} /></button><BrandMark className="empty-editor-mark" /><h1 tabIndex={-1}>{isTrash ? "回收站是空的" : "让想法有地方落脚"}</h1><p>{isTrash ? "没有需要清理或恢复的笔记。" : "创建一篇笔记，记录此刻值得留下的东西。"}</p>{!isTrash && <><button className="primary-button" type="button" onClick={onNewNote}><Plus size={18} />新建笔记</button><span className="empty-shortcut">或按 {modKey} / 打开命令菜单</span></>}</section>;
}
