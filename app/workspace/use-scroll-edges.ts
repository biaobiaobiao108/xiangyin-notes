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
    let previousEdges: ScrollEdges | null = null;
    const updateScrollEdges = () => {
      animationFrame = 0;
      const nextEdges = computeScrollEdges(
        scrollRoot.scrollTop,
        scrollRoot.scrollHeight,
        scrollRoot.clientHeight,
      );
      // 滚动中间段的渐隐状态不变，不向整个面板排入重复的 React 更新。
      if (previousEdges?.before === nextEdges.before && previousEdges.after === nextEdges.after)
        return;
      previousEdges = nextEdges;
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
    const observed = new Set<Element>();
    const contentParents = new Set<Element>([scrollRoot]);
    const observeChild = (child: Element) => {
      observed.add(child);
      resizeObserver?.observe(child);
      if (getComputedStyle(child).display !== "contents") return;
      contentParents.add(child);
      for (const nested of child.children) observeChild(nested);
    };
    resizeObserver?.observe(scrollRoot);
    for (const child of scrollRoot.children) observeChild(child);
    const mutationObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver((records) => {
            let changed = false;
            for (const record of records) {
              if (!(record.target instanceof Element) || !contentParents.has(record.target))
                continue;
              changed = true;
              for (const node of record.removedNodes) {
                if (!(node instanceof Element)) continue;
                for (const element of observed) {
                  if (element === node || node.contains(element)) {
                    resizeObserver?.unobserve(element);
                    observed.delete(element);
                    contentParents.delete(element);
                  }
                }
              }
              for (const node of record.addedNodes) if (node instanceof Element) observeChild(node);
            }
            if (changed) scheduleScrollEdgeUpdate();
          });
    mutationObserver?.observe(scrollRoot, { childList: true, subtree: true });
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
