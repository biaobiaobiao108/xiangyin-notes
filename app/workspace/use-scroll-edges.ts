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
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleScrollEdgeUpdate);
    // 吸顶标题不随正文变高；同时观察正文及 display:contents 分组，跟随收展更新渐隐。
    const mutationObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(() => {
            observeContent();
            scheduleScrollEdgeUpdate();
          });
    const observeContent = () => {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      resizeObserver?.observe(scrollRoot);
      const observeChildren = (parent: Element) => {
        mutationObserver?.observe(parent, { childList: true });
        for (const child of parent.children) {
          resizeObserver?.observe(child);
          if (getComputedStyle(child).display === "contents") observeChildren(child);
        }
      };
      observeChildren(scrollRoot);
    };
    observeContent();
    window.addEventListener("resize", scheduleScrollEdgeUpdate, { passive: true });

    return () => {
      scrollRoot.removeEventListener("scroll", scheduleScrollEdgeUpdate);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      window.removeEventListener("resize", scheduleScrollEdgeUpdate);
      if (animationFrame) cancelAnimationFrame(animationFrame);
    };
  }, [target && "current" in target ? target.current : target, ...dependencies]);

  return scrollEdges;
}
