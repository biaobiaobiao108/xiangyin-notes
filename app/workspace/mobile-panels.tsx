import { memo, useEffect, useRef, type RefObject } from "react";
import { ChevronRight, FolderPlus, Search, SquarePen, X } from "lucide-react";
import type { Notebook, NoteView } from "../../shared/types";
import { FloatingScrollbar } from "../floating-scrollbar";
import { getNotebookIconComponent, navItems } from "./helpers";
import "./mobile-panels.css";

export type MobileNotebookHomeProps = {
  view: NoteView;
  setView: (view: NoteView) => void;
  notebooks: Notebook[];
  notebookId?: string;
  setNotebookId: (id: string) => void;
  onCreateNotebook: () => void;
  onEditNotebook: (notebook: Notebook) => void;
};

export const MobileNotebookHome = memo(function MobileNotebookHome({ view, setView, notebooks, notebookId, setNotebookId, onCreateNotebook, onEditNotebook }: MobileNotebookHomeProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const customNotebooks = notebooks.filter((notebook) => !notebook.isSystem);

  return <section className="mobile-notebook-home" aria-labelledby="mobile-notebooks-title">
    <div className="mobile-home-scroll-shell">
      <div ref={scrollRef} id="mobile-notebooks-scroll" className="mobile-home-scroll floating-scrollbar-target">
        <h1 id="mobile-notebooks-title" className="mobile-home-title" tabIndex={-1} data-mobile-heading>笔记本</h1>
        <nav aria-label="笔记分类" className="mobile-home-group">
          <ul>{navItems.map((item) => {
            const Icon = item.icon;
            const count = item.id === "inbox" ? notebooks.find((notebook) => notebook.isSystem)?.count : item.id === "all" ? notebooks.reduce((sum, notebook) => sum + notebook.count, 0) : undefined;
            return <li key={item.id}><button type="button" className="mobile-notebook-link" aria-label={count === undefined ? item.label : `${item.label}，${count} 篇笔记`} aria-current={view === item.id && !notebookId ? "true" : undefined} onClick={() => setView(item.id)}>
              <span className="mobile-notebook-icon"><Icon size={22} /></span><span className="mobile-notebook-name">{item.label}</span>{count !== undefined && <span className="mobile-notebook-count">{count}</span>}<ChevronRight className="mobile-notebook-chevron" size={18} />
            </button></li>;
          })}</ul>
        </nav>
        <div className="mobile-home-section-heading"><h2>我的笔记本</h2><button className="mobile-plain-button" type="button" aria-label="新建笔记本" onClick={onCreateNotebook}><FolderPlus size={20} /></button></div>
        {customNotebooks.length > 0 ? <nav className="mobile-home-group" aria-label="自定义笔记本"><ul>{customNotebooks.map((notebook) => {
          return <li key={notebook.id} className="mobile-notebook-row"><MobileNotebookLink notebook={notebook} selected={notebook.id === notebookId} onOpen={setNotebookId} onEdit={onEditNotebook} /></li>;
        })}</ul></nav> : <div className="mobile-notebooks-empty"><p>为生活与灵感，留一本手记。</p><button type="button" onClick={onCreateNotebook}>新建笔记本</button></div>}
      </div>
      <FloatingScrollbar scrollTargetRef={scrollRef} controlsId="mobile-notebooks-scroll" ariaLabel="笔记本首页滚动条" placement="right" />
    </div>
  </section>;
});

function MobileNotebookLink({ notebook, selected, onOpen, onEdit }: { notebook: Notebook; selected: boolean; onOpen: (id: string) => void; onEdit: (notebook: Notebook) => void }) {
  const pressRef = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> | null; suppressClick: boolean }>({ x: 0, y: 0, timer: null, suppressClick: false });
  const clearPress = () => {
    if (pressRef.current.timer !== null) clearTimeout(pressRef.current.timer);
    pressRef.current.timer = null;
  };
  useEffect(() => () => clearPress(), []);
  const Icon = getNotebookIconComponent(notebook.icon);
  return <button type="button" className="mobile-notebook-link mobile-notebook-link--editable" aria-label={`${notebook.name}，${notebook.count} 篇笔记，长按编辑`} aria-current={selected ? "true" : undefined}
    onPointerDown={(event) => {
      clearPress();
      const press = pressRef.current;
      press.suppressClick = false;
      if (event.button !== 0) return;
      press.x = event.clientX;
      press.y = event.clientY;
      press.timer = setTimeout(() => { press.timer = null; press.suppressClick = true; onEdit(notebook); }, 500);
    }}
    onPointerMove={(event) => {
      const press = pressRef.current;
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 8) { clearPress(); press.suppressClick = true; }
    }}
    onPointerUp={clearPress}
    onPointerCancel={() => { clearPress(); pressRef.current.suppressClick = true; }}
    onPointerLeave={() => { if (pressRef.current.timer !== null) { clearPress(); pressRef.current.suppressClick = true; } }}
    onContextMenu={(event) => { event.preventDefault(); clearPress(); if (!pressRef.current.suppressClick) onEdit(notebook); pressRef.current.suppressClick = true; }}
    onKeyDown={(event) => { if (event.key === "F2") { event.preventDefault(); clearPress(); onEdit(notebook); } }}
    onClick={(event) => { clearPress(); if (pressRef.current.suppressClick && event.detail !== 0) { event.preventDefault(); return; } onOpen(notebook.id); }}>
    <span className="mobile-notebook-icon" style={{ color: notebook.color }}><Icon size={22} /></span><span className="mobile-notebook-name">{notebook.name}</span><span className="mobile-notebook-count">{notebook.count}</span><ChevronRight className="mobile-notebook-chevron" size={18} />
  </button>;
}

export type MobileBottomBarProps = {
  query: string;
  setQuery: (query: string) => void;
  onNewNote?: () => void;
  searchRef?: RefObject<HTMLInputElement | null>;
  label?: string;
};

export function MobileBottomBar({ query, setQuery, onNewNote, searchRef, label = "搜索笔记或标签" }: MobileBottomBarProps) {
  return <footer className="mobile-bottom-bar" aria-label="搜索与新建笔记">
    <div className="mobile-bottom-search"><Search size={21} aria-hidden="true" /><input ref={searchRef} type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索笔记或 #标签" aria-label={label} />{query && <button type="button" className="mobile-search-clear" aria-label="清空搜索" onClick={() => setQuery("")}><X size={18} /></button>}</div>
    {onNewNote && <button type="button" className="mobile-compose-button" aria-label="新建笔记" onClick={onNewNote}><SquarePen size={24} /></button>}
  </footer>;
}
