import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CircleAlert, ClipboardPaste, Copy, Scissors, TextSelect, X, type LucideIcon } from "lucide-react";
import { FloatingScrollbar } from "./floating-scrollbar";
import { modKey } from "./platform";

export type ContextMenuItem = {
  label: string;
  icon?: LucideIcon;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  separator?: boolean;
  onSelect: () => void | Promise<void>;
};

type MenuState = { x: number; y: number; items: ContextMenuItem[]; label: string; trigger: HTMLElement | null };

// One event closes any previous menu, including menus owned by a different region.
const OPEN_EVENT = "xiangying-context-menu-open";

export function textFieldMenuItems(field: HTMLInputElement | HTMLTextAreaElement, onChange: (value: string) => void, isCurrent: () => boolean = () => true): ContextMenuItem[] {
  const from = field.selectionStart ?? 0;
  const to = field.selectionEnd ?? from;
  const original = field.value;
  const selected = original.slice(from, to);
  const editable = !field.readOnly && !field.disabled;
  const valid = () => isCurrent() && field.isConnected && field.value === original && !field.readOnly && !field.disabled;
  const restore = () => { field.focus({ preventScroll: true }); field.setSelectionRange(from, to); };
  const copy = async (cut = false) => {
    try { await navigator.clipboard.writeText(selected); } catch { throw new Error(`浏览器未允许写入剪贴板，请使用 ${modKey}+C。`); }
    if (cut && valid()) { restore(); onChange(original.slice(0, from) + original.slice(to)); }
  };
  return [
    { label: "剪切", icon: Scissors, shortcut: `${modKey} X`, disabled: !editable || !selected, onSelect: () => copy(true) },
    { label: "复制", icon: Copy, shortcut: `${modKey} C`, disabled: !selected, onSelect: () => copy() },
    { label: "粘贴", icon: ClipboardPaste, shortcut: `${modKey} V`, disabled: !editable, onSelect: async () => {
      let text: string;
      try { text = await navigator.clipboard.readText(); } catch { throw new Error(`浏览器未允许读取剪贴板，请使用 ${modKey}+V。`); }
      if (!valid()) return;
      restore();
      onChange((original.slice(0, from) + text.replace(/[\r\n]+/g, " ") + original.slice(to)).slice(0, field.maxLength > 0 ? field.maxLength : undefined));
    } },
    { label: "全选", icon: TextSelect, shortcut: `${modKey} A`, separator: true, onSelect: () => { field.focus(); field.select(); } },
  ];
}

export function useContextMenu() {
  const [state, setState] = useState<MenuState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closeMenu = useCallback(() => setState(null), []);
  useEffect(() => {
    window.addEventListener(OPEN_EVENT, closeMenu);
    return () => window.removeEventListener(OPEN_EVENT, closeMenu);
  }, [closeMenu]);
  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(null), 6000);
    return () => window.clearTimeout(timer);
  }, [error]);
  const openMenu = useCallback((event: MouseEvent<HTMLElement>, items: ContextMenuItem[], label = "快捷操作") => {
    if (event.defaultPrevented || !window.matchMedia("(any-pointer: fine)").matches || window.innerWidth <= 900 || !items.length) return;
    event.preventDefault();
    event.stopPropagation();
    window.dispatchEvent(new Event(OPEN_EVENT));
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const rect = event.currentTarget.getBoundingClientRect();
    setError(null);
    setState({ x: event.clientX || rect.left + 12, y: event.clientY || rect.top + 12, items, label, trigger });
  }, []);
  const menu: ReactNode = <>
    {state && <ContextMenu state={state} onClose={closeMenu} onError={setError} />}
    {error && createPortal(<div className="context-menu-notice toast toast--error"><CircleAlert size={18} aria-hidden="true" /><span role="alert">{error}</span><button className="notice-dismiss" type="button" aria-label="关闭提示" onClick={() => setError(null)}><X size={16} /></button></div>, document.body)}
  </>;
  return { openMenu, closeMenu, menu };
}

function ContextMenu({ state, onClose, onError }: { state: MenuState; onClose: () => void; onError: (message: string) => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: state.x, top: state.y });
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    setPosition({ left: Math.max(8, Math.min(state.x, window.innerWidth - root.offsetWidth - 8)), top: Math.max(8, Math.min(state.y, window.innerHeight - root.offsetHeight - 8)) });
    root.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
  }, [state]);
  useEffect(() => {
    const dismiss = () => onClose();
    const outside = (event: Event) => { if (!rootRef.current?.contains(event.target as Node)) onClose(); };
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape" || event.key === "Tab") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onClose();
        if (state.trigger?.isConnected) state.trigger.focus({ preventScroll: true });
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const buttons = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus({ preventScroll: true });
      buttons[next]?.scrollIntoView({ block: "nearest" });
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("scroll", outside, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("scroll", outside, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [state, onClose]);
  const select = (item: ContextMenuItem) => {
    // Invoke before yielding so Safari clipboard APIs retain the user's activation.
    try {
      if (state.trigger?.isConnected) state.trigger.focus({ preventScroll: true });
      const result = item.onSelect();
      if (result) void result.catch((reason: unknown) => onError(reason instanceof Error ? reason.message : "操作失败，请重试。"));
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "操作失败，请重试。");
    }
    onClose();
  };
  return createPortal(<div ref={rootRef} className="context-menu" style={position} onContextMenu={(event) => event.preventDefault()}>
    <div id="context-menu-scroll-region" ref={scrollRef} className="context-menu-scroll floating-scrollbar-target" role="menu" aria-label={state.label}>
      {state.items.map((item, index) => {
        const Icon = item.icon;
        return <div key={`${item.label}-${index}`}>{item.separator && index > 0 && <div className="context-menu-separator" role="separator" />}<button type="button" role="menuitem" className={`context-menu-item${item.danger ? " is-danger" : ""}`} disabled={item.disabled} onClick={() => select(item)}>{Icon ? <Icon size={16} aria-hidden="true" /> : <span className="context-menu-icon" />}<span>{item.label}</span>{item.shortcut && <kbd>{item.shortcut}</kbd>}</button></div>;
      })}
    </div>
    <FloatingScrollbar scrollTargetRef={scrollRef} controlsId="context-menu-scroll-region" ariaLabel="快捷菜单滚动条" placement="right" />
  </div>, document.body);
}
