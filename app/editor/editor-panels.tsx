import type { RefObject } from "react";
import { ChevronDown, ChevronUp, Link2, ListTree, X } from "lucide-react";
import type { EditorStats } from "../editor-metrics";

type SearchNavigation = {
  activeIndex: number;
  matchCount: number;
};

export function EditorFloatingTools({ outlineTriggerRef, outlineOpen, editorStats, onToggleOutline, outlineDisabled = false, outlineDisabledTitle, searchNavigation, deferredLoading, onMoveSearchMatch, onClearSearch, backlinkCount = 0, onScrollToBacklinks }: {
  outlineTriggerRef: RefObject<HTMLButtonElement | null>;
  outlineOpen: boolean;
  editorStats: EditorStats;
  onToggleOutline: () => void;
  outlineDisabled?: boolean;
  outlineDisabledTitle?: string;
  searchNavigation: SearchNavigation;
  deferredLoading: boolean;
  onMoveSearchMatch: (direction: -1 | 1) => void;
  onClearSearch?: () => void;
  backlinkCount?: number;
  onScrollToBacklinks?: () => void;
}) {
  return <div className="editor-floating-tools">
    <div className="editor-floating-row">
      {searchNavigation.matchCount > 0 && <div className="editor-search-nav" role="group" aria-label={`正文搜索结果，第 ${searchNavigation.activeIndex + 1} 个，共 ${searchNavigation.matchCount} 个`}>
        <button className="editor-search-nav-button" type="button" aria-label="上一个搜索匹配" title="上一个搜索匹配 (Shift+F3)" onClick={() => onMoveSearchMatch(-1)} disabled={deferredLoading || searchNavigation.matchCount < 2}><ChevronUp size={16} strokeWidth={2} /></button>
        <span className="editor-search-nav-count" aria-live="polite">{searchNavigation.activeIndex + 1} / {searchNavigation.matchCount}</span>
        <button className="editor-search-nav-button" type="button" aria-label="下一个搜索匹配" title="下一个搜索匹配 (F3)" onClick={() => onMoveSearchMatch(1)} disabled={deferredLoading || searchNavigation.matchCount < 2}><ChevronDown size={16} strokeWidth={2} /></button>
        {onClearSearch && <button className="editor-search-nav-button editor-search-nav-button--close" type="button" aria-label="退出搜索高亮" title="退出搜索高亮" onClick={onClearSearch}><X size={15} strokeWidth={2} /></button>}
      </div>}
      <EditorStatsPill stats={editorStats} />
      {backlinkCount > 0 && onScrollToBacklinks && (
        <button className="backlinks-trigger" type="button" aria-label={`查看 ${backlinkCount} 条反向链接`} title="平滑滚动至正文底部反向链接" onClick={onScrollToBacklinks} disabled={deferredLoading}>
          <Link2 size={15} strokeWidth={1.9} />
          <span>反链</span>
          <em className="backlinks-trigger-badge">{backlinkCount}</em>
        </button>
      )}
      <button className={`outline-trigger ${outlineOpen ? "is-active" : ""}`} ref={outlineTriggerRef} type="button" aria-expanded={outlineOpen} aria-controls={outlineOpen ? "note-outline" : undefined} aria-label={outlineOpen ? "关闭笔记大纲" : "打开笔记大纲"} title={outlineDisabledTitle ?? (outlineOpen ? "关闭笔记大纲" : "打开笔记大纲")} onClick={onToggleOutline} disabled={deferredLoading || outlineDisabled}><ListTree size={16} strokeWidth={1.9} /><span>大纲</span></button>
    </div>
  </div>;
}

export function EditorStatsPill({ stats }: { stats: EditorStats }) {
  return <div className="editor-stats-pill" aria-label={`字数 ${stats.wordCount}，字符数 ${stats.characterCount}`}><span className="editor-stat"><strong>{stats.wordCount}</strong><span>字数</span></span><span className="editor-stat-divider" aria-hidden="true">·</span><span className="editor-stat"><strong>{stats.characterCount}</strong><span>字符</span></span></div>;
}
