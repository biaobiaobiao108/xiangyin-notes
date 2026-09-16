import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { ArrowLeftRight, ExternalLink, Link2, Loader2, Sparkles, X } from "lucide-react";
import { api } from "../api";
import { FloatingScrollbar } from "../floating-scrollbar";
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

export interface BacklinksDialogProps {
  open: boolean;
  onClose: () => void;
  noteId: string;
  noteTitle: string;
  onNavigateToNote: (id: string) => void;
  onBacklinkCountChange?: (count: number) => void;
}

export function BacklinksDialog({
  open,
  onClose,
  noteId,
  noteTitle,
  onNavigateToNote,
  onBacklinkCountChange,
}: BacklinksDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<NoteBacklinksResponse | null>(null);
  const [loading, setLoading] = useState(false);
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
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const handleNativeClose = () => onClose();
      dialog.setAttribute("closedby", "any");
      dialog.addEventListener("close", handleNativeClose);
      if (!dialog.open) {
        dialog.showModal();
      }
      void fetchBacklinks();
      return () => {
        dialog.removeEventListener("close", handleNativeClose);
        if (dialog.open) dialog.close();
        if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
      };
    } else {
      if (dialog.open) dialog.close();
    }
  }, [open, noteId]);

  const handleBackdropClick = (event: ReactMouseEvent<HTMLDialogElement>) => {
    if (event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const inside =
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom;
    if (!inside) onClose();
  };

  const handleNavigate = (sourceNoteId: string) => {
    onNavigateToNote(sourceNoteId);
    onClose();
  };

  const handleLinkMention = async (
    sourceNoteId: string,
    matchStart: number,
    matchTextLength: number,
    key: string,
  ) => {
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

  const switchTab = (tab: "linked" | "unlinked") => {
    setActiveTab(tab);
    if (bodyRef.current) {
      bodyRef.current.scrollTop = 0;
    }
  };

  if (!open) return null;

  const linkedCount = data?.linkedReferences?.length ?? 0;
  const unlinkedCount = data?.unlinkedMentions?.length ?? 0;
  const totalCount = linkedCount + unlinkedCount;

  return (
    <dialog
      ref={dialogRef}
      className="backlinks-dialog"
      aria-labelledby="backlinks-dialog-title"
      onClick={handleBackdropClick}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="backlinks-dialog-header">
        <div className="backlinks-dialog-header-start">
          <span className="backlinks-dialog-header-icon" aria-hidden="true">
            <ArrowLeftRight size={17} strokeWidth={2} />
          </span>
          <h2 id="backlinks-dialog-title" className="backlinks-dialog-title">
            反向链接
          </h2>
        </div>

        <div className="note-backlinks-tabs backlinks-dialog-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "linked"}
            className={`backlinks-tab ${activeTab === "linked" ? "is-active" : ""}`}
            onClick={() => switchTab("linked")}
          >
            已链接 ({linkedCount})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "unlinked"}
            className={`backlinks-tab ${activeTab === "unlinked" ? "is-active" : ""}`}
            onClick={() => switchTab("unlinked")}
          >
            <Sparkles size={12} aria-hidden="true" />
            未链接 ({unlinkedCount})
          </button>
        </div>

        <button
          className="icon-button backlinks-dialog-close"
          type="button"
          aria-label="关闭反向链接窗口"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </header>

      <div className="backlinks-dialog-body-shell">
        <div
          id="backlinks-dialog-scroll-region"
          ref={bodyRef}
          className="backlinks-dialog-body floating-scrollbar-target"
          role="tabpanel"
        >
          {loading && !data ? (
            <div className="backlinks-loading-state">
              <Loader2 size={18} className="spin-icon" />
              <span>正在加载反向链接…</span>
            </div>
          ) : totalCount === 0 ? (
            <div className="backlinks-empty-state">
              <p>暂无其他笔记引用当前文档</p>
              <small>
                在其他笔记中输入 <code>[[{noteTitle.trim() || "当前笔记"}]]</code> 即可建立反向链接
              </small>
            </div>
          ) : activeTab === "linked" ? (
            linkedCount === 0 ? (
              <div className="backlinks-empty-state">
                <p>暂无显式反向链接</p>
                <small>在其他笔记中使用 <code>[[{noteTitle.trim() || "当前笔记"}]]</code> 即可引用此笔记</small>
              </div>
            ) : (
              <ul className="backlinks-list" role="list">
                {data?.linkedReferences.map((item) => (
                  <li key={item.id} className="backlink-card">
                    <button
                      type="button"
                      className="backlink-card-header"
                      onClick={() => handleNavigate(item.sourceNoteId)}
                      title={`打开笔记「${item.sourceNoteTitle}」`}
                    >
                      <span className="backlink-card-title">{item.sourceNoteTitle || "未命名笔记"}</span>
                      {item.sourceNotebookName && (
                        <span className="backlink-card-notebook">{item.sourceNotebookName}</span>
                      )}
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
            <div className="backlinks-empty-state">
              <p>没有发现未链接提及</p>
              <small>当其他笔记包含与本笔记相同的标题文字时，可一键将其转为双向链接</small>
            </div>
          ) : (
            <ul className="backlinks-list" role="list">
              {data?.unlinkedMentions.map((item) => {
                const key = `${item.sourceNoteId}-${item.matchIndex}`;
                const isLinking = linkingKey === key;
                return (
                  <li key={key} className="backlink-card">
                    <div className="backlink-card-header">
                      <button
                        type="button"
                        className="backlink-card-title-button"
                        onClick={() => handleNavigate(item.sourceNoteId)}
                        title={`打开笔记「${item.sourceNoteTitle}」`}
                      >
                        <span className="backlink-card-title">{item.sourceNoteTitle || "未命名笔记"}</span>
                        {item.sourceNotebookName && (
                          <span className="backlink-card-notebook">{item.sourceNotebookName}</span>
                        )}
                        <time className="backlink-card-time">{relativeDate(item.updatedAt)}</time>
                      </button>
                      <button
                        type="button"
                        className="secondary-button backlink-link-button"
                        disabled={isLinking}
                        onClick={() =>
                          handleLinkMention(item.sourceNoteId, item.matchIndex, item.matchText.length, key)
                        }
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
        <FloatingScrollbar
          scrollTargetRef={bodyRef}
          controlsId="backlinks-dialog-scroll-region"
          ariaLabel="反向链接窗口滚动条"
          placement="right"
        />
      </div>
    </dialog>
  );
}

// 兼容导出
export const NoteBacklinksPanel = BacklinksDialog;
