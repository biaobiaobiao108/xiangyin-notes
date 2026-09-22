import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import { Archive, ChevronDown, ChevronLeft, LayoutPanelLeft, LogOut, Menu, Pencil, Plus, Search, Star, Trash2, X } from "lucide-react";
import type { NoteSummary, NoteView, Notebook } from "../../shared/types";
import { BrandMark } from "../brand-mark";
import type { OutlineItem } from "../editor-metrics";
import { FloatingScrollbar } from "../floating-scrollbar";
import { modKey } from "../platform";
import { type PwaState } from "../pwa";
import { getNoteTags, navItems, relativeDate, sortNotes, type NoteSort, viewLabel } from "./helpers";

export function NoteLoadingState() {
  return <section className="editor-panel editor-loading-shell" aria-label="笔记编辑器" aria-busy="true"><div className="editor-switch-overlay editor-switch-overlay--visible" role="status" aria-live="polite"><div className="editor-switch-card"><BrandMark className="editor-switch-mark" /><div className="editor-switch-lines" aria-hidden="true"><span /><span /><span /></div><strong>正在打开笔记…</strong></div></div></section>;
}

export const Sidebar = memo(function Sidebar({ view, setView, notebooks, notebookId, setNotebookId, query, setQuery, searchRef, onNewInboxNote, onCreateNotebook, onEditNotebook, collapsed, onCollapse, mobileOpen, onLogout }: { view: NoteView; setView: (view: NoteView) => void; notebooks: Notebook[]; notebookId?: string; setNotebookId: (id: string) => void; query: string; setQuery: (query: string) => void; searchRef: RefObject<HTMLInputElement | null>; onNewInboxNote: () => void; onCreateNotebook: () => void; onEditNotebook: (notebook: Notebook) => void; collapsed: boolean; onCollapse: () => void; mobileOpen: boolean; onLogout: () => void }) {
  const notebookListRef = useRef<HTMLDivElement>(null);

  return <aside className={`sidebar ${mobileOpen ? "is-mobile-open" : ""}`} aria-label="主导航">
    <div className="brand-row"><BrandMark /><span className="brand-name">象映笔记</span><button className="icon-button collapse-button" type="button" onClick={onCollapse} aria-label={collapsed ? "展开侧栏" : "收起侧栏"}><LayoutPanelLeft size={18} /></button></div>
    <button className="primary-button new-note-button" type="button" aria-label="在收件箱中新建笔记" title="在收件箱中新建笔记" onClick={onNewInboxNote}><Plus size={18} />新建笔记</button>
    <label className="search-box"><Search size={17} /><input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索笔记或 #标签……" aria-label="搜索笔记或标签" />{query ? <button className="search-clear" type="button" aria-label="清空搜索" title="清空搜索" onClick={() => setQuery("")}><X size={15} /></button> : <kbd>{modKey} /</kbd>}</label>
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
});

function NoteThumbnail({ note }: { note: NoteSummary }) {
  const thumbnail = note.thumbnail;
  if (!thumbnail?.url) return null;
  return <span className="note-row-thumbnail" aria-hidden="true"><img src={thumbnail.url} alt="" width={56} height={56} loading="lazy" decoding="async" /></span>;
}

const NOTE_TAG_DISPLAY_LIMIT = 3;

function NoteRowMeta({ note }: { note: NoteSummary }) {
  const tags = getNoteTags(note);
  const visibleTags = tags.slice(0, NOTE_TAG_DISPLAY_LIMIT);
  return <span className="note-row-meta">
    <span className="note-row-meta-leading">
      <span className="note-row-notebook">{note.notebookName}</span>
      {visibleTags.length > 0 && <>
        <span className="note-row-meta-divider" aria-hidden="true">·</span>
        <span className="note-row-tags" aria-label={`标签：${tags.map((tag) => `#${tag}`).join("、")}`}>
          {visibleTags.map((tag) => <span className="note-row-tag" key={tag}>#{tag}</span>)}
          {tags.length > visibleTags.length && <span className="note-row-tag note-row-tag--overflow">+{tags.length - visibleTags.length}</span>}
        </span>
      </>}
    </span>
    <time>{relativeDate(note.updatedAt)}</time>
  </span>;
}

const NoteListRow = memo(function NoteListRow({ note, isSelected, isActive, onSelect }: { note: NoteSummary; isSelected: boolean; isActive: boolean; onSelect: (id: string, event: ReactMouseEvent<HTMLButtonElement>) => void }) {
  return <li className="note-list-item"><button type="button" className={`note-row ${note.thumbnail ? "has-thumbnail" : ""} ${isSelected ? "is-selected" : ""} ${isActive ? "is-active" : ""}`} aria-current={isActive ? "page" : undefined} aria-pressed={isSelected} onClick={(event) => onSelect(note.id, event)}><NoteThumbnail note={note} /><span className="note-row-main"><span className="note-row-title"><span className="note-row-title-text">{note.title || "未命名笔记"}</span>{note.isFavorite && <Star size={13} fill="currentColor" />}</span><span className="note-row-preview">{note.preview || "还没有内容，开始写下第一句话。"}</span><NoteRowMeta note={note} /></span></button></li>;
});

export function NoteOutlinePanel({ outlineItems, activeOutlineId, onScrollToOutlineItem, onCloseOutline }: { outlineItems: OutlineItem[]; activeOutlineId: string | null; onScrollToOutlineItem: (id: string) => void; onCloseOutline: () => void }) {
  const outlineScrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const scrollRoot = outlineScrollRef.current;
    if (!scrollRoot || !activeOutlineId) return;
    const activeButton = Array.from(scrollRoot.querySelectorAll<HTMLButtonElement>(".editor-outline-item button")).find((button) => button.dataset.outlineId === activeOutlineId);
    if (!activeButton) return;
    const scrollRect = scrollRoot.getBoundingClientRect();
    const buttonRect = activeButton.getBoundingClientRect();
    const edgePadding = 8;
    const visibleTop = scrollRect.top + edgePadding;
    const visibleBottom = scrollRect.bottom - edgePadding;
    let delta = 0;
    if (buttonRect.top < visibleTop) delta = buttonRect.top - visibleTop;
    else if (buttonRect.bottom > visibleBottom) delta = buttonRect.bottom - visibleBottom;
    if (delta === 0) return;
    const behavior: ScrollBehavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    const maxScrollTop = Math.max(0, scrollRoot.scrollHeight - scrollRoot.clientHeight);
    scrollRoot.scrollTo({ top: Math.min(maxScrollTop, Math.max(0, scrollRoot.scrollTop + delta)), behavior });
  }, [activeOutlineId, outlineItems]);

  return <aside className="note-outline-panel" id="note-outline" aria-labelledby="note-outline-title">
    <header className="list-header note-outline-header">
      <div className="list-header-main"><h2 id="note-outline-title">笔记大纲</h2><p>{outlineItems.length > 0 ? `${outlineItems.length} 个标题` : "当前笔记暂无标题"}</p></div>
      <button className="text-button outline-back-button" type="button" onClick={onCloseOutline}><ChevronLeft size={15} aria-hidden="true" /><span>返回笔记列表</span></button>
    </header>
    <div className="note-outline-scroll-shell">
      <div id="note-outline-scroll-region" className="note-outline-scroll floating-scrollbar-target" ref={outlineScrollRef}>
        {outlineItems.length > 0 ? <nav aria-label="笔记标题">
          <ol className="editor-outline-list">
            {outlineItems.map((item) => <li className={`editor-outline-item editor-outline-item--level-${item.level}`} key={item.id}><button type="button" data-outline-id={item.id} aria-current={activeOutlineId === item.id ? "true" : undefined} onClick={() => onScrollToOutlineItem(item.id)}><span className={`outline-level-marker outline-level-marker--${item.level}`} aria-hidden="true" /><span className="outline-item-title">{item.title}</span></button></li>)}
          </ol>
        </nav> : <p className="editor-outline-empty">用 <code>#</code> 标题为这篇笔记建立大纲。</p>}
      </div>
      <FloatingScrollbar scrollTargetRef={outlineScrollRef} controlsId="note-outline-scroll-region" ariaLabel="笔记大纲滚动条" placement="right" enabled />
    </div>
  </aside>;
}

const SORT_OPTIONS: Array<{ value: NoteSort; label: string }> = [
  { value: "updated", label: "最近更新" },
  { value: "created", label: "创建时间" },
  { value: "title", label: "标题排序" },
];

type NoteListPanelProps = {
  notes: NoteSummary[];
  total: number;
  hasMore?: boolean;
  sort: NoteSort;
  setSort: (sort: NoteSort) => void;
  selectedId: string | null;
  selectedIds: ReadonlySet<string>;
  onSelect: (id: string, event: ReactMouseEvent<HTMLButtonElement>) => void;
  onDeleteSelected: () => void;
  view: NoteView;
  query: string;
  currentNotebookName?: string;
  onNewNote?: () => void;
  onEmptyTrash?: () => void;
  trashBusy: boolean;
  onClearQuery: () => void;
  onOpenSidebar: () => void;
  transitionToken: number;
  mobileOpen: boolean;
  outlineOpen: boolean;
  outlineItems: OutlineItem[];
  activeOutlineId: string | null;
  onScrollToOutlineItem: (id: string) => void;
  onCloseOutline: () => void;
  onLoadMore?: () => void;
  isLoadingMore?: boolean;
};

export const NoteListPanel = memo(function NoteListPanel({ notes, total, hasMore = total > notes.length, sort, setSort, selectedId, selectedIds, onSelect, onDeleteSelected, view, query, currentNotebookName, onNewNote, onEmptyTrash, trashBusy, onClearQuery, mobileOpen, onOpenSidebar, transitionToken, outlineOpen, outlineItems, activeOutlineId, onScrollToOutlineItem, onCloseOutline, onLoadMore, isLoadingMore = false }: NoteListPanelProps) {
  const [sortOpen, setSortOpen] = useState(false);
  const sortRef = useRef<HTMLDivElement>(null);
  const sortTriggerRef = useRef<HTMLButtonElement>(null);
  const sortOptionRefs = useRef<Array<HTMLButtonElement | null>>([]);
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
    const selectedOptionIndex = Math.max(0, SORT_OPTIONS.findIndex((option) => option.value === sort));
    const focusFrame = requestAnimationFrame(() => sortOptionRefs.current[selectedOptionIndex]?.focus());
    const closeSortMenu = () => {
      setSortOpen(false);
      requestAnimationFrame(() => sortTriggerRef.current?.focus());
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !sortRef.current?.contains(event.target)) closeSortMenu();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeSortMenu();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [sort, sortOpen]);

  const closeSortMenu = () => {
    setSortOpen(false);
    requestAnimationFrame(() => sortTriggerRef.current?.focus());
  };
  const handleSortOptionKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault();
      sortOptionRefs.current[(index + 1) % SORT_OPTIONS.length]?.focus();
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault();
      sortOptionRefs.current[(index + SORT_OPTIONS.length - 1) % SORT_OPTIONS.length]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      sortOptionRefs.current[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      sortOptionRefs.current[SORT_OPTIONS.length - 1]?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeSortMenu();
    }
  };

  const sortedNotes = useMemo(() => sortNotes(notes, sort), [notes, sort]);
  const handleNoteListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    const target = event.target;
    if (target instanceof HTMLElement && (target.isContentEditable || target.matches("input, textarea, select"))) return;
    if ((event.key === "Delete" || event.key === "Backspace") && selectedIds.size > 0) {
      event.preventDefault();
      onDeleteSelected();
    }
  };
  const heading = query ? "搜索结果" : currentNotebookName ?? viewLabel(view);
  const truncated = hasMore;
  return <section ref={panelRef} className={`note-list-panel ${mobileOpen ? "is-mobile-open" : ""} ${outlineOpen ? "is-outline-open" : ""}`} aria-label={outlineOpen ? "笔记大纲" : "笔记列表"}>
    <div className="note-list-content">
      {outlineOpen ? <NoteOutlinePanel outlineItems={outlineItems} activeOutlineId={activeOutlineId} onScrollToOutlineItem={onScrollToOutlineItem} onCloseOutline={onCloseOutline} /> : <>
      <header className="list-header">
        <button className="icon-button mobile-only" type="button" aria-label="打开导航" onClick={onOpenSidebar}><Menu size={20} /></button>
        <div className="list-header-main"><h2 tabIndex={-1}>{heading}</h2><p>{query ? `包含“${query}”的笔记` : `${truncated ? total : notes.length} 篇笔记`}{truncated && <> · 已显示最近 {notes.length} 篇</>}</p></div>
        <div className="list-header-controls">
          {onEmptyTrash && <button className="text-button text-danger empty-trash-button" type="button" onClick={onEmptyTrash} disabled={trashBusy || total === 0}><Trash2 size={15} aria-hidden="true" />清空回收站</button>}
          {onNewNote && <button className="icon-button list-new-note-button" type="button" aria-label={`在${currentNotebookName}中新建笔记`} title={`在${currentNotebookName}中新建笔记`} onClick={onNewNote}><Plus size={18} /></button>}
          <div className="sort-menu-wrap" ref={sortRef}>
            <button ref={sortTriggerRef} id="note-sort-trigger" className="sort-button" type="button" aria-haspopup="listbox" aria-controls="note-sort-options" aria-expanded={sortOpen} onClick={() => setSortOpen((open) => !open)}>{SORT_OPTIONS.find((option) => option.value === sort)?.label} <ChevronDown size={15} /></button>
            {sortOpen && <div id="note-sort-options" className="sort-dropdown" role="listbox" aria-label="笔记排序方式">
              {SORT_OPTIONS.map((option, index) => {
                const isSelected = sort === option.value;
                return <button ref={(element) => { sortOptionRefs.current[index] = element; }} id={`note-sort-option-${option.value}`} key={option.value} type="button" className={`sort-option ${isSelected ? "is-active" : ""}`} role="option" aria-selected={isSelected} tabIndex={isSelected ? 0 : -1} onClick={() => { setSort(option.value); closeSortMenu(); }} onKeyDown={(event) => handleSortOptionKeyDown(event, index)}>{option.label}</button>;
              })}
            </div>}
          </div>
        </div>
      </header>
      <div className="note-list-scroll-shell"><div id="note-list-scroll-region" className="note-list floating-scrollbar-target" ref={noteListRef} onKeyDown={handleNoteListKeyDown}><ul className="note-list-items" role="list">{sortedNotes.map((note) => <NoteListRow key={note.id} note={note} isSelected={selectedIds.has(note.id)} isActive={selectedId === note.id} onSelect={onSelect} />)}{truncated && onLoadMore && <li className="note-list-load-more-item"><button className="secondary-button note-list-load-more-button" type="button" onClick={onLoadMore} disabled={isLoadingMore}>{isLoadingMore ? "正在加载……" : `加载更多（已显示 ${notes.length} / ${total}）`}</button></li>}</ul>{!sortedNotes.length && (query ? <div className="list-empty"><span className="empty-icon"><Search size={23} /></span><strong>没有找到匹配的笔记</strong><span>试试更短的关键词，或清空搜索查看全部内容。</span><button className="secondary-button" type="button" onClick={onClearQuery}>清空搜索</button></div> : <div className="list-empty"><span className="empty-icon"><Archive size={23} /></span><strong>{view === "trash" ? "回收站是空的" : "这里还没有笔记"}</strong><span>{view === "trash" ? "移入回收站的笔记会显示在这里。" : "按下“新建笔记”，让一个想法有地方落脚。"}</span></div>)}</div><FloatingScrollbar scrollTargetRef={noteListRef} controlsId="note-list-scroll-region" ariaLabel="笔记列表滚动条" placement="left" /></div>
      </>}
    </div>
  </section>;
});

export function EmptyEditor({ isTrash, onNewNote, onOpenList, transitionToken }: { isTrash: boolean; onNewNote: () => void; onOpenList: () => void; transitionToken: number }) {
  return <section key={transitionToken} className="empty-editor"><button className="icon-button mobile-only empty-back" type="button" aria-label="打开笔记列表" onClick={onOpenList}><ChevronLeft size={20} /></button><BrandMark className="empty-editor-mark" /><h1 tabIndex={-1}>{isTrash ? "回收站是空的" : "让想法有地方落脚"}</h1><p>{isTrash ? "没有需要清理或恢复的笔记。" : "创建一篇笔记，记录此刻值得留下的东西。"}</p>{!isTrash && <><button className="primary-button" type="button" onClick={onNewNote}><Plus size={18} />新建笔记</button><span className="empty-shortcut">或按 {modKey} / 打开命令菜单</span></>}</section>;
}
