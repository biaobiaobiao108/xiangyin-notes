import { useEffect, useRef, useState, type RefObject } from "react";
import { ArrowLeftRight, ChevronDown, ChevronUp, ListTree, X } from "lucide-react";
import type { Editor } from "@tiptap/core";
import type { EditorStats } from "../editor-metrics";
import { TableEdgeControls } from "./table-edge-controls";

type SearchNavigation = {
  activeIndex: number;
  matchCount: number;
  totalMatchCount: number;
};

export function EditorFloatingTools({
  editor,
  outlineTriggerRef,
  outlineOpen,
  editorStats,
  onToggleOutline,
  hideOutlineTrigger = false,
  searchNavigation,
  searchQuery,
  deferredLoading,
  onMoveSearchMatch,
  onClearSearch,
  replaceOpen = false,
  replaceQuery = "",
  replacementText = "",
  replaceMatchNavigation = { activeIndex: 0, matchCount: 0, totalMatchCount: 0 },
  onToggleReplace,
  onChangeReplaceQuery,
  onChangeReplacementText,
  onMoveReplaceMatch,
  onReplaceCurrent,
  onReplaceAll,
  onCloseReplace,
}: {
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
  replaceOpen?: boolean;
  replaceQuery?: string;
  replacementText?: string;
  replaceMatchNavigation?: SearchNavigation;
  onToggleReplace?: () => void;
  onChangeReplaceQuery?: (value: string) => void;
  onChangeReplacementText?: (value: string) => void;
  onMoveReplaceMatch?: (direction: -1 | 1) => void;
  onReplaceCurrent?: () => void;
  onReplaceAll?: () => void;
  onCloseReplace?: () => void;
}) {
  const hasActiveSearch = Boolean(searchQuery?.trim());
  const hasSearchMatches = searchNavigation.totalMatchCount > 0;
  const navigationIsLimited = searchNavigation.totalMatchCount > searchNavigation.matchCount;
  const formattedTotalMatchCount = searchNavigation.totalMatchCount.toLocaleString("zh-CN");
  const hasReplaceMatches = replaceMatchNavigation.totalMatchCount > 0;
  const replaceMatchCount = replaceMatchNavigation.totalMatchCount.toLocaleString("zh-CN");
  const replaceDisabled =
    deferredLoading || !editor?.isEditable || !replaceQuery || !hasReplaceMatches;
  return (
    <div className="editor-floating-tools">
      {editor?.isEditable && (
        <TableEdgeControls editor={editor} deferredLoading={deferredLoading} />
      )}
      {replaceOpen && onChangeReplaceQuery && onChangeReplacementText && onCloseReplace && (
        <section
          className="editor-replace-panel"
          aria-label="查找并替换"
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onCloseReplace();
            } else if (
              event.key === "Enter" &&
              !event.nativeEvent.isComposing &&
              event.target instanceof HTMLInputElement
            ) {
              event.preventDefault();
              if (event.target.type === "search") onMoveReplaceMatch?.(event.shiftKey ? -1 : 1);
              else if (hasReplaceMatches && !replaceDisabled) onReplaceCurrent?.();
            }
          }}
        >
          <div className="editor-replace-fields">
            <label className="editor-replace-field">
              <span>查找</span>
              <input
                type="search"
                autoFocus
                value={replaceQuery}
                onChange={(event) => onChangeReplaceQuery(event.currentTarget.value)}
                placeholder="查找正文"
                aria-label="查找正文"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
              />
            </label>
            <label className="editor-replace-field">
              <span>替换为</span>
              <input
                type="text"
                value={replacementText}
                onChange={(event) => onChangeReplacementText(event.currentTarget.value)}
                placeholder="替换内容"
                aria-label="替换为"
                autoComplete="off"
              />
            </label>
          </div>
          <div className="editor-replace-actions">
            <div className="editor-replace-result" aria-live="polite">
              {hasReplaceMatches
                ? `${replaceMatchNavigation.activeIndex + 1} / ${replaceMatchCount}${replaceMatchNavigation.totalMatchCount > replaceMatchNavigation.matchCount ? `（前 ${replaceMatchNavigation.matchCount} 个可导航）` : ""}`
                : replaceQuery
                  ? "无匹配"
                  : "输入查找内容"}
            </div>
            <button
              className="editor-search-nav-button"
              type="button"
              aria-label="上一个替换匹配"
              onClick={() => onMoveReplaceMatch?.(-1)}
              disabled={deferredLoading || replaceMatchNavigation.matchCount < 2}
            >
              <ChevronUp size={16} strokeWidth={2} />
            </button>
            <button
              className="editor-search-nav-button"
              type="button"
              aria-label="下一个替换匹配"
              onClick={() => onMoveReplaceMatch?.(1)}
              disabled={deferredLoading || replaceMatchNavigation.matchCount < 2}
            >
              <ChevronDown size={16} strokeWidth={2} />
            </button>
            <button
              className="editor-replace-action"
              type="button"
              onClick={onReplaceCurrent}
              disabled={replaceDisabled}
            >
              替换
            </button>
            <button
              className="editor-replace-action editor-replace-action--all"
              type="button"
              onClick={onReplaceAll}
              disabled={replaceDisabled}
            >
              全部替换
            </button>
            <button
              className="editor-search-nav-button editor-search-nav-button--close"
              type="button"
              aria-label="关闭替换面板"
              onClick={onCloseReplace}
            >
              <X size={15} strokeWidth={2} />
            </button>
          </div>
        </section>
      )}
      <div className="editor-floating-row">
        {hasActiveSearch && !replaceOpen && (
          <div
            className="editor-search-nav"
            role="group"
            aria-label={
              hasSearchMatches
                ? `正文搜索结果，第 ${searchNavigation.activeIndex + 1} 个，共 ${formattedTotalMatchCount} 个${navigationIsLimited ? `，仅可导航前 ${searchNavigation.matchCount} 个` : ""}`
                : `当前笔记中未找到“${searchQuery?.trim()}”`
            }
          >
            {hasSearchMatches ? (
              <>
                <button
                  className="editor-search-nav-button"
                  type="button"
                  aria-label="上一个搜索匹配"
                  onClick={() => onMoveSearchMatch(-1)}
                  disabled={deferredLoading || searchNavigation.matchCount < 2}
                >
                  <ChevronUp size={16} strokeWidth={2} />
                </button>
                <span className="editor-search-nav-count" aria-live="polite">
                  {searchNavigation.activeIndex + 1} / {formattedTotalMatchCount}
                </span>
                <button
                  className="editor-search-nav-button"
                  type="button"
                  aria-label="下一个搜索匹配"
                  onClick={() => onMoveSearchMatch(1)}
                  disabled={deferredLoading || searchNavigation.matchCount < 2}
                >
                  <ChevronDown size={16} strokeWidth={2} />
                </button>
                {navigationIsLimited && (
                  <span
                    style={{ color: "var(--muted)", fontSize: "0.68rem", whiteSpace: "nowrap" }}
                  >
                    前 {searchNavigation.matchCount} 个可导航
                  </span>
                )}
              </>
            ) : (
              <span className="editor-search-nav-count editor-search-nav-count--empty">无匹配</span>
            )}
            {onClearSearch && (
              <button
                className="editor-search-nav-button editor-search-nav-button--close"
                type="button"
                aria-label="退出搜索高亮"
                onClick={onClearSearch}
              >
                <X size={15} strokeWidth={2} />
              </button>
            )}
            {onToggleReplace && (
              <button
                className={`editor-search-nav-button editor-search-nav-button--replace ${replaceOpen ? "is-active" : ""}`}
                type="button"
                aria-label={replaceOpen ? "关闭替换面板" : "打开替换面板"}
                aria-expanded={replaceOpen}
                onClick={onToggleReplace}
              >
                <ArrowLeftRight size={15} strokeWidth={2} />
                <span>替换</span>
              </button>
            )}
          </div>
        )}
        <EditorStatsPill stats={editorStats} />
        {!hideOutlineTrigger && (
          <button
            className={`outline-trigger ${outlineOpen ? "is-active" : ""}`}
            ref={outlineTriggerRef}
            type="button"
            aria-expanded={outlineOpen}
            aria-controls={outlineOpen ? "note-outline" : undefined}
            aria-label={outlineOpen ? "关闭笔记大纲" : "打开笔记大纲"}
            onClick={onToggleOutline}
            disabled={deferredLoading}
          >
            <ListTree size={16} strokeWidth={1.9} />
            <span>大纲</span>
          </button>
        )}
      </div>
    </div>
  );
}

export function EditorStatsPill({ stats }: { stats: EditorStats }) {
  return (
    <div
      className="editor-stats-pill"
      aria-label={`字数 ${stats.wordCount}，字符数 ${stats.characterCount}`}
    >
      <span className="editor-stat">
        <strong>{stats.wordCount}</strong>
        <span>字数</span>
      </span>
      <span className="editor-stat-divider" aria-hidden="true">
        ·
      </span>
      <span className="editor-stat">
        <strong>{stats.characterCount}</strong>
        <span>字符</span>
      </span>
    </div>
  );
}
