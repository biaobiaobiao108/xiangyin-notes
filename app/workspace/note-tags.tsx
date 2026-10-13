import { useLayoutEffect, useRef, useState } from "react";
import { NOTE_TAG_DISPLAY_LIMIT } from "./helpers";

// Always keep the first tag; it can ellipsize after reserving space for the count.
export function fittingTagCount(width: number, tagWidths: readonly number[], countWidth: number, total: number, gap: number) {
  for (let count = tagWidths.length; count > 1; count -= 1) {
    const hasOverflow = total > count;
    const required = tagWidths.slice(0, count).reduce((sum, value) => sum + value, 0)
      + gap * (count - 1 + Number(hasOverflow)) + (hasOverflow ? countWidth : 0);
    if (required <= width) return count;
  }
  return Math.min(1, tagWidths.length);
}

export function NoteTags({ tags, variant }: { tags: string[]; variant: "row" | "card" }) {
  const containerRef = useRef<HTMLSpanElement>(null);
  const rulerRef = useRef<HTMLSpanElement>(null);
  const [visibleCount, setVisibleCount] = useState(NOTE_TAG_DISPLAY_LIMIT);
  const candidates = tags.slice(0, NOTE_TAG_DISPLAY_LIMIT);
  const prefix = `note-${variant}`;

  useLayoutEffect(() => {
    const container = containerRef.current;
    const ruler = rulerRef.current;
    if (!container || !ruler) return;
    const measure = () => {
      const children = Array.from(ruler.children);
      const widths = children.slice(0, -1).map((element) => element.getBoundingClientRect().width);
      const countWidth = children.at(-1)?.getBoundingClientRect().width ?? 0;
      setVisibleCount(fittingTagCount(container.clientWidth, widths, countWidth, tags.length, parseFloat(getComputedStyle(container).columnGap) || 0));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    observer.observe(ruler);
    return () => observer.disconnect();
  }, [tags]);

  if (!tags.length) return null;
  const visible = candidates.slice(0, visibleCount);
  return <span ref={containerRef} className={`${prefix}-tags`} aria-label={`标签：${tags.map((tag) => `#${tag}`).join("、")}`}>
    {visible.map((tag) => <span className={`${prefix}-tag`} key={tag}>#{tag}</span>)}
    {tags.length > visible.length && <span className={`${prefix}-tag ${prefix}-tag--overflow`}>+{tags.length - visible.length}</span>}
    <span className="note-tags-measure" aria-hidden="true">
      <span ref={rulerRef} className="note-tags-ruler">
        {candidates.map((tag) => <span className={`${prefix}-tag`} key={tag}>#{tag}</span>)}
        <span className={`${prefix}-tag ${prefix}-tag--overflow`}>+{tags.length}</span>
      </span>
    </span>
  </span>;
}
