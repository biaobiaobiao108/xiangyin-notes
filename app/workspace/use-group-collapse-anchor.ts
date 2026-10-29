import { useEffect, useRef, type RefObject } from "react";

// 随内容高度缩减同步回收已滚过的距离，标题留在顶部，且不在动画前展示首行。
export function useGroupCollapseAnchor(scrollRef: RefObject<HTMLDivElement | null>) {
  const frameRef = useRef<number | null>(null);
  const cancel = () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  };
  useEffect(() => cancel, []);

  return (targetTop?: number, contentHeight?: number, contentSelector?: string) => {
    cancel();
    const scroll = scrollRef.current;
    if (!scroll || targetTop === undefined || contentHeight === undefined || !contentSelector)
      return;
    const initialTop = scroll.scrollTop;
    if (initialTop <= targetTop) return;
    const update = () => {
      const content = scroll.querySelector<HTMLElement>(contentSelector);
      const height = content?.getBoundingClientRect().height ?? 0;
      scroll.scrollTop = Math.max(targetTop, initialTop - contentHeight + height);
      if (content && height > 0) frameRef.current = requestAnimationFrame(update);
      else frameRef.current = null;
    };
    frameRef.current = requestAnimationFrame(update);
  };
}
