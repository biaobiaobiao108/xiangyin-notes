import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { FloatingScrollbar } from "../floating-scrollbar";

type OverlayPosition = { top: number; left: number; width: number; height: number };
type ScrollEdges = { before: boolean; after: boolean };

function TableHorizontalScrollbar({ root, target }: { root: HTMLElement; target: HTMLElement }) {
  const targetRef = useRef<HTMLElement | null>(target);
  const [position, setPosition] = useState<OverlayPosition | null>(null);
  const [scrollEdges, setScrollEdges] = useState<ScrollEdges>({ before: false, after: false });
  targetRef.current = target;

  useEffect(() => {
    let frame: number | null = null;
    const updatePosition = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        if (!root.isConnected || !target.isConnected) return;
        const rootRect = root.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const next = {
          top: targetRect.top - rootRect.top + root.scrollTop,
          left: targetRect.left - rootRect.left + root.scrollLeft,
          width: targetRect.width,
          height: Math.max(0, targetRect.height - 18),
        };
        setPosition((current) =>
          current &&
          Math.abs(current.top - next.top) < 1 &&
          Math.abs(current.left - next.left) < 1 &&
          Math.abs(current.width - next.width) < 1 &&
          Math.abs(current.height - next.height) < 1
            ? current
            : next,
        );
        const maxScroll = Math.max(0, target.scrollWidth - target.clientWidth);
        const offset = Math.min(maxScroll, Math.max(0, target.scrollLeft));
        const nextEdges = { before: offset > 1, after: maxScroll - offset > 1 };
        setScrollEdges((current) =>
          current.before === nextEdges.before && current.after === nextEdges.after
            ? current
            : nextEdges,
        );
      });
    };
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updatePosition);
    resizeObserver?.observe(root);
    resizeObserver?.observe(target);
    const table = target.querySelector("table");
    if (table) resizeObserver?.observe(table);
    const mutationObserver =
      typeof MutationObserver === "undefined" ? null : new MutationObserver(updatePosition);
    mutationObserver?.observe(target, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["style"],
    });
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    target.addEventListener("scroll", updatePosition, { passive: true });
    updatePosition();
    return () => {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      target.removeEventListener("scroll", updatePosition);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [root, target]);

  if (!position) return null;
  return createPortal(
    <div className="table-horizontal-overflow-overlay" style={position}>
      <span
        className={`table-horizontal-overflow-edge table-horizontal-overflow-edge--start${scrollEdges.before ? " is-visible" : ""}`}
        aria-hidden="true"
      />
      <span
        className={`table-horizontal-overflow-edge table-horizontal-overflow-edge--end${scrollEdges.after ? " is-visible" : ""}`}
        aria-hidden="true"
      />
      <div className="table-horizontal-scrollbar-overlay">
        <FloatingScrollbar
          scrollTargetRef={targetRef}
          controlsId={target.id}
          ariaLabel="表格横向滚动条"
          placement="bottom"
          orientation="horizontal"
        />
      </div>
    </div>,
    root,
  );
}

export function TableScrollbars({ rootRef }: { rootRef: RefObject<HTMLElement | null> }) {
  const [targets, setTargets] = useState<HTMLElement[]>([]);
  const instanceId = useId().replaceAll(":", "");

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const syncTargets = () => {
      const nextTargets = Array.from(root.querySelectorAll<HTMLElement>(".tableWrapper"));
      // 没有表格时提前短路，避免为每帧输入做额外的 class 与 id 写入。
      if (nextTargets.length === 0) {
        setTargets((current) => (current.length === 0 ? current : []));
        return;
      }
      nextTargets.forEach((target, index) => {
        target.classList.add("table-scroll-shell", "floating-scrollbar-target");
        if (!target.id) target.id = `table-scroll-${instanceId}-${index + 1}`;
      });
      setTargets((current) =>
        current.length === nextTargets.length &&
        current.every((target, index) => target === nextTargets[index])
          ? current
          : nextTargets,
      );
    };

    // MutationObserver 观察整篇文档，用 rAF 合并同步，避免每次回车/粘贴都立即重扫全文。
    let frame: number | null = null;
    const scheduleSync = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        syncTargets();
      });
    };

    syncTargets();
    const observer = new MutationObserver(scheduleSync);
    observer.observe(root, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [instanceId, rootRef]);

  const root = rootRef.current;
  if (!root) return null;
  return (
    <>
      {targets.map((target) => (
        <TableHorizontalScrollbar key={target.id} root={root} target={target} />
      ))}
    </>
  );
}
