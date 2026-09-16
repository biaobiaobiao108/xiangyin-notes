import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { AlertTriangle, Check, Clock3, Copy, FileText, Folder, Link2, Plus, RefreshCw, Share2, ShieldCheck, X } from "lucide-react";
import { ApiError, api } from "../api";
import { FloatingScrollbar } from "../floating-scrollbar";
import type { OfflineConflict } from "../offline-store";
import { offlineSync } from "../offline-sync";
import type { Note, Notebook, Share } from "../../shared/types";
import { extractTags } from "../../shared/tags";
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

export function ConflictDialog({ conflict, onClose, onResolved }: { conflict: OfflineConflict; onClose: () => void; onResolved: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [content, setContent] = useState(conflict.local.contentMarkdown);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    };
  }, []);
  const resolve = async (resolution: "server" | "local") => {
    setBusy(true);
    try { await offlineSync.resolveConflict(conflict.id, resolution, resolution === "local" ? { ...conflict.local, contentMarkdown: content, preview: content.slice(0, 180), tags: extractTags(content) } : undefined); onResolved(); onClose(); } finally { setBusy(false); }
  };
  return <dialog ref={dialogRef} className="conflict-dialog" aria-labelledby="conflict-dialog-title" aria-describedby="conflict-dialog-description" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}><div className="dialog-heading"><div><span className="dialog-eyebrow is-danger"><AlertTriangle size={15} />同步冲突</span><h2 id="conflict-dialog-title">这篇笔记在其他地方被修改了</h2><p id="conflict-dialog-description">本地内容已经保留。请检查两个版本后决定使用哪一个。</p></div><button className="icon-button" type="button" aria-label="关闭冲突窗口" onClick={onClose}><X size={18} /></button></div><div className="conflict-grid"><label><span>{conflict.server ? "服务器版本" : "服务器版本（已删除）"}</span>{conflict.server ? <textarea value={conflict.server.contentMarkdown} readOnly aria-label="服务器版本内容" /> : <div className="conflict-deleted" role="status">服务器已经删除这篇笔记。你可以采用服务器删除结果，或恢复本地版本。</div>}</label><label><span>本地版本（可编辑）</span><textarea value={content} onChange={(event) => setContent(event.target.value)} disabled={busy} aria-label="本地版本内容" /></label></div><div className="dialog-actions"><button className="secondary-button" type="button" onClick={onClose} disabled={busy}>稍后处理</button><button className="secondary-button" type="button" onClick={() => void resolve("server")} disabled={busy}>采用服务器版本</button><button className="primary-button" type="button" onClick={() => void resolve("local")} disabled={busy}>合并后保存</button></div></dialog>;
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
  const copy = async (url: string) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard-unavailable");
      await navigator.clipboard.writeText(url);
      setCopied(true);
      onToast("链接已复制");
    } catch {
      shareUrlRef.current?.select();
      onToast("复制失败，请手动复制选中的链接");
    }
  };
  const revoke = async (id: string) => { try { await api.revokeShare(id); setShares((current) => current.map((share) => share.id === id ? { ...share, revokedAt: Math.floor(Date.now() / 1000) } : share)); onToast("分享已撤销"); } catch { onToast("撤销分享失败，请重试"); } };
  const handleBackdropClick = (event: ReactMouseEvent<HTMLDialogElement>) => {
    if (event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
    if (!inside) onClose();
  };
  return <dialog ref={dialogRef} className="share-dialog" aria-labelledby="share-dialog-title" aria-describedby="share-dialog-description" onClick={handleBackdropClick} onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <header className="share-dialog-heading">
      <span className="share-dialog-mark" aria-hidden="true"><Share2 size={21} /></span>
      <div>
        <span className="dialog-eyebrow">公开分享</span>
        <h2 id="share-dialog-title">分享这篇笔记</h2>
        <p id="share-dialog-description">为当前内容创建一份独立、只读的公开快照。</p>
      </div>
      <button className="icon-button share-dialog-close" type="button" aria-label="关闭分享窗口" onClick={onClose}><X size={18} /></button>
    </header>
    <div className="share-dialog-body-shell">
      <div id="share-dialog-scroll-region" ref={bodyRef} className="share-dialog-body floating-scrollbar-target">
        <div className="share-note-context">
          <span className="share-note-context-icon" aria-hidden="true"><FileText size={18} /></span>
          <div><strong>{note.title || "未命名笔记"}</strong><span>{note.notebookName}</span></div>
          <span className="share-note-badge">只读</span>
        </div>
        <section className="share-create-panel" aria-labelledby="share-create-title">
          <div className="share-create-copy">
            <h3 id="share-create-title">创建新的阅读链接</h3>
            <p>每次生成都会保存此刻的内容，适合放心发送给他人。</p>
          </div>
          <div className="share-policy-list" aria-label="分享规则">
            <span><Clock3 size={15} aria-hidden="true" />7 天后自动失效</span>
            <span><ShieldCheck size={15} aria-hidden="true" />原文更新不影响快照</span>
          </div>
          <button className="primary-button share-create-button" type="button" onClick={() => void create()} disabled={busy}><Plus size={18} />{busy ? "正在生成……" : "生成分享链接"}</button>
        </section>
        {newUrl && <div className="share-result" role="status">
          <span className="share-result-icon" aria-hidden="true"><Link2 size={18} /></span>
          <label><span>链接已准备好</span><input ref={shareUrlRef} value={newUrl} readOnly aria-label="分享链接" onFocus={(event) => event.currentTarget.select()} /></label>
          <button className={`secondary-button share-copy-button ${copied ? "is-copied" : ""}`} type="button" onClick={() => void copy(newUrl)}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? "已复制" : "复制"}</button>
        </div>}
        <section className="share-history" aria-labelledby="share-history-title">
          <div className="share-history-heading"><h3 id="share-history-title">分享记录</h3>{shares.length > 0 && <span>{shares.length}</span>}</div>
          {loadingShares ? <p className="share-history-empty" role="status">正在加载分享记录……</p> : shares.length === 0 ? <p className="share-history-empty">还没有生成过分享链接</p> : shares.map((share) => {
            const inactive = Boolean(share.revokedAt || share.expiresAt * 1000 < Date.now());
            return <div className="share-history-row" key={share.id}>
              <span className={`share-status-icon ${inactive ? "is-inactive" : ""}`} aria-hidden="true"><Link2 size={14} /></span>
              <span className="share-history-meta"><strong>{share.revokedAt ? "已撤销" : share.expiresAt * 1000 < Date.now() ? "已过期" : "链接有效"}</strong><span>{share.revokedAt ? `创建于 ${formatDate(share.createdAt)}` : `有效至 ${formatDate(share.expiresAt)}`}</span></span>
              {!inactive && <button className="text-button" type="button" onClick={() => void revoke(share.id)}>撤销</button>}
            </div>;
          })}
        </section>
      </div>
      <FloatingScrollbar scrollTargetRef={bodyRef} controlsId="share-dialog-scroll-region" ariaLabel="分享窗口滚动条" placement="right" />
    </div>
  </dialog>;
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
