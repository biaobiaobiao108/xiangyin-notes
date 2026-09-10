import { useCallback, useEffect, useRef, useState } from "react";
import type { FocusEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, RefObject } from "react";

type ScrollMetrics = {
  scrollable: boolean;
  thumbHeight: number;
  thumbTop: number;
  maxScroll: number;
  scrollTop: number;
};

type DragState = {
  pointerId: number;
  startY: number;
  startScrollTop: number;
};

const HIDE_DELAY = 1000;
const MIN_THUMB_HEIGHT = 28;

export function FloatingScrollbar({ scrollTargetRef, controlsId, ariaLabel, placement, enabled = true }: {
  scrollTargetRef: RefObject<HTMLElement | null>;
  controlsId: string;
  ariaLabel: string;
  placement: "left" | "right";
  enabled?: boolean;
}) {
  const scrollbarRef = useRef<HTMLDivElement>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frameRef = useRef<number | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const hoverRef = useRef(false);
  const focusRef = useRef(false);
  const [visible, setVisible] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [focused, setFocused] = useState(false);
  const [metrics, setMetrics] = useState<ScrollMetrics>({ scrollable: false, thumbHeight: 0, thumbTop: 0, maxScroll: 0, scrollTop: 0 });

  const updateMetrics = useCallback(() => {
    const target = scrollTargetRef.current;
    const scrollbar = scrollbarRef.current;
    if (!target || !scrollbar) return;
    const maxScroll = Math.max(0, target.scrollHeight - target.clientHeight);
    const scrollable = enabled && maxScroll > 1;
    const trackHeight = scrollbar.clientHeight;
    const thumbHeight = scrollable && target.scrollHeight > 0 ? Math.min(trackHeight, Math.max(MIN_THUMB_HEIGHT, Math.round(trackHeight * target.clientHeight / target.scrollHeight))) : 0;
    const maxThumbTop = Math.max(0, trackHeight - thumbHeight);
    const scrollTop = Math.min(maxScroll, Math.max(0, target.scrollTop));
    const thumbTop = maxScroll > 0 && maxThumbTop > 0 ? Math.round(scrollTop / maxScroll * maxThumbTop) : 0;
    const nextMetrics = { scrollable, thumbHeight, thumbTop, maxScroll: Math.round(maxScroll), scrollTop: Math.round(scrollTop) };
    setMetrics((current) => current.scrollable === nextMetrics.scrollable && current.thumbHeight === nextMetrics.thumbHeight && current.thumbTop === nextMetrics.thumbTop && current.maxScroll === nextMetrics.maxScroll && current.scrollTop === nextMetrics.scrollTop ? current : nextMetrics);
  }, [enabled, scrollTargetRef]);

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
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleMetrics);
    resizeObserver?.observe(target);
    resizeObserver?.observe(scrollbar);
    const mutationObserver = typeof MutationObserver === "undefined" ? null : new MutationObserver(scheduleMetrics);
    mutationObserver?.observe(target, { childList: true, subtree: true, characterData: true });
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
  }, [handleTargetActivity, scheduleMetrics, scrollTargetRef]);

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

  useEffect(() => () => {
    if (hideTimerRef.current !== null) clearTimeout(hideTimerRef.current);
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
  }, []);

  const handleFocus = useCallback(() => {
    focusRef.current = true;
    setFocused(true);
    reveal();
  }, [reveal]);

  const handleBlur = useCallback((event: FocusEvent<HTMLDivElement>) => {
    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) return;
    focusRef.current = false;
    setFocused(false);
    scheduleHide();
  }, [scheduleHide]);

  const handleThumbPointerEnter = useCallback(() => {
    hoverRef.current = true;
    reveal();
  }, [reveal]);

  const handleThumbPointerLeave = useCallback(() => {
    hoverRef.current = false;
    scheduleHide();
  }, [scheduleHide]);

  const handleThumbPointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const target = scrollTargetRef.current;
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = { pointerId: event.pointerId, startY: event.clientY, startScrollTop: target.scrollTop };
    setDragging(true);
    reveal();
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [reveal, scrollTargetRef]);

  const handleThumbPointerMove = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    const target = scrollTargetRef.current;
    const scrollbar = scrollbarRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !target || !scrollbar) return;
    event.preventDefault();
    event.stopPropagation();
    const maxScroll = Math.max(0, target.scrollHeight - target.clientHeight);
    const trackHeight = scrollbar.clientHeight;
    const thumbHeight = target.scrollHeight > 0 ? Math.min(trackHeight, Math.max(MIN_THUMB_HEIGHT, Math.round(trackHeight * target.clientHeight / target.scrollHeight))) : 0;
    const maxThumbTop = Math.max(0, trackHeight - thumbHeight);
    if (maxScroll > 0 && maxThumbTop > 0) target.scrollTop = Math.min(maxScroll, Math.max(0, drag.startScrollTop + (event.clientY - drag.startY) / maxThumbTop * maxScroll));
    scheduleMetrics();
    reveal();
  }, [reveal, scheduleMetrics, scrollTargetRef]);

  const finishDrag = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = null;
    setDragging(false);
    scheduleHide();
  }, [scheduleHide]);

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const target = scrollTargetRef.current;
    if (!target) return;
    const maxScroll = Math.max(0, target.scrollHeight - target.clientHeight);
    let nextScrollTop: number | undefined;
    if (event.key === "ArrowUp") nextScrollTop = target.scrollTop - 48;
    if (event.key === "ArrowDown") nextScrollTop = target.scrollTop + 48;
    if (event.key === "PageUp") nextScrollTop = target.scrollTop - target.clientHeight * 0.85;
    if (event.key === "PageDown") nextScrollTop = target.scrollTop + target.clientHeight * 0.85;
    if (event.key === "Home") nextScrollTop = 0;
    if (event.key === "End") nextScrollTop = maxScroll;
    if (nextScrollTop === undefined) return;
    event.preventDefault();
    target.scrollTop = Math.min(maxScroll, Math.max(0, nextScrollTop));
    scheduleMetrics();
    reveal();
  }, [reveal, scheduleMetrics, scrollTargetRef]);

  const isVisible = enabled && metrics.scrollable && (visible || dragging || focused);
  return <div className={`floating-scrollbar floating-scrollbar--${placement} ${isVisible ? "is-visible" : ""}`} ref={scrollbarRef} aria-hidden={!enabled || !metrics.scrollable} onFocusCapture={handleFocus} onBlurCapture={handleBlur}>
    <div className="floating-scrollbar-track" aria-hidden="true" />
    {enabled && metrics.scrollable && <button className={`floating-scrollbar-thumb ${dragging ? "is-dragging" : ""}`} type="button" role="scrollbar" aria-label={ariaLabel} aria-controls={controlsId} aria-valuemin={0} aria-valuemax={metrics.maxScroll} aria-valuenow={metrics.scrollTop} style={{ top: `${metrics.thumbTop}px`, height: `${metrics.thumbHeight}px` }} onPointerEnter={handleThumbPointerEnter} onPointerLeave={handleThumbPointerLeave} onPointerDown={handleThumbPointerDown} onPointerMove={handleThumbPointerMove} onPointerUp={finishDrag} onPointerCancel={finishDrag} onKeyDown={handleKeyDown} />}
  </div>;
}
