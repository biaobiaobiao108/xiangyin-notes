import { useCallback, useEffect, useRef, useState, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

const SWIPE_INTENT_DISTANCE = 8;
const HORIZONTAL_INTENT_RATIO = 1.2;
const OPEN_DISTANCE_RATIO = 0.4;
const SWIPE_VELOCITY_THRESHOLD = 0.35;

export type NoteSwipeAction = "trash" | "restore" | "permanent-delete";

type SwipeActionGroup = {
  openId: string | null;
  setOpenId: (id: string | null) => void;
  close: () => void;
};

export function useSwipeActionGroup(rootRef: RefObject<HTMLElement | null>, active = true, resetKey?: string): SwipeActionGroup {
  const [openId, setOpenId] = useState<string | null>(null);
  const close = useCallback(() => setOpenId(null), []);

  useEffect(() => {
    if (!active) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    const onFocusIn = (event: FocusEvent) => {
      if (!rootRef.current?.contains(event.target as Node) || !(event.target instanceof Element && event.target.closest(".swipe-action-button"))) close();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("focusin", onFocusIn, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("focusin", onFocusIn, true);
    };
  }, [active, close, rootRef]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !openId) return;
    root.addEventListener("scroll", close, { passive: true });
    return () => root.removeEventListener("scroll", close);
  }, [close, openId, rootRef]);

  useEffect(() => {
    close();
  }, [active, close, resetKey]);

  return { openId, setOpenId, close };
}

type SwipeActionGestureOptions = {
  enabled: boolean;
  itemId: string;
  open: boolean;
  actionWidth: number;
  onOpenChange: (id: string | null) => void;
  foregroundRef: RefObject<HTMLElement | null>;
};

type ActivePointer = {
  id: number;
  startX: number;
  startY: number;
  startOffset: number;
  latestX: number;
  latestTime: number;
  locked: boolean;
  cancelled: boolean;
};

function clampOffset(offset: number, actionWidth: number) {
  return Math.max(-actionWidth, Math.min(0, offset));
}

export function shouldOpenSwipeActions(offset: number, actionWidth: number, velocityX: number) {
  return offset <= -actionWidth * OPEN_DISTANCE_RATIO || velocityX <= -SWIPE_VELOCITY_THRESHOLD;
}

export function useSwipeActionGesture({ enabled, itemId, open, actionWidth, onOpenChange, foregroundRef }: SwipeActionGestureOptions) {
  const pointerRef = useRef<ActivePointer | null>(null);
  const suppressClickRef = useRef(false);

  const resetForeground = useCallback(() => {
    const foreground = foregroundRef.current;
    if (foreground) {
      foreground.style.transition = "";
      foreground.style.transform = "";
    }
  }, [foregroundRef]);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!enabled || event.pointerType !== "touch" || !event.isPrimary || event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest(".swipe-action-button, .note-card-star-btn, a, input, textarea, select, [contenteditable='true']")) return;
    pointerRef.current = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startOffset: open ? -actionWidth : 0,
      latestX: event.clientX,
      latestTime: event.timeStamp,
      locked: false,
      cancelled: false,
    };
    suppressClickRef.current = false;
  }, [actionWidth, enabled, open]);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const pointer = pointerRef.current;
    if (!pointer || pointer.id !== event.pointerId) return;
    if (pointer.cancelled) return;
    const deltaX = event.clientX - pointer.startX;
    const deltaY = event.clientY - pointer.startY;
    if (!pointer.locked) {
      if (Math.hypot(deltaX, deltaY) < SWIPE_INTENT_DISTANCE) return;
      if (Math.abs(deltaX) < Math.abs(deltaY) * HORIZONTAL_INTENT_RATIO) {
        pointer.cancelled = true;
        return;
      }
      if ((!open && deltaX >= 0) || (open && deltaX <= 0)) {
        pointer.cancelled = true;
        return;
      }
      pointer.locked = true;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      if (foregroundRef.current) foregroundRef.current.style.transition = "none";
    }

    event.preventDefault();
    pointer.latestX = event.clientX;
    pointer.latestTime = event.timeStamp;
    const offset = clampOffset(pointer.startOffset + deltaX, actionWidth);
    if (foregroundRef.current) foregroundRef.current.style.transform = `translate3d(${offset}px, 0, 0)`;
  }, [actionWidth, foregroundRef, open]);

  const finishPointer = useCallback((event: ReactPointerEvent<HTMLElement>, cancelled: boolean) => {
    const pointer = pointerRef.current;
    if (!pointer || pointer.id !== event.pointerId) return;
    pointerRef.current = null;
    if (!pointer.locked || cancelled || pointer.cancelled) {
      if (cancelled || pointer.cancelled) {
        suppressClickRef.current = true;
        window.setTimeout(() => { suppressClickRef.current = false; }, 0);
      }
      resetForeground();
      return;
    }

    const deltaX = event.clientX - pointer.startX;
    const offset = clampOffset(pointer.startOffset + deltaX, actionWidth);
    const elapsed = Math.max(1, event.timeStamp - pointer.latestTime);
    const velocityX = (event.clientX - pointer.latestX) / elapsed;
    const shouldOpen = shouldOpenSwipeActions(offset, actionWidth, velocityX);
    suppressClickRef.current = true;
    window.setTimeout(() => { suppressClickRef.current = false; }, 0);
    resetForeground();
    onOpenChange(shouldOpen ? itemId : null);
  }, [actionWidth, itemId, onOpenChange, resetForeground]);

  const handleClickCapture = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (open && !(event.target instanceof Element && event.target.closest(".swipe-action-button"))) onOpenChange(null);
  }, [onOpenChange, open]);

  const handleFocusCapture = useCallback((event: ReactFocusEvent<HTMLElement>) => {
    if (event.target instanceof Element && event.target.closest(".swipe-action-button")) onOpenChange(itemId);
  }, [itemId, onOpenChange]);

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (open && event.key === "Escape" && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
      event.preventDefault();
      event.stopPropagation();
      onOpenChange(null);
    }
  }, [onOpenChange, open]);

  return {
    onPointerDown: handlePointerDown,
    onPointerMove: handlePointerMove,
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => finishPointer(event, false),
    onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => finishPointer(event, true),
    onLostPointerCapture: (event: ReactPointerEvent<HTMLElement>) => finishPointer(event, true),
    onClickCapture: handleClickCapture,
    onFocusCapture: handleFocusCapture,
    onKeyDownCapture: handleKeyDown,
  };
}
