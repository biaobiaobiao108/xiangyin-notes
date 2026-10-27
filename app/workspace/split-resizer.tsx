import {
  memo,
  useCallback,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

export type SplitResizerProps = {
  splitRatio: number;
  onSplitRatioChange: (ratio: number) => void;
  containerRef: React.RefObject<HTMLElement | null>;
};

export const MIN_SPLIT_RATIO = 0.25;
export const MAX_SPLIT_RATIO = 0.75;
export const DEFAULT_SPLIT_RATIO = 0.5;

export function clampSplitRatio(ratio: number): number {
  return Math.max(MIN_SPLIT_RATIO, Math.min(MAX_SPLIT_RATIO, Math.round(ratio * 1000) / 1000));
}

export const SplitResizer = memo(function SplitResizer({
  splitRatio,
  onSplitRatioChange,
  containerRef,
}: SplitResizerProps) {
  const [isDragging, setIsDragging] = useState(false);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const container = containerRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      const containerLeft = rect.left;
      const containerWidth = rect.width;
      if (containerWidth <= 0) return;

      const target = event.currentTarget;
      target.setPointerCapture(event.pointerId);
      setIsDragging(true);

      let rafId: number | null = null;
      const handlePointerMove = (moveEvent: PointerEvent) => {
        if (rafId !== null) cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(() => {
          rafId = null;
          const rawRatio = (moveEvent.clientX - containerLeft) / containerWidth;
          onSplitRatioChange(clampSplitRatio(rawRatio));
        });
      };

      const handlePointerUp = (upEvent: PointerEvent) => {
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
        try {
          target.releasePointerCapture(upEvent.pointerId);
        } catch {
          // In case capture was lost
        }
        setIsDragging(false);
        target.removeEventListener("pointermove", handlePointerMove);
        target.removeEventListener("pointerup", handlePointerUp);
        target.removeEventListener("pointercancel", handlePointerUp);
        target.removeEventListener("lostpointercapture", handlePointerUp);
      };

      target.addEventListener("pointermove", handlePointerMove);
      target.addEventListener("pointerup", handlePointerUp);
      target.addEventListener("pointercancel", handlePointerUp);
      target.addEventListener("lostpointercapture", handlePointerUp);
    },
    [containerRef, onSplitRatioChange],
  );

  const handleDoubleClick = useCallback(() => {
    onSplitRatioChange(DEFAULT_SPLIT_RATIO);
  }, [onSplitRatioChange]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        onSplitRatioChange(clampSplitRatio(splitRatio - 0.05));
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        onSplitRatioChange(clampSplitRatio(splitRatio + 0.05));
      } else if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        onSplitRatioChange(DEFAULT_SPLIT_RATIO);
      }
    },
    [onSplitRatioChange, splitRatio],
  );

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label="调整分栏宽度"
      aria-valuenow={Math.round(splitRatio * 100)}
      aria-valuemin={Math.round(MIN_SPLIT_RATIO * 100)}
      aria-valuemax={Math.round(MAX_SPLIT_RATIO * 100)}
      aria-valuetext={`${Math.round(splitRatio * 100)}%`}
      className={`split-resizer ${isDragging ? "is-dragging" : ""}`}
      onPointerDown={handlePointerDown}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
    />
  );
});
