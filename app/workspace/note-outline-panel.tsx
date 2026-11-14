import { useEffect, useLayoutEffect, useRef } from "react";
import { ChevronLeft } from "lucide-react";
import type { OutlineItem } from "../editor-metrics";
import { FloatingScrollbar } from "../floating-scrollbar";

export function NoteOutlinePanel({
  outlineItems,
  activeOutlineId,
  onScrollToOutlineItem,
  onCloseOutline,
  isFloating = false,
}: {
  outlineItems: OutlineItem[];
  activeOutlineId: string | null;
  onScrollToOutlineItem: (id: string) => void;
  onCloseOutline: () => void;
  isFloating?: boolean;
}) {
  const outlineScrollRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const scrollRoot = outlineScrollRef.current;
    const shell = scrollRoot?.parentElement;
    if (!isFloating || !scrollRoot || !shell) return;
    const fitCompleteRows = () => {
      const list = scrollRoot.querySelector<HTMLOListElement>(".editor-outline-list");
      const row = list?.querySelector<HTMLButtonElement>("button");
      if (!list || !row) {
        scrollRoot.style.height = "100%";
        return;
      }
      const style = getComputedStyle(scrollRoot);
      const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      const gap = parseFloat(getComputedStyle(list).rowGap) || 0;
      const stride = row.offsetHeight + gap;
      if (stride <= 0) return;
      const rows = Math.max(1, Math.floor((shell.clientHeight - padding + gap) / stride));
      scrollRoot.style.height = `${Math.min(shell.clientHeight, rows * stride - gap + padding)}px`;
    };
    fitCompleteRows();
    const observer = new ResizeObserver(fitCompleteRows);
    observer.observe(shell);
    return () => {
      observer.disconnect();
      scrollRoot.style.removeProperty("height");
    };
  }, [isFloating, outlineItems]);
  useLayoutEffect(() => {
    const scrollRoot = outlineScrollRef.current;
    if (!scrollRoot) return;
    let frame: number | null = null;
    const updateScrollEdges = () => {
      frame = null;
      // Clamp Safari's elastic overscroll; tolerate fractional offsets at the edges.
      const maxScroll = Math.max(0, scrollRoot.scrollHeight - scrollRoot.clientHeight);
      const offset = Math.min(maxScroll, Math.max(0, scrollRoot.scrollTop));
      scrollRoot.toggleAttribute("data-scroll-above", offset > 1);
      scrollRoot.toggleAttribute("data-scroll-below", maxScroll - offset > 1);
    };
    const scheduleScrollEdges = () => {
      if (frame === null) frame = requestAnimationFrame(updateScrollEdges);
    };
    const observer = new ResizeObserver(scheduleScrollEdges);
    observer.observe(scrollRoot);
    const content = scrollRoot.firstElementChild;
    if (content) observer.observe(content);
    scrollRoot.addEventListener("scroll", scheduleScrollEdges, { passive: true });
    updateScrollEdges();
    return () => {
      observer.disconnect();
      scrollRoot.removeEventListener("scroll", scheduleScrollEdges);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [isFloating, outlineItems]);
  useEffect(() => {
    const scrollRoot = outlineScrollRef.current;
    if (!scrollRoot || !activeOutlineId) return;
    const activeButton = Array.from(
      scrollRoot.querySelectorAll<HTMLButtonElement>(".editor-outline-item button"),
    ).find((button) => button.dataset.outlineId === activeOutlineId);
    if (!activeButton) return;
    const scrollRect = scrollRoot.getBoundingClientRect();
    const buttonRect = activeButton.getBoundingClientRect();
    const edgePadding = isFloating ? 14 : 8;
    const visibleTop = scrollRect.top + edgePadding;
    const visibleBottom = scrollRect.bottom - edgePadding;
    let delta = 0;
    if (buttonRect.top < visibleTop) delta = buttonRect.top - visibleTop;
    else if (buttonRect.bottom > visibleBottom) delta = buttonRect.bottom - visibleBottom;
    if (delta === 0) return;
    const behavior: ScrollBehavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "auto"
      : "smooth";
    const maxScrollTop = Math.max(0, scrollRoot.scrollHeight - scrollRoot.clientHeight);
    scrollRoot.scrollTo({
      top: Math.min(maxScrollTop, Math.max(0, scrollRoot.scrollTop + delta)),
      behavior,
    });
  }, [activeOutlineId, outlineItems, isFloating]);

  return (
    <aside
      className={`note-outline-panel ${isFloating ? "is-floating" : ""}`}
      id="note-outline"
      aria-label={isFloating ? "笔记大纲" : undefined}
      aria-labelledby={isFloating ? undefined : "note-outline-title"}
    >
      {!isFloating && (
        <header className="list-header note-outline-header">
          <div className="list-header-main">
            <h2 id="note-outline-title">笔记大纲</h2>
            <p>{outlineItems.length > 0 ? `${outlineItems.length} 个标题` : "当前笔记暂无标题"}</p>
          </div>
          <div className="list-header-controls">
            <button
              className="text-button outline-back-button"
              type="button"
              onClick={onCloseOutline}
            >
              <ChevronLeft size={15} aria-hidden="true" />
              <span>返回笔记列表</span>
            </button>
          </div>
        </header>
      )}
      <div className="note-outline-scroll-shell">
        <div
          id="note-outline-scroll-region"
          className="note-outline-scroll floating-scrollbar-target"
          ref={outlineScrollRef}
        >
          {outlineItems.length > 0 ? (
            <nav aria-label="笔记标题">
              <ol className="editor-outline-list">
                {outlineItems.map((item) => (
                  <li
                    className={`editor-outline-item editor-outline-item--level-${item.level}`}
                    key={item.id}
                  >
                    <button
                      type="button"
                      data-outline-id={item.id}
                      aria-current={activeOutlineId === item.id ? "true" : undefined}
                      onClick={() => onScrollToOutlineItem(item.id)}
                    >
                      <span className="outline-item-title">{item.title}</span>
                    </button>
                  </li>
                ))}
              </ol>
            </nav>
          ) : (
            <p className="editor-outline-empty">
              用 <code>#</code> 标题为这篇笔记建立大纲。
            </p>
          )}
        </div>
        <FloatingScrollbar
          scrollTargetRef={outlineScrollRef}
          controlsId="note-outline-scroll-region"
          ariaLabel="笔记大纲滚动条"
          placement="right"
          enabled={!isFloating}
        />
      </div>
    </aside>
  );
}
