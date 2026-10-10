import { useEffect, useRef, useState, type RefObject } from "react";
import { ChevronDown, ChevronUp, ListTree, X } from "lucide-react";
import type { Editor } from "@tiptap/core";
import type { EditorStats } from "../editor-metrics";
import { TableEdgeControls } from "./table-edge-controls";

type SearchNavigation = {
  activeIndex: number;
  matchCount: number;
  totalMatchCount: number;
};

export function EditorFloatingTools({ editor, outlineTriggerRef, outlineOpen, editorStats, onToggleOutline, hideOutlineTrigger = false, searchNavigation, searchQuery, deferredLoading, onMoveSearchMatch, onClearSearch }: {
  editor: Editor | null;
  outlineTriggerRef: RefObject<HTMLButtonElement | null>;
  outlineOpen: boolean;
  editorStats: EditorStats;
  onToggleOutline: () => void;
  hideOutlineTrigger?: boolean;
  searchNavigation: SearchNavigation;
  searchQuery?: string;
  deferredLoading: boolean;
  onMoveSearchMatch: (direction: -1 | 1) => void;
  onClearSearch?: () => void;
}) {
  const hasActiveSearch = Boolean(searchQuery?.trim());
  const hasSearchMatches = searchNavigation.totalMatchCount > 0;
  const navigationIsLimited = searchNavigation.totalMatchCount > searchNavigation.matchCount;
  const formattedTotalMatchCount = searchNavigation.totalMatchCount.toLocaleString("zh-CN");
  return <div className="editor-floating-tools">
    {editor?.isEditable && <TableEdgeControls editor={editor} deferredLoading={deferredLoading} />}
    <div className="editor-floating-row">
      {hasActiveSearch && <div className="editor-search-nav" role="group" aria-label={hasSearchMatches ? `正文搜索结果，第 ${searchNavigation.activeIndex + 1} 个，共 ${formattedTotalMatchCount} 个${navigationIsLimited ? `，仅可导航前 ${searchNavigation.matchCount} 个` : ""}` : `当前笔记中未找到“${searchQuery?.trim()}”`}>
        {hasSearchMatches ? (
          <>
            <button className="editor-search-nav-button" type="button" aria-label="上一个搜索匹配" onClick={() => onMoveSearchMatch(-1)} disabled={deferredLoading || searchNavigation.matchCount < 2}><ChevronUp size={16} strokeWidth={2} /></button>
            <span className="editor-search-nav-count" aria-live="polite">{searchNavigation.activeIndex + 1} / {formattedTotalMatchCount}</span>
            <button className="editor-search-nav-button" type="button" aria-label="下一个搜索匹配" onClick={() => onMoveSearchMatch(1)} disabled={deferredLoading || searchNavigation.matchCount < 2}><ChevronDown size={16} strokeWidth={2} /></button>
            {navigationIsLimited && <span style={{ color: "var(--muted)", fontSize: "0.68rem", whiteSpace: "nowrap" }}>前 {searchNavigation.matchCount} 个可导航</span>}
          </>
        ) : (
          <span className="editor-search-nav-count editor-search-nav-count--empty">无匹配</span>
        )}
        {onClearSearch && <button className="editor-search-nav-button editor-search-nav-button--close" type="button" aria-label="退出搜索高亮" onClick={onClearSearch}><X size={15} strokeWidth={2} /></button>}
      </div>}
      <EditorStatsPill stats={editorStats} />
      {!hideOutlineTrigger && <button className={`outline-trigger ${outlineOpen ? "is-active" : ""}`} ref={outlineTriggerRef} type="button" aria-expanded={outlineOpen} aria-controls={outlineOpen ? "note-outline" : undefined} aria-label={outlineOpen ? "关闭笔记大纲" : "打开笔记大纲"} onClick={onToggleOutline} disabled={deferredLoading}><ListTree size={16} strokeWidth={1.9} /><span>大纲</span></button>}
    </div>
  </div>;
}

export function EditorStatsPill({ stats }: { stats: EditorStats }) {
  return <div className="editor-stats-pill" aria-label={`字数 ${stats.wordCount}，字符数 ${stats.characterCount}`}><span className="editor-stat"><strong>{stats.wordCount}</strong><span>字数</span></span><span className="editor-stat-divider" aria-hidden="true">·</span><span className="editor-stat"><strong>{stats.characterCount}</strong><span>字符</span></span></div>;
}
