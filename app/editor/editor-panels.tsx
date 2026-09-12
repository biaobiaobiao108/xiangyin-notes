import type { RefObject } from "react";
import { ChevronDown, ChevronUp, ListTree, X } from "lucide-react";
import type { EditorStats, OutlineItem } from "../editor-metrics";

type SearchNavigation = {
  activeIndex: number;
  matchCount: number;
};

export function EditorFloatingTools({ floatingToolsRef, outlineTriggerRef, outlineOpen, outlineItems, activeOutlineId, editorStats, onToggleOutline, onScrollToOutlineItem, searchNavigation, deferredLoading, onMoveSearchMatch, onClearSearch }: {
  floatingToolsRef: RefObject<HTMLDivElement | null>;
  outlineTriggerRef: RefObject<HTMLButtonElement | null>;
  outlineOpen: boolean;
  outlineItems: OutlineItem[];
  activeOutlineId: string | null;
  editorStats: EditorStats;
  onToggleOutline: () => void;
  onScrollToOutlineItem: (id: string) => void;
  searchNavigation: SearchNavigation;
  deferredLoading: boolean;
  onMoveSearchMatch: (direction: -1 | 1) => void;
  onClearSearch?: () => void;
}) {
  return <div className="editor-floating-tools" ref={floatingToolsRef}>
    <aside className="editor-outline" id="note-outline" aria-label="笔记大纲" hidden={!outlineOpen}>
      <div className="editor-outline-heading">
        <div>
          <span className="editor-outline-eyebrow">NAVIGATION</span>
          <h2>笔记大纲</h2>
        </div>
        <span className="editor-outline-count">{outlineItems.length}</span>
      </div>
      {outlineItems.length > 0 ? <nav aria-label="笔记标题">
        <ol className="editor-outline-list">
          {outlineItems.map((item) => <li className={`editor-outline-item editor-outline-item--level-${item.level}`} key={item.id}><button type="button" aria-current={activeOutlineId === item.id ? "true" : undefined} onClick={() => onScrollToOutlineItem(item.id)}><span className="outline-level-tag" aria-hidden="true">{`H${item.level}`}</span><span className="outline-item-title">{item.title}</span></button></li>)}
        </ol>
      </nav> : <p className="editor-outline-empty">用 <code>#</code> 标题为这篇笔记建立大纲。</p>}
    </aside>
    <div className="editor-floating-row">
      {searchNavigation.matchCount > 0 && <div className="editor-search-nav" role="group" aria-label={`正文搜索结果，第 ${searchNavigation.activeIndex + 1} 个，共 ${searchNavigation.matchCount} 个`}>
        <button className="editor-search-nav-button" type="button" aria-label="上一个搜索匹配" title="上一个搜索匹配 (Shift+F3)" onClick={() => onMoveSearchMatch(-1)} disabled={deferredLoading || searchNavigation.matchCount < 2}><ChevronUp size={16} strokeWidth={2} /></button>
        <span className="editor-search-nav-count" aria-live="polite">{searchNavigation.activeIndex + 1} / {searchNavigation.matchCount}</span>
        <button className="editor-search-nav-button" type="button" aria-label="下一个搜索匹配" title="下一个搜索匹配 (F3)" onClick={() => onMoveSearchMatch(1)} disabled={deferredLoading || searchNavigation.matchCount < 2}><ChevronDown size={16} strokeWidth={2} /></button>
        {onClearSearch && <button className="editor-search-nav-button editor-search-nav-button--close" type="button" aria-label="退出搜索高亮" title="退出搜索高亮" onClick={onClearSearch}><X size={15} strokeWidth={2} /></button>}
      </div>}
      <EditorStatsPill stats={editorStats} />
      <button className={`outline-trigger ${outlineOpen ? "is-active" : ""}`} ref={outlineTriggerRef} type="button" aria-expanded={outlineOpen} aria-controls="note-outline" aria-label={outlineOpen ? "关闭笔记大纲" : "打开笔记大纲"} onClick={onToggleOutline} disabled={deferredLoading}><ListTree size={16} strokeWidth={1.9} /><span>大纲</span></button>
    </div>
  </div>;
}

export function EditorStatsPill({ stats }: { stats: EditorStats }) {
  return <div className="editor-stats-pill" aria-label={`字数 ${stats.wordCount}，字符数 ${stats.characterCount}`}><span className="editor-stat"><strong>{stats.wordCount}</strong><span>字数</span></span><span className="editor-stat-divider" aria-hidden="true">·</span><span className="editor-stat"><strong>{stats.characterCount}</strong><span>字符</span></span></div>;
}
