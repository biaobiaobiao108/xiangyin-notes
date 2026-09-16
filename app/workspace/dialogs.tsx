import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { AlertTriangle, Check, Clock3, Copy, FileText, Folder, Link2, Plus, RefreshCw, Share2, ShieldCheck, X } from "lucide-react";
import { ApiError, api } from "../api";
import { FloatingScrollbar } from "../floating-scrollbar";
import type { Note, Notebook, Share } from "../../shared/types";
import { errorMessage, formatDate, notebookColorOptions } from "./helpers";

export type ConfirmRequest = {
  id: number;
  eyebrow: string;
  title: string;
  description: string;
  confirmLabel: string;
  danger?: boolean;
  returnFocus?: HTMLElement | null;
  onConfirm: () => void | Promise<void>;
};

export function ConfirmDialog({ request, onClose }: { request: ConfirmRequest; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const submittingRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      const trigger = request.returnFocus;
      const target = trigger?.isConnected && !trigger.matches(":disabled") ? trigger : document.querySelector<HTMLElement>(".note-row.is-selected") ?? document.querySelector<HTMLElement>(".note-list-panel.is-mobile-open .list-header h2, .empty-editor h1");
      target?.focus({ preventScroll: true });
    };
  }, [request]);
  const confirm = async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setBusy(true);
    setError("");
    try { await request.onConfirm(); onClose(); } catch (reason) { setError(errorMessage(reason, "操作失败，请重试")); } finally { submittingRef.current = false; setBusy(false); }
  };
  return <dialog ref={dialogRef} className="confirm-dialog" aria-labelledby="confirm-dialog-title" aria-describedby="confirm-dialog-description" aria-busy={busy} onCancel={(event) => { event.preventDefault(); if (!submittingRef.current) onClose(); }}><div className="dialog-heading"><div><span className={`dialog-eyebrow ${request.danger ? "is-danger" : ""}`}>{request.danger ? <AlertTriangle size={15} /> : <RefreshCw size={15} />}{request.eyebrow}</span><h2 id="confirm-dialog-title">{request.title}</h2><p id="confirm-dialog-description">{request.description}</p>{error && <p className="text-danger" role="alert">{error}</p>}</div></div><div className="dialog-actions"><button className="secondary-button" type="button" autoFocus disabled={busy} onClick={onClose}>取消</button><button className={`primary-button ${request.danger ? "danger-primary" : ""}`} type="button" disabled={busy} onClick={() => void confirm()}>{busy ? "正在处理……" : request.confirmLabel}</button></div></dialog>;
}

export function ShareDialog({ note, onClose, onToast }: { note: Note; onClose: () => void; onToast: (message: string) => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const shareUrlRef = useRef<HTMLInputElement>(null);
  const [shares, setShares] = useState<Share[]>([]);
  const [newUrl, setNewUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingShares, setLoadingShares] = useState(true);
  const [copied, setCopied] = useState(false);
  const [copiedShareId, setCopiedShareId] = useState<string | null>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const handleNativeClose = () => onClose();
    dialog.setAttribute("closedby", "any");
    dialog.addEventListener("close", handleNativeClose);
    dialog.showModal();
    void api.listShares(note.id)
      .then((result) => setShares(result.shares))
      .catch(() => onToast("加载分享记录失败"))
      .finally(() => setLoadingShares(false));
    return () => {
      dialog.removeEventListener("close", handleNativeClose);
      if (dialog.open) dialog.close();
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    };
  }, [note.id]);
  const create = async () => {
    setBusy(true);
    setCopied(false);
    try {
      const result = await api.createShare(note.id);
      setShares((current) => [result.share, ...current]);
      setNewUrl(result.share.url ?? "");
      requestAnimationFrame(() => shareUrlRef.current?.select());
      onToast("分享链接已生成");
    } catch {
      onToast("生成分享链接失败");
    } finally {
      setBusy(false);
    }
  };
  const copy = async (url: string, shareId?: string) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard-unavailable");
      await navigator.clipboard.writeText(url);
      if (shareId) {
        setCopiedShareId(shareId);
        setTimeout(() => setCopiedShareId(null), 2000);
      } else {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
      onToast("链接已复制");
    } catch {
      shareUrlRef.current?.select();
      onToast("复制失败，请手动复制选中的链接");
    }
  };
  const revoke = async (id: string) => {
    try {
      await api.revokeShare(id);
      setShares((current) => current.map((share) => (share.id === id ? { ...share, revokedAt: Math.floor(Date.now() / 1000) } : share)));
      onToast("分享已撤销");
    } catch {
      onToast("撤销分享失败，请重试");
    }
  };
  const handleBackdropClick = (event: ReactMouseEvent<HTMLDialogElement>) => {
    if (event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
    if (!inside) onClose();
  };
  return (
    <dialog
      ref={dialogRef}
      className="share-dialog"
      aria-labelledby="share-dialog-title"
      onClick={handleBackdropClick}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="share-dialog-heading">
        <div className="share-dialog-header-main">
          <div className="share-dialog-title-row">
            <span className="share-dialog-badge" aria-hidden="true"><Share2 size={15} /></span>
            <h2 id="share-dialog-title">分享笔记</h2>
          </div>
          <div className="share-dialog-subtitle">
            <span className="share-note-title" title={note.title || "未命名笔记"}>{note.title || "未命名笔记"}</span>
            {note.notebookName && <span className="share-notebook-tag">{note.notebookName}</span>}
          </div>
        </div>
        <button className="icon-button share-dialog-close" type="button" aria-label="关闭分享窗口" onClick={onClose}><X size={17} /></button>
      </header>
      <div className="share-dialog-body-shell">
        <div id="share-dialog-scroll-region" ref={bodyRef} className="share-dialog-body floating-scrollbar-target">
          <section className="share-create-panel" aria-label="创建公开分享">
            <div className="share-create-desc">
              <p className="share-create-summary">为当前内容创建一份独立、只读的公开快照。</p>
              <div className="share-policy-tags">
                <span className="share-policy-tag"><Clock3 size={13} aria-hidden="true" /><span>7 天有效</span></span>
                <span className="share-policy-tag"><ShieldCheck size={13} aria-hidden="true" /><span>只读快照</span></span>
              </div>
            </div>
            <div className="share-action-row">
              <button className="primary-button share-generate-btn" type="button" onClick={() => void create()} disabled={busy}>
                <Plus size={15} />
                <span>{busy ? "正在生成……" : newUrl ? "重新生成链接" : "生成分享链接"}</span>
              </button>
            </div>
            {newUrl && (
              <div className="share-result-bar" role="status">
                <span className="share-result-icon" aria-hidden="true"><Link2 size={15} /></span>
                <input ref={shareUrlRef} value={newUrl} readOnly aria-label="分享链接" onFocus={(event) => event.currentTarget.select()} />
                <button className={`secondary-button share-copy-btn ${copied ? "is-copied" : ""}`} type="button" onClick={() => void copy(newUrl)}>
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                  <span>{copied ? "已复制" : "复制"}</span>
                </button>
              </div>
            )}
          </section>
          <section className="share-history" aria-labelledby="share-history-title">
            <div className="share-history-header">
              <h3 id="share-history-title">分享记录</h3>
              {shares.length > 0 && <span className="share-history-count">{shares.length}</span>}
            </div>
            {loadingShares ? (
              <p className="share-history-empty" role="status">正在加载分享记录……</p>
            ) : shares.length === 0 ? (
              <p className="share-history-empty">暂无历史分享记录</p>
            ) : (
              <div className="share-history-list">
                {shares.map((share) => {
                  const inactive = Boolean(share.revokedAt || share.expiresAt * 1000 < Date.now());
                  const isThisCopied = copiedShareId === share.id;
                  return (
                    <div className={`share-history-item ${inactive ? "is-inactive" : ""}`} key={share.id}>
                      <div className="share-history-left">
                        <span className={`share-status-dot ${inactive ? "is-inactive" : "is-active"}`} aria-hidden="true" />
                        <div className="share-history-info">
                          <div className="share-history-status-row">
                            <span className="share-history-status">
                              {share.revokedAt ? "已撤销" : share.expiresAt * 1000 < Date.now() ? "已过期" : "有效链接"}
                            </span>
                            <span className="share-history-date">
                              {share.revokedAt
                                ? `撤销于 ${formatDate(share.revokedAt)}`
                                : share.expiresAt * 1000 < Date.now()
                                ? `过期于 ${formatDate(share.expiresAt)}`
                                : `有效至 ${formatDate(share.expiresAt)}`}
                            </span>
                          </div>
                        </div>
                      </div>
                      <div className="share-history-actions">
                        {share.url && !inactive && (
                          <button
                            className={`share-item-btn ${isThisCopied ? "is-copied" : ""}`}
                            type="button"
                            title="复制此链接"
                            aria-label="复制此链接"
                            onClick={() => void copy(share.url!, share.id)}
                          >
                            {isThisCopied ? <Check size={13} /> : <Copy size={13} />}
                            <span>{isThisCopied ? "已复制" : "复制"}</span>
                          </button>
                        )}
                        {!inactive && (
                          <button className="share-item-btn is-danger" type="button" onClick={() => void revoke(share.id)}>
                            撤销
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
        <FloatingScrollbar scrollTargetRef={bodyRef} controlsId="share-dialog-scroll-region" ariaLabel="分享窗口滚动条" placement="right" />
      </div>
    </dialog>
  );
}

export function NotebookDialog({ notebook, onClose, onSave, onSaved, onRequestDelete, onToast }: { notebook?: Notebook | null; onClose: () => void; onSave: (draft: { name: string; color: string }) => Promise<Notebook>; onSaved: (notebook: Notebook) => void; onRequestDelete?: (notebook: Notebook) => void; onToast: (message: string) => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(notebook?.name ?? "");
  const [color, setColor] = useState(notebook?.color ?? "#718077");
  const [busy, setBusy] = useState(false);
  const isEditing = Boolean(notebook);
  useEffect(() => { const dialog = dialogRef.current; if (!dialog) return; const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null; dialog.showModal(); requestAnimationFrame(() => inputRef.current?.focus()); return () => { if (dialog.open) dialog.close(); if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true }); }; }, []);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = name.trim();
    const normalizedColor = color.trim().toLowerCase();
    if (!trimmed) return;
    setBusy(true);
    try { const saved = await onSave({ name: trimmed, color: normalizedColor }); onSaved(saved); onClose(); } catch (reason) { onToast(errorMessage(reason, isEditing ? "更新笔记本失败" : "创建笔记本失败")); } finally { setBusy(false); }
  };
  const handleDelete = () => { if (notebook && onRequestDelete) onRequestDelete(notebook); };
  const handleColorKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    const direction = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key as "ArrowRight" | "ArrowDown" | "ArrowLeft" | "ArrowUp"];
    if (!direction) return;
    event.preventDefault();
    const nextIndex = (index + direction + notebookColorOptions.length) % notebookColorOptions.length;
    const nextOption = notebookColorOptions[nextIndex];
    setColor(nextOption);
    const nextButton = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[nextIndex];
    nextButton?.focus();
  };
  const selectedColor = color.toLowerCase();
  const hasPresetColor = notebookColorOptions.includes(selectedColor);
  return <dialog ref={dialogRef} className="notebook-dialog" aria-labelledby="notebook-dialog-title" aria-describedby="notebook-dialog-description" onCancel={(event) => { event.preventDefault(); onClose(); }}><form onSubmit={(event) => void submit(event)}><div className="dialog-heading"><div><span className="dialog-eyebrow"><Folder size={15} />整理上下文</span><h2 id="notebook-dialog-title">{isEditing ? "编辑笔记本" : "新建笔记本"}</h2><p id="notebook-dialog-description">{isEditing ? "修改笔记本名称或管理该分类。" : "给一组想法一个清晰的落点。"}</p></div><button className="icon-button" type="button" aria-label="关闭新建笔记本窗口" onClick={onClose}><X size={18} /></button></div><label className="dialog-field"><span>名称</span><input ref={inputRef} value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：项目资料" maxLength={40} autoComplete="off" /></label><fieldset className="notebook-color-field"><legend>颜色</legend><div className="notebook-color-options" role="radiogroup" aria-label="选择笔记本颜色">{notebookColorOptions.map((option, index) => <button key={option} className="notebook-color-option" type="button" role="radio" tabIndex={selectedColor === option || (!hasPresetColor && index === 0) ? 0 : -1} aria-checked={selectedColor === option} aria-label={`选择颜色 ${option}`} onKeyDown={(event) => handleColorKeyDown(event, index)} onClick={() => setColor(option)}><span className="notebook-color-swatch" style={{ backgroundColor: option }} /></button>)}</div></fieldset><div className="dialog-actions">{isEditing && !notebook?.isSystem && onRequestDelete && <button className="text-button text-danger" type="button" onClick={handleDelete} disabled={busy} style={{ marginRight: "auto" }}>删除笔记本</button>}<button className="secondary-button" type="button" onClick={onClose}>取消</button><button className="primary-button" type="submit" disabled={busy || !name.trim()}>{busy ? "正在保存……" : isEditing ? "保存修改" : "创建笔记本"}</button></div></form></dialog>;
}
