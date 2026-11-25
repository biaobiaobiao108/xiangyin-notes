import { useLayoutEffect, type RefObject } from "react";

export function useDiagramHeight(
  bodyRef: RefObject<HTMLDivElement | null>,
  previewRef: RefObject<HTMLDivElement | null>,
) {
  useLayoutEffect(() => {
    const body = bodyRef.current;
    const preview = previewRef.current;
    if (!body || !preview) return;
    let frame = 0;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        body.style.setProperty("--mermaid-body-height", `${entry.contentRect.height}px`);
      });
    });
    observer.observe(preview);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [bodyRef, previewRef]);
}
