import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { ArrowLeftRight, ChevronLeft, ImageDown, ImagePlus, ListTree, MoreHorizontal, SlidersHorizontal, Star, Trash2, Undo2 } from "lucide-react";
import type { EditorStats, OutlineItem } from "../editor-metrics";
import { NoteOutlinePanel } from "../workspace/panels";
import { EditorStatsPill } from "./editor-panels";

export function MobileEditorHeader({ noteId, title, backLabel, locked, trashBusy, deleted, favorite, backlinkCount, status, onBack, onExport, onFavorite, onBacklinks, onTrash, onRestore, onPermanentDelete, canUpload, onUpload }: {
  noteId: string; title: string; backLabel: string; locked: boolean; trashBusy: boolean; deleted: boolean; favorite: boolean; backlinkCount: number; status: ReactNode;
  onBack?: () => void; onExport: () => void; onFavorite: () => void; onBacklinks?: () => void; onTrash: () => void; onRestore: () => void; onPermanentDelete?: () => void;
  canUpload: boolean; onUpload: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { setOpen(false); headingRef.current?.focus({ preventScroll: true }); }, [noteId]);
  useEffect(() => {
    if (!open) return;
    menuRootRef.current?.querySelector<HTMLButtonElement>("[role='menuitem']:not(:disabled)")?.focus();
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);
  const runAction = (action: () => void) => { setOpen(false); triggerRef.current?.focus(); action(); };
  return <header className="mobile-editor-header">
    <button className="icon-button mobile-editor-back" type="button" aria-label={`返回${backLabel}`} title={`返回${backLabel}`} onClick={onBack} disabled={locked || !onBack}><ChevronLeft size={22} aria-hidden="true" /></button>
    <h2 className="mobile-editor-title" ref={headingRef} tabIndex={-1}>{title}</h2>
    <div className="mobile-editor-status">{status}</div>
    <div className="mobile-editor-menu-root" ref={menuRootRef} onKeyDown={(event) => {
      if (event.nativeEvent.isComposing || event.keyCode === 229 || !open) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); triggerRef.current?.focus(); }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        const items = Array.from(menuRootRef.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']:not(:disabled)") ?? []);
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }
    }}>
      <button ref={triggerRef} className="icon-button mobile-editor-more" type="button" aria-label="更多笔记操作" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? "mobile-note-actions" : undefined} onClick={() => setOpen((value) => !value)} disabled={locked}><MoreHorizontal size={22} aria-hidden="true" /></button>
      {open && <div id="mobile-note-actions" className="mobile-editor-menu" role="menu" aria-label="笔记操作" onBlur={(event) => {
        // Safari 点击按钮时可能先失焦到 null；此时不能提前卸载尚未收到 click 的菜单项。
        // 外部触摸由 pointerdown 关闭，键盘离开则以明确的焦点目标判断。
        if (event.relatedTarget instanceof Node && !menuRootRef.current?.contains(event.relatedTarget)) setOpen(false);
      }}>
        {!deleted && <button type="button" role="menuitem" disabled={!canUpload} onClick={() => runAction(onUpload)}><ImagePlus size={18} />上传图片</button>}
        <button type="button" role="menuitem" onClick={() => runAction(onFavorite)}><Star size={18} fill={favorite ? "currentColor" : "none"} />{favorite ? "取消收藏" : "收藏笔记"}</button>
        <button type="button" role="menuitem" onClick={() => runAction(onExport)}><ImageDown size={18} />导出图片</button>
        {!deleted && onBacklinks && <button type="button" role="menuitem" onClick={() => runAction(onBacklinks)}><ArrowLeftRight size={18} />反向链接{backlinkCount > 0 ? ` (${backlinkCount})` : ""}</button>}
        {deleted ? <>
          <button type="button" role="menuitem" onClick={() => runAction(onRestore)} disabled={trashBusy}><Undo2 size={18} />恢复笔记</button>
          {onPermanentDelete && <button type="button" role="menuitem" className="is-danger" onClick={() => runAction(onPermanentDelete)} disabled={trashBusy}><Trash2 size={18} />彻底删除</button>}
        </> : <button type="button" role="menuitem" className="is-danger" onClick={() => runAction(onTrash)} disabled={trashBusy}><Trash2 size={18} />移入回收站</button>}
      </div>}
    </div>
  </header>;
}

export function MobileEditorFooter({ stats, outlineOpen, outlineTriggerRef, locked, onOpenCommands, onToggleOutline }: {
  stats: EditorStats; outlineOpen: boolean; outlineTriggerRef: RefObject<HTMLButtonElement | null>; locked: boolean; onOpenCommands?: () => void; onToggleOutline: () => void;
}) {
  return <footer className="mobile-editor-footer" aria-label="笔记工具">
    <button className="icon-button" type="button" aria-label="打开命令面板" title="打开命令面板" disabled={locked || !onOpenCommands} onClick={onOpenCommands}><SlidersHorizontal size={22} aria-hidden="true" /></button>
    <EditorStatsPill stats={stats} />
    <button ref={outlineTriggerRef} className={`icon-button ${outlineOpen ? "is-active" : ""}`} type="button" aria-label={outlineOpen ? "关闭笔记大纲" : "打开笔记大纲"} aria-expanded={outlineOpen} aria-controls={outlineOpen ? "note-outline" : undefined} disabled={locked} onClick={onToggleOutline}><ListTree size={22} aria-hidden="true" /></button>
  </footer>;
}

export function MobileEditorOutline({ items, activeId, onNavigate, onClose }: {
  items: OutlineItem[]; activeId: string | null; onNavigate: (id: string) => void; onClose: () => void;
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const layer = layerRef.current;
    (layer?.querySelector<HTMLButtonElement>(".editor-outline-item button") ?? layer)?.focus({ preventScroll: true });
    return () => { if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true }); };
  }, []);
  return <div ref={layerRef} className="mobile-editor-outline-layer" role="dialog" aria-modal="true" aria-label="笔记大纲" tabIndex={-1} onKeyDown={(event) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
    if (event.key === "Tab") {
      const items = Array.from(layerRef.current?.querySelectorAll<HTMLButtonElement>(".editor-outline-item button") ?? []);
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      event.preventDefault();
      if (items.length) items[(index + (event.shiftKey ? -1 : 1) + items.length) % items.length]?.focus();
    }
  }}>
    <button className="mobile-editor-outline-backdrop" type="button" tabIndex={-1} aria-label="关闭笔记大纲" onClick={onClose} />
    <div className="mobile-editor-outline"><NoteOutlinePanel outlineItems={items} activeOutlineId={activeId} onScrollToOutlineItem={onNavigate} onCloseOutline={onClose} isFloating /></div>
  </div>;
}
