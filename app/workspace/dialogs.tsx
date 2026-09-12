import { useEffect, useRef, useState, type FormEvent } from "react";
import { AlertTriangle, FileText, Folder, Link2, Plus, RefreshCw, Share2, X } from "lucide-react";
import { ApiError, api } from "../api";
import type { OfflineConflict } from "../offline-store";
import { offlineSync } from "../offline-sync";
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

export function ConflictDialog({ conflict, onClose, onResolved }: { conflict: OfflineConflict; onClose: () => void; onResolved: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [content, setContent] = useState(conflict.local.contentMarkdown);
  const [busy, setBusy] = useState(false);
  useEffect(() => { const dialog = dialogRef.current; if (!dialog) return; dialog.showModal(); return () => { if (dialog.open) dialog.close(); }; }, []);
  const resolve = async (resolution: "server" | "local") => {
    setBusy(true);
    try { await offlineSync.resolveConflict(conflict.id, resolution, resolution === "local" ? { ...conflict.local, contentMarkdown: content, preview: content.slice(0, 180) } : undefined); onResolved(); onClose(); } finally { setBusy(false); }
  };
  return <dialog ref={dialogRef} className="conflict-dialog" aria-labelledby="conflict-dialog-title"><div className="dialog-heading"><div><span className="dialog-eyebrow is-danger"><AlertTriangle size={15} />同步冲突</span><h2 id="conflict-dialog-title">这篇笔记在其他地方被修改了</h2><p>本地内容已经保留。请检查两个版本后决定使用哪一个。</p></div><button className="icon-button" type="button" aria-label="关闭冲突窗口" onClick={onClose}><X size={18} /></button></div><div className="conflict-grid"><label><span>服务器版本</span><textarea value={conflict.server.contentMarkdown} readOnly /></label><label><span>本地版本（可编辑）</span><textarea value={content} onChange={(event) => setContent(event.target.value)} disabled={busy} /></label></div><div className="dialog-actions"><button className="secondary-button" type="button" onClick={onClose} disabled={busy}>稍后处理</button><button className="secondary-button" type="button" onClick={() => void resolve("server")} disabled={busy}>采用服务器版本</button><button className="primary-button" type="button" onClick={() => void resolve("local")} disabled={busy}>合并后保存</button></div></dialog>;
}

export function ShareDialog({ note, onClose, onToast }: { note: Note; onClose: () => void; onToast: (message: string) => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const shareUrlRef = useRef<HTMLInputElement>(null);
  const [shares, setShares] = useState<Share[]>([]);
  const [newUrl, setNewUrl] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { const dialog = dialogRef.current; if (!dialog) return; dialog.showModal(); void api.listShares(note.id).then((result) => setShares(result.shares)).catch(() => onToast("加载分享记录失败")); return () => { if (dialog.open) dialog.close(); }; }, [note.id]);
  const create = async () => { setBusy(true); try { const result = await api.createShare(note.id); setShares((current) => [result.share, ...current]); setNewUrl(result.share.url ?? ""); onToast("分享链接已生成"); } catch { onToast("生成分享链接失败"); } finally { setBusy(false); } };
  const copy = async (url: string) => { try { if (!navigator.clipboard?.writeText) throw new Error("clipboard-unavailable"); await navigator.clipboard.writeText(url); onToast("链接已复制"); } catch { shareUrlRef.current?.select(); onToast("复制失败，请手动复制选中的链接"); } };
  const revoke = async (id: string) => { try { await api.revokeShare(id); setShares((current) => current.map((share) => share.id === id ? { ...share, revokedAt: Math.floor(Date.now() / 1000) } : share)); onToast("分享已撤销"); } catch { onToast("撤销分享失败，请重试"); } };
  return <dialog ref={dialogRef} className="share-dialog" aria-labelledby="share-dialog-title" aria-describedby="share-dialog-description" onCancel={(event) => { event.preventDefault(); onClose(); }}><div className="dialog-heading share-dialog-heading"><div><span className="dialog-eyebrow"><Share2 size={15} />只读快照</span><h2 id="share-dialog-title">分享这篇笔记</h2><p id="share-dialog-description">生成一个 7 天有效的公开阅读链接。</p></div><button className="icon-button" type="button" aria-label="关闭分享窗口" onClick={onClose}><X size={18} /></button></div><div className="share-note-context"><span className="share-note-context-icon"><FileText size={18} /></span><div><strong>{note.title || "未命名笔记"}</strong><span>公开只读 · 快照有效 7 天</span></div></div>{newUrl && <div className="share-result"><span className="share-result-icon"><Link2 size={18} /></span><div><strong>链接已准备好</strong><input ref={shareUrlRef} value={newUrl} readOnly aria-label="分享链接" /></div><button className="secondary-button" type="button" onClick={() => void copy(newUrl)}>复制</button></div>}<div className="share-dialog-actions"><button className="primary-button share-create-button" type="button" onClick={() => void create()} disabled={busy}><Plus size={18} />{busy ? "正在生成……" : "生成新链接"}</button><p>快照创建后保持不变，原笔记的后续修改不会影响分享内容。</p></div>{shares.length > 0 && <div className="share-history"><div className="share-history-heading"><h3>分享记录</h3><span>{shares.length}</span></div>{shares.map((share) => <div className="share-history-row" key={share.id}><span className={`share-status-dot ${share.revokedAt || share.expiresAt * 1000 < Date.now() ? "is-inactive" : ""}`} /><span>{share.revokedAt ? "已撤销" : share.expiresAt * 1000 < Date.now() ? "已过期" : `有效至 ${formatDate(share.expiresAt)}`}</span>{!share.revokedAt && share.expiresAt * 1000 >= Date.now() && <button className="text-button" type="button" onClick={() => void revoke(share.id)}>撤销</button>}</div>)}</div>}</dialog>;
}

export function NotebookDialog({ notebook, onClose, onSave, onSaved, onRequestDelete, onToast }: { notebook?: Notebook | null; onClose: () => void; onSave: (draft: { name: string; color: string }) => Promise<Notebook>; onSaved: (notebook: Notebook) => void; onRequestDelete?: (notebook: Notebook) => void; onToast: (message: string) => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(notebook?.name ?? "");
  const [color, setColor] = useState(notebook?.color ?? "#718077");
  const [colorError, setColorError] = useState("");
  const [busy, setBusy] = useState(false);
  const isEditing = Boolean(notebook);
  useEffect(() => { const dialog = dialogRef.current; if (!dialog) return; dialog.showModal(); requestAnimationFrame(() => inputRef.current?.focus()); return () => { if (dialog.open) dialog.close(); }; }, []);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = name.trim();
    const normalizedColor = color.trim().toLowerCase();
    if (!trimmed) return;
    if (!/^#[0-9a-f]{6}$/i.test(normalizedColor)) { setColorError("请输入 6 位十六进制颜色，例如 #718077"); return; }
    setColorError("");
    setBusy(true);
    try { const saved = await onSave({ name: trimmed, color: normalizedColor }); onSaved(saved); onClose(); } catch (reason) { onToast(errorMessage(reason, isEditing ? "更新笔记本失败" : "创建笔记本失败")); } finally { setBusy(false); }
  };
  const handleDelete = () => { if (notebook && onRequestDelete) onRequestDelete(notebook); };
  return <dialog ref={dialogRef} className="notebook-dialog" onCancel={(event) => { event.preventDefault(); onClose(); }}><form onSubmit={(event) => void submit(event)}><div className="dialog-heading"><div><span className="dialog-eyebrow"><Folder size={15} />整理上下文</span><h2>{isEditing ? "编辑笔记本" : "新建笔记本"}</h2><p>{isEditing ? "修改笔记本名称或管理该分类。" : "给一组想法一个清晰的落点。"}</p></div><button className="icon-button" type="button" aria-label="关闭新建笔记本窗口" onClick={onClose}><X size={18} /></button></div><label className="dialog-field"><span>名称</span><input ref={inputRef} value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：项目资料" maxLength={40} autoComplete="off" /></label><fieldset className="notebook-color-field"><legend>颜色</legend><div className="notebook-color-options" role="radiogroup" aria-label="选择笔记本颜色">{notebookColorOptions.map((option) => <button key={option} className="notebook-color-option" type="button" role="radio" aria-checked={color.toLowerCase() === option} aria-label={`选择颜色 ${option}`} onClick={() => { setColor(option); setColorError(""); }}><span className="notebook-color-swatch" style={{ backgroundColor: option }} /></button>)}</div><label className="notebook-color-custom"><span>自定义色值</span><input value={color} onChange={(event) => { setColor(event.target.value); setColorError(""); }} placeholder="#718077" maxLength={7} inputMode="text" spellCheck={false} aria-invalid={Boolean(colorError)} aria-describedby={colorError ? "notebook-color-error" : undefined} /></label>{colorError && <span className="dialog-error" id="notebook-color-error" role="alert">{colorError}</span>}</fieldset><div className="dialog-actions">{isEditing && !notebook?.isSystem && onRequestDelete && <button className="text-button text-danger" type="button" onClick={handleDelete} disabled={busy} style={{ marginRight: "auto" }}>删除笔记本</button>}<button className="secondary-button" type="button" onClick={onClose}>取消</button><button className="primary-button" type="submit" disabled={busy || !name.trim()}>{busy ? "正在保存……" : isEditing ? "保存修改" : "创建笔记本"}</button></div></form></dialog>;
}
