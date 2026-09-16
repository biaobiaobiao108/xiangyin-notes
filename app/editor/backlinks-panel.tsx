import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink, Link2, Loader2, Sparkles } from "lucide-react";
import { api } from "../api";
import type { NoteBacklinksResponse } from "../../shared/types";

function relativeDate(timestamp: number) {
  const diff = Math.max(0, Date.now() - timestamp * 1000);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return new Date(timestamp * 1000).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

function HighlightSnippet({ snippet, highlight }: { snippet: string; highlight: string }) {
  if (!highlight.trim()) return <span>{snippet}</span>;
  const escaped = highlight.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(${escaped})`, "gi");
  const parts = snippet.split(regex);

  return (
    <span className="backlink-snippet-text">
      {parts.map((part, index) =>
        regex.test(part) ? (
          <mark key={index} className="backlink-snippet-mark">
            {part}
          </mark>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </span>
  );
}

export function NoteBacklinksPanel({
  noteId,
  noteTitle,
  onNavigateToNote,
  onBacklinkCountChange,
}: {
  noteId: string;
  noteTitle: string;
  onNavigateToNote: (id: string) => void;
  onBacklinkCountChange?: (count: number) => void;
}) {
  const [data, setData] = useState<NoteBacklinksResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [activeTab, setActiveTab] = useState<"linked" | "unlinked">("linked");
  const [linkingKey, setLinkingKey] = useState<string | null>(null);

  const fetchBacklinks = async () => {
    try {
      setLoading(true);
      const res = await api.getBacklinks(noteId);
      setData(res);
      const totalCount = (res.linkedReferences?.length ?? 0) + (res.unlinkedMentions?.length ?? 0);
      onBacklinkCountChange?.(totalCount);
    } catch {
      // Offline fallback or error ignored gracefully
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchBacklinks();
  }, [noteId, noteTitle]);

  const handleLinkMention = async (sourceNoteId: string, matchStart: number, matchTextLength: number, key: string) => {
    try {
      setLinkingKey(key);
      await api.linkMention(noteId, {
        sourceNoteId,
        matchStart,
        matchEnd: matchStart + matchTextLength,
      });
      await fetchBacklinks();
    } finally {
      setLinkingKey(null);
    }
  };

  const linkedCount = data?.linkedReferences?.length ?? 0;
  const unlinkedCount = data?.unlinkedMentions?.length ?? 0;
  const totalCount = linkedCount + unlinkedCount;

  if (totalCount === 0 && !loading) {
    return (
      <section className="note-backlinks-panel is-empty" aria-label="反向链接">
        <div className="note-backlinks-header is-empty-header">
          <div className="note-backlinks-title">
            <Link2 size={16} aria-hidden="true" />
            <span>反向链接与引用</span>
            <span className="backlinks-count-pill">0</span>
          </div>
          <span className="backlinks-empty-hint">暂无其他笔记引用当前文档</span>
        </div>
      </section>
    );
  }

  return (
    <section className={`note-backlinks-panel ${collapsed ? "is-collapsed" : ""}`} id="note-backlinks-section" aria-label="反向链接与引用">
      <header className="note-backlinks-header">
        <button
          type="button"
          className="note-backlinks-toggle"
          onClick={() => setCollapsed((v) => !v)}
          aria-expanded={!collapsed}
          aria-controls="note-backlinks-body"
        >
          {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
          <span className="note-backlinks-title-text">反向链接与引用</span>
          <span className="backlinks-count-pill">{totalCount}</span>
        </button>

        {!collapsed && (
          <div className="note-backlinks-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "linked"}
              className={`backlinks-tab ${activeTab === "linked" ? "is-active" : ""}`}
              onClick={() => setActiveTab("linked")}
            >
              已链接引用 ({linkedCount})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "unlinked"}
              className={`backlinks-tab ${activeTab === "unlinked" ? "is-active" : ""}`}
              onClick={() => setActiveTab("unlinked")}
            >
              <Sparkles size={13} aria-hidden="true" />
              未链接提及 ({unlinkedCount})
            </button>
          </div>
        )}
      </header>

      {!collapsed && (
        <div id="note-backlinks-body" className="note-backlinks-body" role="tabpanel">
          {activeTab === "linked" ? (
            linkedCount === 0 ? (
              <p className="backlinks-body-empty">暂无显式反向链接</p>
            ) : (
              <ul className="backlinks-list" role="list">
                {data?.linkedReferences.map((item) => (
                  <li key={item.id} className="backlink-card">
                    <button
                      type="button"
                      className="backlink-card-header"
                      onClick={() => onNavigateToNote(item.sourceNoteId)}
                      title={`打开笔记「${item.sourceNoteTitle}」`}
                    >
                      <span className="backlink-card-title">{item.sourceNoteTitle || "未命名笔记"}</span>
                      <span className="backlink-card-notebook">{item.sourceNotebookName}</span>
                      <time className="backlink-card-time">{relativeDate(item.updatedAt)}</time>
                      <ExternalLink size={13} className="backlink-card-open-icon" aria-hidden="true" />
                    </button>
                    {item.snippet && (
                      <div className="backlink-card-snippet">
                        <HighlightSnippet snippet={item.snippet} highlight={noteTitle} />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )
          ) : unlinkedCount === 0 ? (
            <p className="backlinks-body-empty">没有发现未链接提及</p>
          ) : (
            <ul className="backlinks-list" role="list">
              {data?.unlinkedMentions.map((item, index) => {
                const key = `${item.sourceNoteId}-${item.matchIndex}`;
                const isLinking = linkingKey === key;
                return (
                  <li key={key} className="backlink-card">
                    <div className="backlink-card-header">
                      <button
                        type="button"
                        className="backlink-card-title-button"
                        onClick={() => onNavigateToNote(item.sourceNoteId)}
                        title={`打开笔记「${item.sourceNoteTitle}」`}
                      >
                        <span className="backlink-card-title">{item.sourceNoteTitle || "未命名笔记"}</span>
                        <span className="backlink-card-notebook">{item.sourceNotebookName}</span>
                        <time className="backlink-card-time">{relativeDate(item.updatedAt)}</time>
                      </button>
                      <button
                        type="button"
                        className="secondary-button backlink-link-button"
                        disabled={isLinking}
                        onClick={() => handleLinkMention(item.sourceNoteId, item.matchIndex, item.matchText.length, key)}
                      >
                        {isLinking ? <Loader2 size={13} className="spin-icon" /> : <Link2 size={13} />}
                        <span>添加链接</span>
                      </button>
                    </div>
                    {item.snippet && (
                      <div className="backlink-card-snippet">
                        <HighlightSnippet snippet={item.snippet} highlight={item.matchText} />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
