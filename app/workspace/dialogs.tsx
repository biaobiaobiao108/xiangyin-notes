import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { AlertTriangle, RefreshCw, X } from "lucide-react";
import type { Notebook } from "../../shared/types";
import { errorMessage, notebookColorOptions, notebookIconOptions } from "./helpers";

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

export function NotebookDialog({ notebook, onClose, onSave, onSaved, onRequestDelete, onToast }: { notebook?: Notebook | null; onClose: () => void; onSave: (draft: { name: string; color: string; icon: string }) => Promise<Notebook>; onSaved: (notebook: Notebook) => void; onRequestDelete?: (notebook: Notebook) => void; onToast: (message: string) => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const outsidePressRef = useRef(false);
  const [name, setName] = useState(notebook?.name ?? "");
  const [color, setColor] = useState(notebook?.color ?? "#718077");
  const [icon, setIcon] = useState(notebook?.icon ?? "folder");
  const [busy, setBusy] = useState(false);
  const isEditing = Boolean(notebook);
  useEffect(() => { const dialog = dialogRef.current; if (!dialog) return; const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null; dialog.showModal(); requestAnimationFrame(() => inputRef.current?.focus()); return () => { if (dialog.open) dialog.close(); if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true }); }; }, []);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = name.trim();
    const normalizedColor = color.trim().toLowerCase();
    if (!trimmed || busy) return;
    setBusy(true);
    try { const saved = await onSave({ name: trimmed, color: normalizedColor, icon }); onSaved(saved); onClose(); } catch (reason) { onToast(errorMessage(reason, isEditing ? "更新笔记本失败" : "创建笔记本失败")); } finally { setBusy(false); }
  };
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
  const handleIconKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    const columns = event.currentTarget.parentElement ? getComputedStyle(event.currentTarget.parentElement).gridTemplateColumns.split(" ").length : 6;
    const direction = { ArrowRight: 1, ArrowDown: columns, ArrowLeft: -1, ArrowUp: -columns }[event.key as "ArrowRight" | "ArrowDown" | "ArrowLeft" | "ArrowUp"];
    if (!direction) return;
    event.preventDefault();
    const nextIndex = (index + direction + notebookIconOptions.length) % notebookIconOptions.length;
    const nextOption = notebookIconOptions[nextIndex];
    setIcon(nextOption.id);
    const nextButton = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[nextIndex];
    nextButton?.focus();
  };
  const selectedColor = color.toLowerCase();
  const hasPresetColor = notebookColorOptions.includes(selectedColor);

  return <dialog ref={dialogRef} className="notebook-dialog" aria-labelledby="notebook-dialog-title" onPointerDown={(event) => { const rect = event.currentTarget.getBoundingClientRect(); outsidePressRef.current = event.target === event.currentTarget && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom); }} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); if (!busy && outsidePressRef.current && event.target === event.currentTarget && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) onClose(); outsidePressRef.current = false; }} onCancel={(event) => { event.preventDefault(); onClose(); }}><form onSubmit={(event) => void submit(event)}><div className="dialog-heading"><div><h2 id="notebook-dialog-title">{isEditing ? "编辑笔记本" : "新建笔记本"}</h2></div><button className="icon-button" type="button" aria-label="关闭笔记本设置" onClick={onClose}><X size={18} /></button></div><label className="dialog-field"><span>名称</span><input ref={inputRef} value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：项目资料" maxLength={40} autoComplete="off" /></label><fieldset className="notebook-icon-field"><legend>图标</legend><div className="notebook-icon-options" role="radiogroup" aria-label="选择笔记本图标">{notebookIconOptions.map((option, index) => { const IconComponent = option.icon; const isSelected = icon === option.id; return <button key={option.id} className={`notebook-icon-option ${isSelected ? "is-selected" : ""}`} type="button" role="radio" tabIndex={isSelected ? 0 : -1} aria-checked={isSelected} aria-label={`选择图标 ${option.label}`} onKeyDown={(event) => handleIconKeyDown(event, index)} onClick={() => setIcon(option.id)}><IconComponent size={18} style={isSelected ? { color: selectedColor } : undefined} /></button>; })}</div></fieldset><fieldset className="notebook-color-field"><legend>颜色</legend><div className="notebook-color-options" role="radiogroup" aria-label="选择笔记本颜色">{notebookColorOptions.map((option, index) => <button key={option} className="notebook-color-option" type="button" role="radio" tabIndex={selectedColor === option || (!hasPresetColor && index === 0) ? 0 : -1} aria-checked={selectedColor === option} aria-label={`选择颜色 ${option}`} onKeyDown={(event) => handleColorKeyDown(event, index)} onClick={() => setColor(option)}><span className="notebook-color-swatch" style={{ backgroundColor: option }} /></button>)}</div></fieldset><div className="dialog-actions">{notebook && !notebook.isSystem && onRequestDelete && <button className="secondary-button notebook-delete-button" type="button" disabled={busy} onClick={() => onRequestDelete(notebook)}>删除笔记本</button>}<button className="primary-button" type="submit" disabled={busy || !name.trim()}>{busy ? "正在保存……" : isEditing ? "保存修改" : "创建笔记本"}</button></div></form></dialog>;
}
