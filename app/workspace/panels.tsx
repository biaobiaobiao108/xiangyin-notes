import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import { Archive, ChevronDown, ChevronLeft, LayoutPanelLeft, LogOut, Menu, Plus, Search, Star, Trash2, X } from "lucide-react";
import type { NoteSummary, NoteView, Notebook } from "../../shared/types";
import { playEntranceAnimation } from "../animation";
import { BrandMark } from "../brand-mark";
import type { OutlineItem } from "../editor-metrics";
import { FloatingScrollbar } from "../floating-scrollbar";
import { commandMenuShortcutLabel } from "../platform";
import { type PwaState } from "../pwa";
import { getNoteTags, getNotebookIconComponent, navItems, NOTE_TAG_DISPLAY_LIMIT, relativeDate, sortNotes, type NoteSort, viewLabel } from "./helpers";
import { useVirtualNoteList } from "./use-virtual-note-list";
import { MobileCollectionHeader } from "./mobile-collection-header";

export function NoteLoadingState() {
  return <section className="editor-panel editor-loading-shell" aria-label="笔记编辑器" aria-busy="true"><div className="editor-switch-overlay editor-switch-overlay--visible" role="status" aria-live="polite"><div className="editor-switch-card"><BrandMark className="editor-switch-mark" /><div className="editor-switch-lines" aria-hidden="true"><span /><span /><span /></div><strong>正在打开笔记…</strong></div></div></section>;
}

export const Sidebar = memo(function Sidebar({ view, setView, notebooks, notebookId, setNotebookId, query, setQuery, searchRef, onNewInboxNote, onCreateNotebook, onEditNotebook, collapsed, onCollapse, onLogout }: { view: NoteView; setView: (view: NoteView) => void; notebooks: Notebook[]; notebookId?: string; setNotebookId: (id: string) => void; query: string; setQuery: (query: string) => void; searchRef: RefObject<HTMLInputElement | null>; onNewInboxNote: () => void; onCreateNotebook: () => void; onEditNotebook: (notebook: Notebook) => void; collapsed: boolean; onCollapse: () => void; onLogout: () => void }) {
  const notebookListRef = useRef<HTMLDivElement>(null);
  const collapsedNotebookListRef = useRef<HTMLDivElement>(null);
  const customNotebooks = useMemo(() => notebooks.filter((notebook) => !notebook.isSystem), [notebooks]);

  return <aside className="sidebar" aria-label="主导航">
    <div className="brand-row"><BrandMark /><span className="brand-name">象映笔记</span><button className="icon-button collapse-button" type="button" onClick={onCollapse} aria-label={collapsed ? "展开侧栏" : "收起侧栏"}><LayoutPanelLeft size={18} /></button></div>
    <button className="primary-button new-note-button" type="button" aria-label="在收件箱中新建笔记" onClick={onNewInboxNote}><Plus size={18} />新建笔记</button>
    <label className="search-box"><Search size={17} /><input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索笔记或 #标签……" aria-label="搜索笔记或标签" />{query ? <button className="search-clear" type="button" aria-label="清空搜索" onClick={() => setQuery("")}><X size={15} /></button> : <kbd>{commandMenuShortcutLabel}</kbd>}</label>
    <nav className="main-nav"><ul>{navItems.map((item) => { const Icon = item.icon; return <li key={item.id}><button className={`nav-item ${view === item.id && !notebookId ? "is-active" : ""}`} type="button" onClick={() => setView(item.id)}><Icon size={18} /><span>{item.label}</span></button></li>; })}</ul></nav>
    <div className="collapsed-notebook-shell">
      <div id="collapsed-notebook-scroll-region" ref={collapsedNotebookListRef} className="collapsed-notebook-list floating-scrollbar-target" role="toolbar" aria-label="笔记本快捷切换">
        {customNotebooks.length > 0 && <div className="collapsed-notebook-divider" aria-hidden="true" />}
        {customNotebooks.map((notebook) => {
          const NotebookIcon = getNotebookIconComponent(notebook.icon);
          const isActive = notebook.id === notebookId;
          return (
            <button
              key={notebook.id}
              type="button"
              className={`nav-item collapsed-notebook-item ${isActive ? "is-active" : ""}`}
              onClick={() => setNotebookId(notebook.id)}
              onContextMenu={(event) => { event.preventDefault(); onEditNotebook(notebook); }}
              onKeyDown={(event) => { if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) { event.preventDefault(); onEditNotebook(notebook); } }}
              aria-label={`${notebook.name}，${notebook.count} 篇笔记`}
            >
              <NotebookIcon size={18} style={{ color: notebook.color }} />
            </button>
          );
        })}
      </div>
      <FloatingScrollbar scrollTargetRef={collapsedNotebookListRef} controlsId="collapsed-notebook-scroll-region" ariaLabel="笔记本快捷切换滚动条" placement="left" />
    </div>
    <div className="notebook-section">
      <div className="section-heading"><span>笔记本</span><button className="icon-button tiny-button" type="button" aria-label="新建笔记本" onClick={onCreateNotebook}><Plus size={16} /></button></div>
      <div className="notebook-list-scroll-shell">
        <div id="notebook-list-scroll-region" className="notebook-list-scroll floating-scrollbar-target" ref={notebookListRef}>
          <ul>{customNotebooks.map((notebook) => {
            const NotebookIcon = getNotebookIconComponent(notebook.icon);
            return (
              <li key={notebook.id} className="notebook-row-item">
                <div className={`notebook-row-wrap ${notebook.id === notebookId ? "is-active" : ""}`}>
                  <button className="notebook-item" type="button" aria-label={`${notebook.name}，${notebook.count} 篇笔记`} onClick={() => setNotebookId(notebook.id)} onContextMenu={(event) => { event.preventDefault(); onEditNotebook(notebook); }} onKeyDown={(event) => { if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) { event.preventDefault(); onEditNotebook(notebook); } }}>
                    <NotebookIcon size={16} className="notebook-custom-icon" style={{ color: notebook.color, flexShrink: 0 }} />
                    <span>{notebook.name}</span>
                    <em>{notebook.count}</em>
                  </button>
                </div>
              </li>
            );
          })}</ul>
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

function NoteRowMeta({ note, showNotebook }: { note: NoteSummary; showNotebook: boolean }) {
  const tags = getNoteTags(note);
  const visibleTags = tags.slice(0, NOTE_TAG_DISPLAY_LIMIT);
  return <span className="note-row-meta">
    <span className="note-row-meta-leading">
      {showNotebook && note.notebookName && <span className="note-row-notebook">{note.notebookName}</span>}
      {showNotebook && note.notebookName && visibleTags.length > 0 && <>
        <span className="note-row-meta-divider" aria-hidden="true">·</span>
      </>}
      {visibleTags.length > 0 && (
        <span className="note-row-tags" aria-label={`标签：${tags.map((tag) => `#${tag}`).join("、")}`}>
          {visibleTags.map((tag) => <span className="note-row-tag" key={tag}>#{tag}</span>)}
          {tags.length > visibleTags.length && <span className="note-row-tag note-row-tag--overflow">+{tags.length - visibleTags.length}</span>}
        </span>
      )}
    </span>
    <time>{relativeDate(note.updatedAt)}</time>
  </span>;
}

const NoteListRow = memo(function NoteListRow({ note, isSelected, isActive, showNotebook, onSelect, rowRef, rowStyle, rowIndex, setSize }: { note: NoteSummary; isSelected: boolean; isActive: boolean; showNotebook: boolean; onSelect: (id: string, event: ReactMouseEvent<HTMLButtonElement>) => void; rowRef?: (element: HTMLLIElement | null) => void; rowStyle?: CSSProperties; rowIndex: number; setSize: number }) {
  return <li ref={rowRef} data-note-id={note.id} className="note-list-item" style={rowStyle} aria-posinset={rowIndex + 1} aria-setsize={setSize}><button type="button" className={`note-row ${note.thumbnail ? "has-thumbnail" : ""} ${isSelected ? "is-selected" : ""} ${isActive ? "is-active" : ""}`} aria-current={isActive ? "page" : undefined} aria-pressed={isSelected} onClick={(event) => onSelect(note.id, event)}><NoteThumbnail note={note} /><span className="note-row-main"><span className="note-row-title"><span className="note-row-title-text">{note.title || "未命名笔记"}</span>{note.isFavorite && <Star size={13} fill="currentColor" />}</span><span className="note-row-preview">{note.preview || "还没有内容，开始写下第一句话。"}</span><NoteRowMeta note={note} showNotebook={showNotebook} /></span></button></li>;
});

export function NoteOutlinePanel({ outlineItems, activeOutlineId, onScrollToOutlineItem, onCloseOutline, isFloating = false }: { outlineItems: OutlineItem[]; activeOutlineId: string | null; onScrollToOutlineItem: (id: string) => void; onCloseOutline: () => void; isFloating?: boolean }) {
  const outlineScrollRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const scrollRoot = outlineScrollRef.current;
    const shell = scrollRoot?.parentElement;
    if (!isFloating || !scrollRoot || !shell) return;
    const fitCompleteRows = () => {
      const list = scrollRoot.querySelector<HTMLOListElement>(".editor-outline-list");
      const row = list?.querySelector<HTMLButtonElement>("button");
      if (!list || !row) {
        scrollRoot.style.height = "100%";
        return;
      }
      const style = getComputedStyle(scrollRoot);
      const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      const gap = parseFloat(getComputedStyle(list).rowGap) || 0;
      const stride = row.offsetHeight + gap;
      if (stride <= 0) return;
      const rows = Math.max(1, Math.floor((shell.clientHeight - padding + gap) / stride));
      scrollRoot.style.height = `${Math.min(shell.clientHeight, rows * stride - gap + padding)}px`;
    };
    fitCompleteRows();
    const observer = new ResizeObserver(fitCompleteRows);
    observer.observe(shell);
    return () => {
      observer.disconnect();
      scrollRoot.style.removeProperty("height");
    };
  }, [isFloating, outlineItems]);
  useEffect(() => {
    const scrollRoot = outlineScrollRef.current;
    if (!scrollRoot || !activeOutlineId) return;
    const activeButton = Array.from(scrollRoot.querySelectorAll<HTMLButtonElement>(".editor-outline-item button")).find((button) => button.dataset.outlineId === activeOutlineId);
    if (!activeButton) return;
    const scrollRect = scrollRoot.getBoundingClientRect();
    const buttonRect = activeButton.getBoundingClientRect();
    const edgePadding = isFloating ? 14 : 8;
    const visibleTop = scrollRect.top + edgePadding;
    const visibleBottom = scrollRect.bottom - edgePadding;
    let delta = 0;
    if (buttonRect.top < visibleTop) delta = buttonRect.top - visibleTop;
    else if (buttonRect.bottom > visibleBottom) delta = buttonRect.bottom - visibleBottom;
    if (delta === 0) return;
    const behavior: ScrollBehavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    const maxScrollTop = Math.max(0, scrollRoot.scrollHeight - scrollRoot.clientHeight);
    scrollRoot.scrollTo({ top: Math.min(maxScrollTop, Math.max(0, scrollRoot.scrollTop + delta)), behavior });
  }, [activeOutlineId, outlineItems, isFloating]);

  return <aside className={`note-outline-panel ${isFloating ? "is-floating" : ""}`} id="note-outline" aria-label={isFloating ? "笔记大纲" : undefined} aria-labelledby={isFloating ? undefined : "note-outline-title"}>
    {!isFloating && (
      <header className="list-header note-outline-header">
        <div className="list-header-main"><h2 id="note-outline-title">笔记大纲</h2><p>{outlineItems.length > 0 ? `${outlineItems.length} 个标题` : "当前笔记暂无标题"}</p></div>
        <div className="list-header-controls"><button className="text-button outline-back-button" type="button" onClick={onCloseOutline}><ChevronLeft size={15} aria-hidden="true" /><span>返回笔记列表</span></button></div>
      </header>
    )}
    <div className="note-outline-scroll-shell">
      <div id="note-outline-scroll-region" className="note-outline-scroll floating-scrollbar-target" ref={outlineScrollRef}>
        {outlineItems.length > 0 ? <nav aria-label="笔记标题">
          <ol className="editor-outline-list">
            {outlineItems.map((item) => <li className={`editor-outline-item editor-outline-item--level-${item.level}`} key={item.id}><button type="button" title={item.title} data-outline-id={item.id} aria-current={activeOutlineId === item.id ? "true" : undefined} onClick={() => onScrollToOutlineItem(item.id)}><span className="outline-item-title">{item.title}</span></button></li>)}
          </ol>
        </nav> : <p className="editor-outline-empty">用 <code>#</code> 标题为这篇笔记建立大纲。</p>}
      </div>
      <FloatingScrollbar scrollTargetRef={outlineScrollRef} controlsId="note-outline-scroll-region" ariaLabel="笔记大纲滚动条" placement="right" enabled={!isFloating} />
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
  onToggleLayout?: () => void;
  transitionToken: number;

  isMobileViewport?: boolean;
  outlineOpen: boolean;
  outlineItems: OutlineItem[];
  activeOutlineId: string | null;
  onScrollToOutlineItem: (id: string) => void;
  onCloseOutline: () => void;
  onLoadMore?: () => void;
  isLoadingMore?: boolean;
  virtualizationScope: string;


  inert?: boolean;

};

export const NoteListPanel = memo(function NoteListPanel({ notes, total, hasMore = total > notes.length, sort, setSort, selectedId, selectedIds, onSelect, onDeleteSelected, view, query, currentNotebookName, onNewNote, onEmptyTrash, trashBusy, onClearQuery, isMobileViewport = false, onOpenSidebar, onToggleLayout, transitionToken, outlineOpen, outlineItems, activeOutlineId, onScrollToOutlineItem, onCloseOutline, onLoadMore, isLoadingMore = false, virtualizationScope, inert = false }: NoteListPanelProps) {
  const [sortOpen, setSortOpen] = useState(false);
  const sortRef = useRef<HTMLDivElement>(null);
  const sortTriggerRef = useRef<HTMLButtonElement>(null);
  const sortOptionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const noteListRef = useRef<HTMLDivElement>(null);
  const loadMoreSentinelRef = useRef<HTMLLIElement>(null);
  const panelRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    if (transitionToken === 0 || !panelRef.current) return;
    const panel = panelRef.current;
    const content = panel.querySelector<HTMLElement>(".note-list-content");
    if (!content) return;
    const animation = playEntranceAnimation(content, "page-content-in");
    return () => animation?.cancel();
  }, [transitionToken]);

  useEffect(() => {
    const sentinel = loadMoreSentinelRef.current;
    const container = noteListRef.current;
    if (!sentinel || !container || !hasMore || !onLoadMore || isLoadingMore) return;
    if (typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting) {
          onLoadMore();
        }
      },
      {
        root: container,
        rootMargin: "240px",
      }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, onLoadMore, isLoadingMore]);

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
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
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
  const virtualList = useVirtualNoteList(sortedNotes, noteListRef, virtualizationScope);
  const handleNoteListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    virtualList.moveTabFocus(event);
    if (event.defaultPrevented) return;
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    const target = event.target;
    if (target instanceof HTMLElement && (target.isContentEditable || target.matches("input, textarea, select"))) return;
    if ((event.key === "Delete" || event.key === "Backspace") && selectedIds.size > 0) {
      event.preventDefault();
      onDeleteSelected();
    }
  };
  const heading = query ? "搜索结果" : currentNotebookName ?? viewLabel(view);
  const truncated = hasMore;
  const hasLoadMoreRow = hasMore && Boolean(onLoadMore);
  const listSize = Math.max(total, sortedNotes.length);
  const listStyle: CSSProperties | undefined = virtualList.isVirtualized ? {
    position: "relative",
    height: `${virtualList.totalHeight + (hasLoadMoreRow ? 76 : 0)}px`,
  } : undefined;
  const noteListStyle: CSSProperties | undefined = virtualList.isVirtualized ? { overflowAnchor: "none" } : undefined;
  return <section ref={panelRef} className={`note-list-panel ${outlineOpen ? "is-outline-open" : ""}`} aria-label={outlineOpen ? "笔记大纲" : "笔记列表"} aria-hidden={inert || undefined} inert={inert}>
    <div className="note-list-content">
      {outlineOpen ? <NoteOutlinePanel outlineItems={outlineItems} activeOutlineId={activeOutlineId} onScrollToOutlineItem={onScrollToOutlineItem} onCloseOutline={onCloseOutline} /> : <>
      {isMobileViewport ? <MobileCollectionHeader active={!inert} heading={heading} total={total} shown={notes.length} query={query} sort={sort} onSort={setSort} onBack={onOpenSidebar} layout="three-column" onToggleLayout={onToggleLayout} onEmptyTrash={onEmptyTrash} trashBusy={trashBusy} /> : <header className="list-header">
        <button className="icon-button mobile-only" type="button" aria-label="打开导航" onClick={onOpenSidebar}><Menu size={20} /></button>
        <div className="list-header-main"><h2 tabIndex={-1}>{heading}</h2><p>{query ? `包含“${query}”的笔记` : `${truncated ? total : notes.length} 篇笔记`}{truncated && <> · 已显示最近 {notes.length} 篇</>}</p></div>
        <div className="list-header-controls">
          {onEmptyTrash && <button className="text-button text-danger empty-trash-button" type="button" aria-label="清空回收站" onClick={onEmptyTrash} disabled={trashBusy || total === 0}><Trash2 size={isMobileViewport ? 20 : 15} aria-hidden="true" />{!isMobileViewport && "清空回收站"}</button>}
          {onNewNote && !isMobileViewport && <button className="icon-button list-new-note-button" type="button" aria-label={`在${currentNotebookName}中新建笔记`} onClick={onNewNote}><Plus size={18} /></button>}

          <div className="sort-menu-wrap" ref={sortRef}>
            <button ref={sortTriggerRef} id="note-sort-trigger" className="sort-button" type="button" aria-haspopup="listbox" aria-controls="note-sort-options" aria-expanded={sortOpen} onClick={() => setSortOpen((open) => !open)}>
              <span className="sort-button-label">{SORT_OPTIONS.find((option) => option.value === sort)?.label}</span>
              <ChevronDown size={14} className="sort-button-arrow" />
            </button>
            {sortOpen && <div id="note-sort-options" className="sort-dropdown" role="listbox" aria-label="笔记排序方式">
              {SORT_OPTIONS.map((option, index) => {
                const isSelected = sort === option.value;
                return <button ref={(element) => { sortOptionRefs.current[index] = element; }} id={`note-sort-option-${option.value}`} key={option.value} type="button" className={`sort-option ${isSelected ? "is-active" : ""}`} role="option" aria-selected={isSelected} tabIndex={isSelected ? 0 : -1} onClick={() => { setSort(option.value); closeSortMenu(); }} onKeyDown={(event) => handleSortOptionKeyDown(event, index)}>{option.label}</button>;
              })}
            </div>}
          </div>
        </div>
      </header>}
      <div className="note-list-scroll-shell"><div id="note-list-scroll-region" className="note-list floating-scrollbar-target" ref={noteListRef} style={noteListStyle} onKeyDown={handleNoteListKeyDown} onFocusCapture={virtualList.onFocusCapture} onBlurCapture={virtualList.onBlurCapture}><ul className="note-list-items" role="list" style={listStyle}>{virtualList.visibleRows.map(({ note, index, top }) => <NoteListRow key={note.id} note={note} rowIndex={index} setSize={listSize} rowRef={virtualList.isVirtualized ? virtualList.getRowRef(note.id) : undefined} rowStyle={virtualList.rowStyle(top)} isSelected={selectedIds.has(note.id)} isActive={selectedId === note.id} showNotebook={!currentNotebookName && view !== "inbox"} onSelect={onSelect} />)}{hasLoadMoreRow && <li ref={loadMoreSentinelRef} className="note-list-load-more-item" style={virtualList.isVirtualized ? { position: "absolute", insetInline: 0, top: 0, transform: `translateY(${virtualList.totalHeight}px)` } : undefined}><button className="secondary-button note-list-load-more-button" type="button" onClick={onLoadMore} disabled={isLoadingMore}>{isLoadingMore ? "正在加载……" : `加载更多（已显示 ${notes.length} / ${total}）`}</button></li>}</ul>{!sortedNotes.length && (query ? <div className="list-empty"><span className="empty-icon"><Search size={23} /></span><strong>没有找到匹配的笔记</strong><span>试试更短的关键词，或清空搜索查看全部内容。</span><button className="secondary-button" type="button" onClick={onClearQuery}>清空搜索</button></div> : <div className="list-empty"><span className="empty-icon"><Archive size={23} /></span><strong>{view === "trash" ? "回收站是空的" : "这里还没有笔记"}</strong><span>{view === "trash" ? "移入回收站的笔记会显示在这里。" : "按下“新建笔记”，让一个想法有地方落脚。"}</span></div>)}</div><FloatingScrollbar scrollTargetRef={noteListRef} controlsId="note-list-scroll-region" ariaLabel="笔记列表滚动条" placement="left" /></div>
      </>}
    </div>
  </section>;
});

export function EmptyEditor({ isTrash, onNewNote, onOpenList, transitionToken }: { isTrash: boolean; onNewNote: () => void; onOpenList: () => void; transitionToken: number }) {
  return <section key={transitionToken} className="empty-editor"><button className="icon-button mobile-only empty-back" type="button" aria-label="打开笔记列表" onClick={onOpenList}><ChevronLeft size={20} /></button><BrandMark className="empty-editor-mark" /><h1 tabIndex={-1}>{isTrash ? "回收站是空的" : "让想法有地方落脚"}</h1><p>{isTrash ? "没有需要清理或恢复的笔记。" : "创建一篇笔记，记录此刻值得留下的东西。"}</p>{!isTrash && <><button className="primary-button" type="button" onClick={onNewNote}><Plus size={18} />新建笔记</button><span className="empty-shortcut">或按 {commandMenuShortcutLabel} 打开命令菜单</span></>}</section>;
}
