import { useLayoutEffect, useState, type RefObject } from "react";

export interface ScrollEdges {
  before: boolean;
  after: boolean;
}

export function computeScrollEdges(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold = 1,
): ScrollEdges {
  const maxScroll = Math.max(0, scrollHeight - clientHeight);
  const offset = Math.min(maxScroll, Math.max(0, scrollTop));
  return {
    before: offset > threshold,
    after: maxScroll - offset > threshold,
  };
}

export function useScrollEdges(
  target: RefObject<HTMLElement | null> | HTMLElement | null,
  dependencies: readonly unknown[] = [],
): ScrollEdges {
  const [scrollEdges, setScrollEdges] = useState<ScrollEdges>({ before: false, after: false });

  useLayoutEffect(() => {
    const scrollRoot = target && "current" in target ? target.current : target;
    if (!scrollRoot) return;

    let animationFrame = 0;
    const updateScrollEdges = () => {
      animationFrame = 0;
      const nextEdges = computeScrollEdges(
        scrollRoot.scrollTop,
        scrollRoot.scrollHeight,
        scrollRoot.clientHeight,
      );
      setScrollEdges((current) =>
        current.before === nextEdges.before && current.after === nextEdges.after
          ? current
          : nextEdges,
      );
    };

    const scheduleScrollEdgeUpdate = () => {
      if (animationFrame) return;
      animationFrame = requestAnimationFrame(updateScrollEdges);
    };

    updateScrollEdges();
    scrollRoot.addEventListener("scroll", scheduleScrollEdgeUpdate, { passive: true });
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleScrollEdgeUpdate);
    resizeObserver?.observe(scrollRoot);
    if (scrollRoot.firstElementChild) resizeObserver?.observe(scrollRoot.firstElementChild);
    window.addEventListener("resize", scheduleScrollEdgeUpdate, { passive: true });

    return () => {
      scrollRoot.removeEventListener("scroll", scheduleScrollEdgeUpdate);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleScrollEdgeUpdate);
      if (animationFrame) cancelAnimationFrame(animationFrame);
    };
  }, [target && "current" in target ? target.current : target, ...dependencies]);

  return scrollEdges;
}
