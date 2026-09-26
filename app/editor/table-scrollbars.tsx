import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { FloatingScrollbar } from "../floating-scrollbar";

type OverlayPosition = { top: number; left: number; width: number };

function TableHorizontalScrollbar({ root, target }: { root: HTMLElement; target: HTMLElement }) {
  const targetRef = useRef<HTMLElement | null>(target);
  const [position, setPosition] = useState<OverlayPosition | null>(null);
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
          top: targetRect.bottom - rootRect.top + root.scrollTop - 18,
          left: targetRect.left - rootRect.left + root.scrollLeft,
          width: targetRect.width,
        };
        setPosition((current) => current && Math.abs(current.top - next.top) < 1 && Math.abs(current.left - next.left) < 1 && Math.abs(current.width - next.width) < 1 ? current : next);
      });
    };
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updatePosition);
    resizeObserver?.observe(root);
    resizeObserver?.observe(target);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    updatePosition();
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [root, target]);

  if (!position) return null;
  return createPortal(<div className="table-horizontal-scrollbar-overlay" style={position}>
    <FloatingScrollbar
      scrollTargetRef={targetRef}
      controlsId={target.id}
      ariaLabel="表格横向滚动条"
      placement="bottom"
      orientation="horizontal"
    />
  </div>, root);
}

export function TableScrollbars({ rootRef }: { rootRef: RefObject<HTMLElement | null> }) {
  const [targets, setTargets] = useState<HTMLElement[]>([]);
  const instanceId = useId().replaceAll(":", "");

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const syncTargets = () => {
      const nextTargets = Array.from(root.querySelectorAll<HTMLElement>(".tableWrapper"));
      nextTargets.forEach((target, index) => {
        target.classList.add("table-scroll-shell", "floating-scrollbar-target");
        if (!target.id) target.id = `table-scroll-${instanceId}-${index + 1}`;
      });
      setTargets((current) => current.length === nextTargets.length && current.every((target, index) => target === nextTargets[index]) ? current : nextTargets);
    };

    syncTargets();
    const observer = new MutationObserver(syncTargets);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [instanceId, rootRef]);

  const root = rootRef.current;
  if (!root) return null;
  return <>{targets.map((target) => <TableHorizontalScrollbar key={target.id} root={root} target={target} />)}</>;
}
