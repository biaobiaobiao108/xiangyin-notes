import { useCallback, useEffect, useRef, useState } from "react";
import type {
  FocusEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from "react";

type ScrollMetrics = {
  scrollable: boolean;
  thumbExtent: number;
  thumbOffset: number;
  maxScroll: number;
  scrollOffset: number;
};

type DragState = {
  pointerId: number;
  startCoordinate: number;
  startScrollOffset: number;
};

const HIDE_DELAY = 1000;
const MIN_THUMB_HEIGHT = 28;

export function FloatingScrollbar({
  scrollTargetRef,
  contentRef,
  controlsId,
  ariaLabel,
  placement,
  orientation = "vertical",
  enabled = true,
}: {
  scrollTargetRef: RefObject<HTMLElement | null>;
  contentRef?: RefObject<HTMLElement | null>;
  controlsId: string;
  ariaLabel: string;
  placement: "left" | "right" | "bottom";
  orientation?: "vertical" | "horizontal";
  enabled?: boolean;
}) {
  const scrollbarRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLButtonElement | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frameRef = useRef<number | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const hoverRef = useRef(false);
  const focusRef = useRef(false);
  const [visible, setVisible] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [focused, setFocused] = useState(false);
  const [scrollable, setScrollable] = useState(false);
  const metricsRef = useRef<ScrollMetrics>({
    scrollable: false,
    thumbExtent: 0,
    thumbOffset: 0,
    maxScroll: 0,
    scrollOffset: 0,
  });

  // 位置只影响滑块，不经 React 渲染；挂载时也同步，避免首帧位置闪动。
  const syncThumb = useCallback(() => {
    const thumb = thumbRef.current;
    if (!thumb) return;
    const metrics = metricsRef.current;
    thumb.style.setProperty("--scrollbar-offset", `${metrics.thumbOffset}px`);
    thumb.style.setProperty("--scrollbar-extent", `${metrics.thumbExtent}px`);
    thumb.setAttribute("aria-valuemax", String(metrics.maxScroll));
    thumb.setAttribute("aria-valuenow", String(metrics.scrollOffset));
  }, []);

  const attachThumb = useCallback(
    (thumb: HTMLButtonElement | null) => {
      thumbRef.current = thumb;
      syncThumb();
    },
    [syncThumb],
  );

  const updateMetrics = useCallback(() => {
    const target = scrollTargetRef.current;
    const scrollbar = scrollbarRef.current;
    if (!target || !scrollbar) return;
    const horizontal = orientation === "horizontal";
    const contentExtent = horizontal ? target.scrollWidth : target.scrollHeight;
    const viewportExtent = horizontal ? target.clientWidth : target.clientHeight;
    const currentOffset = horizontal ? target.scrollLeft : target.scrollTop;
    const maxScroll = Math.max(0, contentExtent - viewportExtent);
    const scrollable = enabled && maxScroll > 1;
    const trackExtent = horizontal ? scrollbar.clientWidth : scrollbar.clientHeight;
    const thumbExtent =
      scrollable && contentExtent > 0
        ? Math.min(
            trackExtent,
            Math.max(MIN_THUMB_HEIGHT, Math.round((trackExtent * viewportExtent) / contentExtent)),
          )
        : 0;
    const maxThumbOffset = Math.max(0, trackExtent - thumbExtent);
    const scrollOffset = Math.min(maxScroll, Math.max(0, currentOffset));
    const thumbOffset =
      maxScroll > 0 && maxThumbOffset > 0
        ? Math.round((scrollOffset / maxScroll) * maxThumbOffset)
        : 0;
    const nextMetrics = {
      scrollable,
      thumbExtent,
      thumbOffset,
      maxScroll: Math.round(maxScroll),
      scrollOffset: Math.round(scrollOffset),
    };
    const current = metricsRef.current;
    if (
      current.scrollable === nextMetrics.scrollable &&
      current.thumbExtent === nextMetrics.thumbExtent &&
      current.thumbOffset === nextMetrics.thumbOffset &&
      current.maxScroll === nextMetrics.maxScroll &&
      current.scrollOffset === nextMetrics.scrollOffset
    )
      return;
    metricsRef.current = nextMetrics;
    if (current.scrollable !== nextMetrics.scrollable) setScrollable(nextMetrics.scrollable);
    syncThumb();
  }, [enabled, orientation, scrollTargetRef, syncThumb]);

  const scheduleMetrics = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      updateMetrics();
    });
  }, [updateMetrics]);

  const scheduleHide = useCallback(() => {
    if (hideTimerRef.current !== null) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      hideTimerRef.current = null;
      if (!hoverRef.current && !focusRef.current && !dragRef.current) setVisible(false);
    }, HIDE_DELAY);
  }, []);

  const reveal = useCallback(() => {
    setVisible(true);
    scheduleHide();
  }, [scheduleHide]);

  const handleTargetActivity = useCallback(() => {
    scheduleMetrics();
    reveal();
  }, [reveal, scheduleMetrics]);

  useEffect(() => {
    const target = scrollTargetRef.current;
    const scrollbar = scrollbarRef.current;
    if (!target || !scrollbar) return;
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleMetrics);
    resizeObserver?.observe(target);
    resizeObserver?.observe(scrollbar);
    const content = contentRef?.current;
    if (content && content !== target) resizeObserver?.observe(content);
    const mutationObserver =
      content || typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(scheduleMetrics);
    mutationObserver?.observe(target, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["style"],
    });
    target.addEventListener("scroll", handleTargetActivity, { passive: true });
    target.addEventListener("pointerenter", handleTargetActivity);
    target.addEventListener("pointermove", handleTargetActivity);
    target.addEventListener("wheel", handleTargetActivity, { passive: true });
    window.addEventListener("resize", scheduleMetrics);
    scheduleMetrics();
    return () => {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      target.removeEventListener("scroll", handleTargetActivity);
      target.removeEventListener("pointerenter", handleTargetActivity);
      target.removeEventListener("pointermove", handleTargetActivity);
      target.removeEventListener("wheel", handleTargetActivity);
      window.removeEventListener("resize", scheduleMetrics);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [contentRef, handleTargetActivity, scheduleMetrics, scrollTargetRef]);

  useEffect(() => {
    if (enabled) {
      scheduleMetrics();
      return;
    }
    setVisible(false);
    setDragging(false);
    setFocused(false);
    dragRef.current = null;
  }, [enabled, scheduleMetrics]);

  useEffect(
    () => () => {
      if (hideTimerRef.current !== null) clearTimeout(hideTimerRef.current);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  const handleFocus = useCallback(() => {
    focusRef.current = true;
    setFocused(true);
    reveal();
  }, [reveal]);

  const handleBlur = useCallback(
    (event: FocusEvent<HTMLDivElement>) => {
      const relatedTarget = event.relatedTarget;
      if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) return;
      focusRef.current = false;
      setFocused(false);
      scheduleHide();
    },
    [scheduleHide],
  );

  const handleThumbPointerEnter = useCallback(() => {
    hoverRef.current = true;
    reveal();
  }, [reveal]);

  const handleThumbPointerLeave = useCallback(() => {
    hoverRef.current = false;
    scheduleHide();
  }, [scheduleHide]);

  const handleThumbPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const target = scrollTargetRef.current;
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      const horizontal = orientation === "horizontal";
      dragRef.current = {
        pointerId: event.pointerId,
        startCoordinate: horizontal ? event.clientX : event.clientY,
        startScrollOffset: horizontal ? target.scrollLeft : target.scrollTop,
      };
      setDragging(true);
      reveal();
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [orientation, reveal, scrollTargetRef],
  );

  const handleThumbPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const drag = dragRef.current;
      const target = scrollTargetRef.current;
      const scrollbar = scrollbarRef.current;
      if (!drag || drag.pointerId !== event.pointerId || !target || !scrollbar) return;
      event.preventDefault();
      event.stopPropagation();
      const horizontal = orientation === "horizontal";
      const contentExtent = horizontal ? target.scrollWidth : target.scrollHeight;
      const viewportExtent = horizontal ? target.clientWidth : target.clientHeight;
      const maxScroll = Math.max(0, contentExtent - viewportExtent);
      const trackExtent = horizontal ? scrollbar.clientWidth : scrollbar.clientHeight;
      const thumbExtent =
        contentExtent > 0
          ? Math.min(
              trackExtent,
              Math.max(
                MIN_THUMB_HEIGHT,
                Math.round((trackExtent * viewportExtent) / contentExtent),
              ),
            )
          : 0;
      const maxThumbOffset = Math.max(0, trackExtent - thumbExtent);
      const coordinate = horizontal ? event.clientX : event.clientY;
      if (maxScroll > 0 && maxThumbOffset > 0) {
        const nextOffset = Math.min(
          maxScroll,
          Math.max(
            0,
            drag.startScrollOffset +
              ((coordinate - drag.startCoordinate) / maxThumbOffset) * maxScroll,
          ),
        );
        if (horizontal) target.scrollLeft = nextOffset;
        else target.scrollTop = nextOffset;
      }
      scheduleMetrics();
      reveal();
    },
    [orientation, reveal, scheduleMetrics, scrollTargetRef],
  );

  const finishDrag = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (dragRef.current?.pointerId !== event.pointerId) return;
      if (event.currentTarget.hasPointerCapture(event.pointerId))
        event.currentTarget.releasePointerCapture(event.pointerId);
      dragRef.current = null;
      setDragging(false);
      scheduleHide();
    },
    [scheduleHide],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      const target = scrollTargetRef.current;
      if (!target) return;
      const horizontal = orientation === "horizontal";
      const maxScroll = horizontal
        ? Math.max(0, target.scrollWidth - target.clientWidth)
        : Math.max(0, target.scrollHeight - target.clientHeight);
      const currentOffset = horizontal ? target.scrollLeft : target.scrollTop;
      let nextOffset: number | undefined;
      if (horizontal && event.key === "ArrowLeft") nextOffset = currentOffset - 48;
      if (horizontal && event.key === "ArrowRight") nextOffset = currentOffset + 48;
      if (!horizontal && event.key === "ArrowUp") nextOffset = currentOffset - 48;
      if (!horizontal && event.key === "ArrowDown") nextOffset = currentOffset + 48;
      if (!horizontal && event.key === "PageUp")
        nextOffset = currentOffset - target.clientHeight * 0.85;
      if (!horizontal && event.key === "PageDown")
        nextOffset = currentOffset + target.clientHeight * 0.85;
      if (event.key === "Home") nextOffset = 0;
      if (event.key === "End") nextOffset = maxScroll;
      if (nextOffset === undefined) return;
      event.preventDefault();
      const boundedOffset = Math.min(maxScroll, Math.max(0, nextOffset));
      const isPageNavigation = ["PageUp", "PageDown", "Home", "End"].includes(event.key);
      if (isPageNavigation) {
        const behavior: ScrollBehavior = !window.matchMedia("(prefers-reduced-motion: reduce)")
          .matches
          ? "smooth"
          : "auto";
        if (horizontal) target.scrollTo({ left: boundedOffset, behavior });
        else target.scrollTo({ top: boundedOffset, behavior });
      } else if (horizontal) target.scrollLeft = boundedOffset;
      else target.scrollTop = boundedOffset;
      scheduleMetrics();
      reveal();
    },
    [orientation, reveal, scheduleMetrics, scrollTargetRef],
  );

  const isVisible = enabled && scrollable && (visible || dragging || focused);
  return (
    <div
      className={`floating-scrollbar floating-scrollbar--${placement} ${orientation === "horizontal" ? "floating-scrollbar--horizontal" : ""} ${isVisible ? "is-visible" : ""}`}
      ref={scrollbarRef}
      aria-hidden={!enabled || !scrollable}
      onFocusCapture={handleFocus}
      onBlurCapture={handleBlur}
    >
      <div className="floating-scrollbar-track" aria-hidden="true" />
      {enabled && scrollable && (
        <button
          className={`floating-scrollbar-thumb ${dragging ? "is-dragging" : ""}`}
          type="button"
          role="scrollbar"
          aria-label={ariaLabel}
          aria-controls={controlsId}
          aria-orientation={orientation}
          aria-valuemin={0}
          ref={attachThumb}
          onPointerEnter={handleThumbPointerEnter}
          onPointerLeave={handleThumbPointerLeave}
          onPointerDown={handleThumbPointerDown}
          onPointerMove={handleThumbPointerMove}
          onPointerUp={finishDrag}
          onPointerCancel={finishDrag}
          onKeyDown={handleKeyDown}
        />
      )}
    </div>
  );
}
