import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { Editor } from "@tiptap/core";

export function caretScrollTop(caret: { top: number; bottom: number }, bounds: { top: number; bottom: number }, scrollTop: number, maxScroll: number) {
  if (bounds.bottom <= bounds.top) return scrollTop;
  const delta = caret.bottom > bounds.bottom ? caret.bottom - bounds.bottom : caret.top < bounds.top ? caret.top - bounds.top : 0;
  return Math.max(0, Math.min(maxScroll, scrollTop + delta));
}

export function mobileCaretBounds(scroll: HTMLElement) {
  const rect = scroll.getBoundingClientRect();
  const viewport = window.visualViewport;
  const panel = scroll.closest(".is-mobile-editor");
  const header = panel?.querySelector(".mobile-editor-header")?.getBoundingClientRect();
  const footer = panel?.querySelector(".mobile-editor-footer")?.getBoundingClientRect();
  return {
    top: Math.max(rect.top, viewport?.offsetTop ?? 0, header?.bottom ?? rect.top) + 12,
    bottom: Math.min(rect.bottom, (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight), footer?.top ?? rect.bottom) - 12,
  };
}

/** Scroll only the document, never its ancestors; do not change selection or IME state. */
export function useMobileCaret(editor: Editor | null, scrollRef: RefObject<HTMLDivElement | null>, titleRef: RefObject<HTMLTextAreaElement | null>, enabled: boolean) {
  const scheduleRef = useRef<() => void>(() => undefined);
  const schedule = useCallback(() => scheduleRef.current(), []);
  useEffect(() => {
    if (!enabled || !editor) return;
    let frame = 0;
    let mirror: HTMLDivElement | undefined;
    const update = () => {
      frame = 0;
      const scroll = scrollRef.current;
      const title = titleRef.current;
      if (!scroll || scroll.closest("[inert]") || editor.isDestroyed) return;
      if (window.visualViewport && Math.abs(window.visualViewport.scale - 1) > 0.01) return;
      let caret: { top: number; bottom: number };
      if (title && document.activeElement === title) {
        if (title.selectionStart !== title.selectionEnd) return;
        // A wrapped title needs the actual caret line, rather than the textarea's bottom.
        mirror ??= document.createElement("div");
        const computed = getComputedStyle(title);
        for (const property of ["box-sizing", "font-family", "font-size", "font-weight", "font-style", "line-height", "letter-spacing", "padding", "border", "text-indent", "text-align", "word-spacing", "overflow-wrap", "tab-size"]) mirror.style.setProperty(property, computed.getPropertyValue(property));
        Object.assign(mirror.style, { position: "fixed", left: "-10000px", top: "0", visibility: "hidden", whiteSpace: "pre-wrap", width: `${title.getBoundingClientRect().width}px` });
        mirror.textContent = title.value.slice(0, title.selectionStart);
        const marker = document.createElement("span");
        marker.textContent = "\u200b";
        mirror.append(marker, document.createTextNode(title.value.slice(title.selectionStart) || "\u200b"));
        if (!mirror.isConnected) document.body.append(mirror);
        const line = marker.getBoundingClientRect();
        const top = title.getBoundingClientRect().top + line.top - mirror.getBoundingClientRect().top - title.scrollTop;
        caret = { top, bottom: top + (line.height || parseFloat(computed.lineHeight) || 32) };
      } else {
        if (!editor.view.hasFocus() || !editor.state.selection.empty) return;
        try { caret = editor.view.coordsAtPos(editor.state.selection.head); } catch { return; }
      }
      const next = caretScrollTop(caret, mobileCaretBounds(scroll), scroll.scrollTop, Math.max(0, scroll.scrollHeight - scroll.clientHeight));
      if (Math.abs(next - scroll.scrollTop) > 1) scroll.scrollTop = next;
    };
    const enqueue = () => { if (!frame) frame = requestAnimationFrame(update); };
    // Let the workspace apply new viewport geometry before measuring its controls.
    const viewportChanged = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(update); });
    };
    scheduleRef.current = enqueue;
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", viewportChanged);
    viewport?.addEventListener("scroll", viewportChanged);
    for (const event of ["focusin", "input", "select", "selectionchange", "compositionend"]) document.addEventListener(event, enqueue);
    editor.on("focus", enqueue);
    editor.on("selectionUpdate", enqueue);
    editor.on("update", enqueue);
    enqueue();
    return () => {
      scheduleRef.current = () => undefined;
      cancelAnimationFrame(frame);
      mirror?.remove();
      viewport?.removeEventListener("resize", viewportChanged);
      viewport?.removeEventListener("scroll", viewportChanged);
      for (const event of ["focusin", "input", "select", "selectionchange", "compositionend"]) document.removeEventListener(event, enqueue);
      editor.off("focus", enqueue);
      editor.off("selectionUpdate", enqueue);
      editor.off("update", enqueue);
    };
  }, [editor, enabled, scrollRef, titleRef]);
  return schedule;
}
