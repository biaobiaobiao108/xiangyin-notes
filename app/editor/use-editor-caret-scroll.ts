import { useCallback } from "react";
import type { Editor } from "@tiptap/react";
import { mobileCaretBounds } from "./use-mobile-caret";

type Ref<T> = { current: T };

export function useEditorCaretScroll({
  mobileViewportRef,
  mobileCaretScrollRef,
  editorScrollRef,
  typewriterModeRef,
  typewriterAnimRef,
  typewriterTargetRef,
}: {
  mobileViewportRef: Ref<boolean>;
  mobileCaretScrollRef: Ref<() => void>;
  editorScrollRef: Ref<HTMLDivElement | null>;
  typewriterModeRef: Ref<boolean>;
  typewriterAnimRef: Ref<number | null>;
  typewriterTargetRef: Ref<number | null>;
}) {
  const smoothScrollToHead = useCallback((view: Editor["view"]) => {
    if (mobileViewportRef.current) {
      mobileCaretScrollRef.current();
      return;
    }
    requestAnimationFrame(() => {
      const scrollContainer = editorScrollRef.current;
      if (!scrollContainer) return;
      try {
        const head = view.state.selection.head;
        const coords = view.coordsAtPos(head);
        const containerRect = scrollContainer.getBoundingClientRect();
        const paddingBottom = 64;
        const isBelow = coords.bottom > containerRect.bottom - paddingBottom;
        const isAbove = coords.top < containerRect.top + 24;

        if (isBelow) {
          const diff = coords.bottom - (containerRect.bottom - paddingBottom);
          const maxScroll = Math.max(
            0,
            scrollContainer.scrollHeight - scrollContainer.clientHeight,
          );
          const targetScrollTop = Math.min(maxScroll, scrollContainer.scrollTop + diff);
          const prefersReducedMotion = window.matchMedia(
            "(prefers-reduced-motion: reduce)",
          ).matches;
          if (prefersReducedMotion) {
            scrollContainer.scrollTop = targetScrollTop;
          } else {
            scrollContainer.scrollTo({
              top: targetScrollTop,
              behavior: "smooth",
            });
          }
        } else if (isAbove) {
          const diff = containerRect.top + 24 - coords.top;
          const targetScrollTop = Math.max(0, scrollContainer.scrollTop - diff);
          const prefersReducedMotion = window.matchMedia(
            "(prefers-reduced-motion: reduce)",
          ).matches;
          if (prefersReducedMotion) {
            scrollContainer.scrollTop = targetScrollTop;
          } else {
            scrollContainer.scrollTo({
              top: targetScrollTop,
              behavior: "smooth",
            });
          }
        }
      } catch {
        // coordsAtPos may throw if editor position is not yet rendered
      }
    });
  }, []);

  const alignTypewriter = useCallback((target: Editor | Editor["view"], immediate = false) => {
    if (!typewriterModeRef.current) return;
    const view = "view" in target ? target.view : target;
    if (!view || view.isDestroyed || !view.hasFocus()) return;

    requestAnimationFrame(() => {
      const scrollContainer = editorScrollRef.current;
      if (!scrollContainer || !view || view.isDestroyed || !view.hasFocus()) return;

      try {
        const head = view.state.selection.head;
        const coords = view.coordsAtPos(head);
        const containerRect = scrollContainer.getBoundingClientRect();
        const cursorCenterY = (coords.top + coords.bottom) / 2;
        const bounds = mobileViewportRef.current
          ? mobileCaretBounds(scrollContainer)
          : { top: containerRect.top, bottom: containerRect.bottom };
        if (
          mobileViewportRef.current &&
          window.visualViewport &&
          Math.abs(window.visualViewport.scale - 1) > 0.01
        )
          return;
        const targetY = bounds.top + (bounds.bottom - bounds.top) * 0.6;
        const delta = cursorCenterY - targetY;
        const maxScroll = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
        const targetScrollTop = Math.min(
          maxScroll,
          Math.max(0, Math.round(scrollContainer.scrollTop + delta)),
        );

        // Negligible distance: prevent jitter on same-line typing
        if (Math.abs(scrollContainer.scrollTop - targetScrollTop) < 2) {
          return;
        }

        // Already animating to this target position: do not restart
        if (
          typewriterTargetRef.current !== null &&
          Math.abs(typewriterTargetRef.current - targetScrollTop) < 2
        ) {
          return;
        }

        const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        if (prefersReducedMotion || immediate) {
          if (typewriterAnimRef.current !== null) {
            cancelAnimationFrame(typewriterAnimRef.current);
            typewriterAnimRef.current = null;
          }
          scrollContainer.scrollTop = targetScrollTop;
          typewriterTargetRef.current = null;
          return;
        }

        if (typewriterAnimRef.current !== null) {
          cancelAnimationFrame(typewriterAnimRef.current);
          typewriterAnimRef.current = null;
        }

        const startTop = scrollContainer.scrollTop;
        const distance = targetScrollTop - startTop;
        const duration = 160;
        const startTime = performance.now();
        const easeOutQuart = (t: number) => 1 - Math.pow(1 - t, 4);

        const step = (now: number) => {
          const elapsed = now - startTime;
          const progress = Math.min(1, elapsed / duration);
          const eased = easeOutQuart(progress);
          scrollContainer.scrollTop = Math.round(startTop + distance * eased);

          if (progress < 1) {
            typewriterAnimRef.current = requestAnimationFrame(step);
          } else {
            scrollContainer.scrollTop = targetScrollTop;
            typewriterAnimRef.current = null;
            typewriterTargetRef.current = null;
          }
        };

        typewriterTargetRef.current = targetScrollTop;
        typewriterAnimRef.current = requestAnimationFrame(step);
      } catch {
        // coordsAtPos may throw if selection position is not yet rendered
      }
    });
  }, []);
  return { smoothScrollToHead, alignTypewriter };
}
