import type { RefObject } from "react";
import { ChevronDown, ChevronUp, ListTree, Minus, Plus, Trash2, X } from "lucide-react";
import type { Editor } from "@tiptap/core";
import type { EditorStats } from "../editor-metrics";

type SearchNavigation = {
  activeIndex: number;
  matchCount: number;
};

export function EditorFloatingTools({ editor, tableActive = false, outlineTriggerRef, outlineOpen, editorStats, onToggleOutline, outlineDisabled = false, outlineDisabledTitle, searchNavigation, searchQuery, deferredLoading, onMoveSearchMatch, onClearSearch }: {
  editor: Editor | null;
  tableActive?: boolean;
  outlineTriggerRef: RefObject<HTMLButtonElement | null>;
  outlineOpen: boolean;
  editorStats: EditorStats;
  onToggleOutline: () => void;
  outlineDisabled?: boolean;
  outlineDisabledTitle?: string;
  searchNavigation: SearchNavigation;
  searchQuery?: string;
  deferredLoading: boolean;
  onMoveSearchMatch: (direction: -1 | 1) => void;
  onClearSearch?: () => void;
}) {
  const hasActiveSearch = Boolean(searchQuery?.trim());
  return <div className="editor-floating-tools">
    {tableActive && editor && <div className="table-floating-toolbar" role="group" aria-label="表格操作">
      <button className="table-floating-button" type="button" aria-label="在下方插入行" title="在下方插入行" disabled={deferredLoading} onMouseDown={(event) => event.preventDefault()} onClick={() => editor.chain().focus().addRowAfter().run()}><Plus size={14} aria-hidden="true" /><span className="table-action-caption">行</span></button>
      <button className="table-floating-button" type="button" aria-label="删除当前行" title="删除当前行" disabled={deferredLoading || !editor.can().deleteRow()} onMouseDown={(event) => event.preventDefault()} onClick={() => editor.chain().focus().deleteRow().run()}><Minus size={14} aria-hidden="true" /><span className="table-action-caption">行</span></button>
      <span className="table-floating-divider" aria-hidden="true" />
      <button className="table-floating-button" type="button" aria-label="在右侧插入列" title="在右侧插入列" disabled={deferredLoading} onMouseDown={(event) => event.preventDefault()} onClick={() => editor.chain().focus().addColumnAfter().run()}><Plus size={14} aria-hidden="true" /><span className="table-action-caption">列</span></button>
      <button className="table-floating-button" type="button" aria-label="删除当前列" title="删除当前列" disabled={deferredLoading || !editor.can().deleteColumn()} onMouseDown={(event) => event.preventDefault()} onClick={() => editor.chain().focus().deleteColumn().run()}><Minus size={14} aria-hidden="true" /><span className="table-action-caption">列</span></button>
      <span className="table-floating-divider" aria-hidden="true" />
      <button className="table-floating-button table-floating-button--danger" type="button" aria-label="删除整个表格" title="删除整个表格" disabled={deferredLoading || !editor.can().deleteTable()} onMouseDown={(event) => event.preventDefault()} onClick={() => editor.chain().focus().deleteTable().run()}><Trash2 size={14} aria-hidden="true" /></button>
    </div>}
    <div className="editor-floating-row">
      {hasActiveSearch && <div className="editor-search-nav" role="group" aria-label={searchNavigation.matchCount > 0 ? `正文搜索结果，第 ${searchNavigation.activeIndex + 1} 个，共 ${searchNavigation.matchCount} 个` : `当前笔记中未找到“${searchQuery?.trim()}”`}>
        {searchNavigation.matchCount > 0 ? (
          <>
            <button className="editor-search-nav-button" type="button" aria-label="上一个搜索匹配" title="上一个搜索匹配 (Shift+F3)" onClick={() => onMoveSearchMatch(-1)} disabled={deferredLoading || searchNavigation.matchCount < 2}><ChevronUp size={16} strokeWidth={2} /></button>
            <span className="editor-search-nav-count" aria-live="polite">{searchNavigation.activeIndex + 1} / {searchNavigation.matchCount}</span>
            <button className="editor-search-nav-button" type="button" aria-label="下一个搜索匹配" title="下一个搜索匹配 (F3)" onClick={() => onMoveSearchMatch(1)} disabled={deferredLoading || searchNavigation.matchCount < 2}><ChevronDown size={16} strokeWidth={2} /></button>
          </>
        ) : (
          <span className="editor-search-nav-count editor-search-nav-count--empty">无匹配</span>
        )}
        {onClearSearch && <button className="editor-search-nav-button editor-search-nav-button--close" type="button" aria-label="退出搜索高亮" title="退出搜索高亮" onClick={onClearSearch}><X size={15} strokeWidth={2} /></button>}
      </div>}
      <EditorStatsPill stats={editorStats} />
      <button className={`outline-trigger ${outlineOpen ? "is-active" : ""}`} ref={outlineTriggerRef} type="button" aria-expanded={outlineOpen} aria-controls={outlineOpen ? "note-outline" : undefined} aria-label={outlineOpen ? "关闭笔记大纲" : "打开笔记大纲"} title={outlineDisabledTitle ?? (outlineOpen ? "关闭笔记大纲" : "打开笔记大纲")} onClick={onToggleOutline} disabled={deferredLoading || outlineDisabled}><ListTree size={16} strokeWidth={1.9} /><span>大纲</span></button>
    </div>
  </div>;
}

export function EditorStatsPill({ stats }: { stats: EditorStats }) {
  return <div className="editor-stats-pill" aria-label={`字数 ${stats.wordCount}，字符数 ${stats.characterCount}`}><span className="editor-stat"><strong>{stats.wordCount}</strong><span>字数</span></span><span className="editor-stat-divider" aria-hidden="true">·</span><span className="editor-stat"><strong>{stats.characterCount}</strong><span>字符</span></span></div>;
}
