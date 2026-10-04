import { memo, useRef, type CSSProperties, type RefObject } from "react";
import { ChevronRight, FolderPlus, LogOut, Pencil, Search, SlidersHorizontal, SquarePen, Trash2, X } from "lucide-react";
import type { Notebook, NoteView } from "../../shared/types";
import { BrandMark } from "../brand-mark";
import { FloatingScrollbar } from "../floating-scrollbar";
import { getNotebookIconComponent, navItems } from "./helpers";
import { useSwipeActionGesture, useSwipeActionGroup } from "./swipe-actions";
import "./mobile-panels.css";

export type MobileNotebookHomeProps = {
  view: NoteView;
  setView: (view: NoteView) => void;
  notebooks: Notebook[];
  notebookId?: string;
  setNotebookId: (id: string) => void;
  onCreateNotebook: () => void;
  onEditNotebook: (notebook: Notebook) => void;
  onDeleteNotebook: (notebook: Notebook) => void;
  onLogout: () => void;
  active?: boolean;
};

export const MobileNotebookHome = memo(function MobileNotebookHome({ view, setView, notebooks, notebookId, setNotebookId, onCreateNotebook, onEditNotebook, onDeleteNotebook, onLogout, active = true }: MobileNotebookHomeProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const swipeActions = useSwipeActionGroup(scrollRef, active, active ? "home" : "inactive");
  const customNotebooks = notebooks.filter((notebook) => !notebook.isSystem);

  return <section className="mobile-notebook-home" aria-labelledby="mobile-notebooks-title">
    <div className="mobile-home-scroll-shell">
      <div ref={scrollRef} id="mobile-notebooks-scroll" className="mobile-home-scroll floating-scrollbar-target">
        <h1 id="mobile-notebooks-title" className="mobile-home-title" tabIndex={-1} data-mobile-heading><BrandMark className="mobile-home-brand-mark" /><span>象映笔记</span></h1>
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
          return <li key={notebook.id} className="mobile-notebook-row"><MobileNotebookLink notebook={notebook} selected={notebook.id === notebookId} onOpen={setNotebookId} onEdit={onEditNotebook} onDelete={onDeleteNotebook} open={swipeActions.openId === notebook.id} setOpenId={swipeActions.setOpenId} /></li>;
        })}</ul></nav> : <div className="mobile-notebooks-empty"><p>为生活与灵感，留一本手记。</p><button type="button" onClick={onCreateNotebook}>新建笔记本</button></div>}
        <button className="mobile-logout-button" type="button" onClick={onLogout}><LogOut size={18} aria-hidden="true" />退出登录</button>
      </div>
      <FloatingScrollbar scrollTargetRef={scrollRef} controlsId="mobile-notebooks-scroll" ariaLabel="笔记本首页滚动条" placement="right" />
    </div>
  </section>;
});

function MobileNotebookLink({ notebook, selected, onOpen, onEdit, onDelete, open, setOpenId }: { notebook: Notebook; selected: boolean; onOpen: (id: string) => void; onEdit: (notebook: Notebook) => void; onDelete: (notebook: Notebook) => void; open: boolean; setOpenId: (id: string | null) => void }) {
  const foregroundRef = useRef<HTMLButtonElement>(null);
  const gesture = useSwipeActionGesture({ enabled: true, itemId: notebook.id, open, actionWidth: 144, onOpenChange: setOpenId, foregroundRef });
  const Icon = getNotebookIconComponent(notebook.icon);
  return <div className={`swipe-action-row mobile-notebook-swipe${open ? " is-swipe-open" : ""}`} style={{ "--swipe-action-width": "144px" } as CSSProperties} {...gesture}>
    <div id={`notebook-actions-${notebook.id}`} className="swipe-action-buttons" role="group" aria-label={`${notebook.name}的操作`}>
      <button type="button" className="swipe-action-button" aria-label={`编辑笔记本：${notebook.name}`} onClick={() => { setOpenId(null); onEdit(notebook); }}><span className="swipe-action-icon"><Pencil size={17} aria-hidden="true" /></span><span>编辑</span></button>
      <button type="button" className="swipe-action-button is-danger" aria-label={`删除笔记本：${notebook.name}`} onClick={() => { setOpenId(null); onDelete(notebook); }}><span className="swipe-action-icon"><Trash2 size={17} aria-hidden="true" /></span><span>删除</span></button>
    </div>
    <button ref={foregroundRef} type="button" className="mobile-notebook-link mobile-notebook-link--editable swipe-action-foreground" aria-label={`${notebook.name}，${notebook.count} 篇笔记，向左轻扫显示编辑和删除操作`} aria-current={selected ? "true" : undefined} aria-expanded={open} aria-controls={`notebook-actions-${notebook.id}`} onKeyDown={(event) => { if (event.key === "F2") { event.preventDefault(); onEdit(notebook); } }} onClick={() => onOpen(notebook.id)}>
      <span className="mobile-notebook-icon" style={{ color: notebook.color }}><Icon size={22} /></span><span className="mobile-notebook-name">{notebook.name}</span><span className="mobile-notebook-count">{notebook.count}</span><ChevronRight className="mobile-notebook-chevron" size={18} />
    </button>
  </div>;
}

export type MobileBottomBarProps = {
  query: string;
  setQuery: (query: string) => void;
  onNewNote?: () => void;
  searchRef?: RefObject<HTMLInputElement | null>;
  label?: string;
  onOpenCommands: () => void;
};

export function MobileBottomBar({ query, setQuery, onNewNote, searchRef, onOpenCommands, label = "搜索笔记或标签" }: MobileBottomBarProps) {
  return <footer className="mobile-bottom-bar" aria-label="搜索与新建笔记">
    <button className="mobile-compose-button" type="button" aria-label="打开命令面板" onClick={onOpenCommands}><SlidersHorizontal size={22} aria-hidden="true" /></button>
    <div className="mobile-bottom-search"><Search size={21} aria-hidden="true" /><input ref={searchRef} type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索笔记或 #标签" aria-label={label} />{query && <button type="button" className="mobile-search-clear" aria-label="清空搜索" onClick={() => setQuery("")}><X size={18} /></button>}</div>
    {onNewNote && <button type="button" className="mobile-compose-button" aria-label="新建笔记" onClick={onNewNote}><SquarePen size={24} /></button>}
  </footer>;
}
