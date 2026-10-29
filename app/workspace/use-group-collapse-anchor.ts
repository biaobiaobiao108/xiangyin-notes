import { useEffect, useRef, useState, type RefObject } from "react";

// 随内容高度缩减同步回收已滚过的距离，标题留在顶部，且不在动画前展示首行。
export function useGroupCollapseAnchor(scrollRef: RefObject<HTMLDivElement | null>) {
  const [isAnchoring, setIsAnchoring] = useState(false);
  const frameRef = useRef<number | null>(null);
  const initialScrollTopRef = useRef<number | null>(null);
  const translatedContentRef = useRef<HTMLElement | null>(null);
  const cancel = (restorePosition = false) => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    // 中途反向展开时，同一帧还原滚动和正文补偿，避免清掉 transform 后首行闪现。
    if (restorePosition && initialScrollTopRef.current !== null && scrollRef.current)
      scrollRef.current.scrollTop = initialScrollTopRef.current;
    initialScrollTopRef.current = null;
    translatedContentRef.current?.style.removeProperty("transform");
    translatedContentRef.current = null;
    setIsAnchoring(false);
  };
  useEffect(() => () => cancel(), []);

  const anchorGroupCollapse = (
    targetTop?: number,
    contentHeight?: number,
    contentSelector?: string,
  ) => {
    cancel(true);
    const scroll = scrollRef.current;
    if (!scroll || targetTop === undefined || contentHeight === undefined || !contentSelector)
      return;
    const initialTop = scroll.scrollTop;
    if (initialTop <= targetTop) return;
    initialScrollTopRef.current = initialTop;
    setIsAnchoring(true);
    const update = () => {
      const content = scroll.querySelector<HTMLElement>(contentSelector);
      const height = content?.getBoundingClientRect().height ?? 0;
      scroll.scrollTop = Math.max(targetTop, initialTop - contentHeight + height);
      const inner = content?.firstElementChild;
      if (inner instanceof HTMLElement && height > 0) {
        // 滚动距离回收时抵消内容位移，避免已经滚过的首条内容重新露出。
        inner.style.transform = `translateY(${scroll.scrollTop - initialTop}px)`;
        translatedContentRef.current = inner;
        frameRef.current = requestAnimationFrame(update);
      } else cancel();
    };
    frameRef.current = requestAnimationFrame(update);
  };
  return { anchorGroupCollapse, isAnchoring };
}
