import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { ArrowLeftRight, ExternalLink, Link2, Loader2, Sparkles, X } from "lucide-react";
import { ApiError, api } from "../api";
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

export function cleanDisplayTitle(title: string | null | undefined): string {
  if (!title) return "未命名笔记";
  const stripped = title.replace(/^(?:\[\[|【【)\s*|\s*(?:\]\]|】】)$/g, "").trim();
  return stripped || "未命名笔记";
}

export function cleanSnippetForDisplay(snippet: string): string {
  if (!snippet) return "";
  return snippet
    // Replace [[target|alias]] or 【【target｜alias】】 with alias or target
    .replace(/(?:\[\[|【【)([^\]】\r\n|｜]+)(?:[|｜]([^\]】\r\n]+))?(?:\]\]|】】)/g, (_, target, alias) => {
      return (alias || target).trim();
    })
    // Also remove any stray double brackets if any
    .replace(/\[\[|\]\]|【【|】】/g, "")
    // Remove leading markdown heading markers
    .replace(/^#{1,6}\s+/, "");
}

function HighlightSnippet({ snippet, highlight }: { snippet: string; highlight: string }) {
  const cleanHighlight = cleanDisplayTitle(highlight).trim();
  const candidates = new Set<string>();
  if (cleanHighlight) {
    candidates.add(cleanHighlight);
  }

  // If there are aliases for this target in the snippet, add them to candidate highlights
  const linkRegex = /(?:\[\[|【【)([^\]】\r\n|｜]+)(?:[|｜]([^\]】\r\n]+))?(?:\]\]|】】)/g;
  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(snippet)) !== null) {
    const target = match[1]?.trim();
    const alias = match[2]?.trim();
    if (target && cleanHighlight && target.toLowerCase() === cleanHighlight.toLowerCase() && alias) {
      candidates.add(alias);
    }
  }

  const cleaned = cleanSnippetForDisplay(snippet);
  const sortedCandidates = Array.from(candidates).filter(Boolean).sort((a, b) => b.length - a.length);

  if (!sortedCandidates.length) return <span>{cleaned}</span>;

  const pattern = sortedCandidates.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const regex = new RegExp(`(${pattern})`, "gi");
  const parts = cleaned.split(regex);

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

export type BacklinkUnifiedItem =
  | {
      kind: "linked";
      id: string;
      sourceNoteId: string;
      sourceNoteTitle: string;
      sourceNotebookName: string;
      updatedAt: number;
      snippet: string;
    }
  | {
      kind: "unlinked";
      id: string;
      sourceNoteId: string;
      sourceNoteTitle: string;
      sourceNotebookName: string;
      updatedAt: number;
      snippet: string;
      matchIndex: number;
      matchText: string;
      sourceVersion: number;
    };

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
  const [linkingKey, setLinkingKey] = useState<string | null>(null);
  const [error, setError] = useState("");

  const fetchBacklinks = async () => {
    try {
      setLoading(true);
      setError("");
      const res = await api.getBacklinks(noteId);
      setData(res);
      const totalCount = (res.linkedReferences?.length ?? 0) + (res.unlinkedMentions?.length ?? 0);
      onBacklinkCountChange?.(totalCount);
    } catch {
      setError("反向链接加载失败，请稍后重试");
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
    sourceVersion: number,
    matchStart: number,
    matchText: string,
    key: string,
  ) => {
    try {
      setLinkingKey(key);
      setError("");
      await api.linkMention(noteId, {
        sourceNoteId,
        sourceVersion,
        matchStart,
        matchEnd: matchStart + matchText.length,
        matchText,
      });
      await fetchBacklinks();
    } catch (reason) {
      const message = reason instanceof ApiError && reason.code === "MENTION_STALE" ? reason.message : "添加链接失败，请重试";
      await fetchBacklinks();
      setError(message);
    } finally {
      setLinkingKey(null);
    }
  };

  const unifiedItems: BacklinkUnifiedItem[] = useMemo(() => {
    if (!data) return [];
    const linked: BacklinkUnifiedItem[] = (data.linkedReferences || []).map((item) => ({
      kind: "linked",
      id: item.id,
      sourceNoteId: item.sourceNoteId,
      sourceNoteTitle: item.sourceNoteTitle,
      sourceNotebookName: item.sourceNotebookName,
      updatedAt: item.updatedAt,
      snippet: item.snippet,
    }));
    const unlinked: BacklinkUnifiedItem[] = (data.unlinkedMentions || []).map((item) => ({
      kind: "unlinked",
      id: `${item.sourceNoteId}-${item.matchIndex}`,
      sourceNoteId: item.sourceNoteId,
      sourceNoteTitle: item.sourceNoteTitle,
      sourceNotebookName: item.sourceNotebookName,
      updatedAt: item.updatedAt,
      snippet: item.snippet,
      matchIndex: item.matchIndex,
      matchText: item.matchText,
      sourceVersion: item.sourceVersion,
    }));
    return [...linked, ...unlinked].sort((a, b) => b.updatedAt - a.updatedAt);
  }, [data]);

  if (!open) return null;

  const totalCount = unifiedItems.length;

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
          {totalCount > 0 && <span className="backlinks-count-pill">{totalCount}</span>}
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
        >
          {error && <p className="backlinks-error" role="alert">{error}</p>}
          {loading && !data ? (
            <div className="backlinks-loading-state">
              <Loader2 size={18} className="spin-icon" />
              <span>正在加载反向链接…</span>
            </div>
          ) : totalCount === 0 ? (
            <div className="backlinks-empty-state">
              <p>暂无其他笔记引用当前文档</p>
              <small>
                在其他笔记中输入 <code>[[{cleanDisplayTitle(noteTitle)}]]</code> 即可建立反向链接
              </small>
            </div>
          ) : (
            <ul className="backlinks-list" role="list">
              {unifiedItems.map((item) => {
                const isUnlinked = item.kind === "unlinked";
                const isLinking = isUnlinked && linkingKey === item.id;
                const displayTitle = cleanDisplayTitle(item.sourceNoteTitle);
                return (
                  <li key={item.id} className="backlink-card">
                    <div className="backlink-card-header">
                      <button
                        type="button"
                        className="backlink-card-title-button"
                        onClick={() => handleNavigate(item.sourceNoteId)}
                        title={`打开笔记「${displayTitle}」`}
                      >
                        <span className="backlink-card-title">
                          {displayTitle}
                        </span>
                        {item.sourceNotebookName && (
                          <span className="backlink-card-notebook">
                            {item.sourceNotebookName}
                          </span>
                        )}
                        <span
                          className={`backlink-kind-badge ${
                            isUnlinked ? "is-unlinked" : "is-linked"
                          }`}
                        >
                          {isUnlinked ? (
                            <>
                              <Sparkles size={11} aria-hidden="true" />
                              <span>提及</span>
                            </>
                          ) : (
                            <>
                              <Link2 size={11} aria-hidden="true" />
                              <span>已链接</span>
                            </>
                          )}
                        </span>
                        <time className="backlink-card-time">{relativeDate(item.updatedAt)}</time>
                      </button>

                      {isUnlinked ? (
                        <button
                          type="button"
                          className="backlink-link-button"
                          disabled={isLinking}
                          onClick={() =>
                            handleLinkMention(
                              item.sourceNoteId,
                              item.sourceVersion,
                              item.matchIndex,
                              item.matchText,
                              item.id,
                            )
                          }
                        >
                          {isLinking ? (
                            <Loader2 size={12} className="spin-icon" />
                          ) : (
                            <Link2 size={12} />
                          )}
                          <span>添加链接</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="backlink-card-open-btn"
                          onClick={() => handleNavigate(item.sourceNoteId)}
                          aria-label={`打开笔记「${displayTitle}」`}
                          title="打开笔记"
                        >
                          <ExternalLink size={13} aria-hidden="true" />
                        </button>
                      )}
                    </div>

                    {item.snippet && (
                      <div className="backlink-card-snippet">
                        <HighlightSnippet
                          snippet={item.snippet}
                          highlight={isUnlinked ? item.matchText : cleanDisplayTitle(noteTitle)}
                        />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {data?.truncated && <p className="backlinks-truncated-hint" role="status">结果较多，仅显示最近的部分引用。</p>}
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
