import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import { ArrowDown, ArrowUp, Copy, Trash2 } from "lucide-react";
import {
  calculateDropCandidate,
  deleteBlock,
  duplicateBlock,
  getBlockShift,
  getDraggableBlockFromElement,
  getSiblingBlocks,
  moveBlock,
  moveBlockStep,
  type BlockSlot,
  type BlockTarget,
  type DropCandidate,
} from "./block-drag-commands";

type BlockDragHandleProps = {
  editor: Editor | null;
  containerRef: RefObject<HTMLDivElement | null>;
  scrollRef: RefObject<HTMLDivElement | null>;
  disabled?: boolean;
};

type HandlePosition = {
  top: number;
  left: number;
};

type MenuPosition = {
  top: number;
  left: number;
};

type DragSession = {
  pointerId: number;
  startX: number;
  startY: number;
  pointerX: number;
  pointerY: number;
  block: BlockTarget;
  siblings: BlockTarget[];
  sourceIndex: number;
  sourceSpan: number;
  sourceTop: number;
  initialScroll: number;
  initialDoc: Editor["state"]["doc"];
  slots: BlockSlot[];
  preview: HTMLElement | null;
  frame: number | null;
  active: boolean;
  dropping: boolean;
  cancelled: boolean;
  candidate: DropCandidate | null;
  sourceAnimation: Animation | null;
  shiftAnimations: Map<HTMLElement, { animation: Animation; shift: number }>;
};

const HANDLE_LEFT = -30;
const HANDLE_WIDTH = 24;
const HANDLE_HOVER_LEFT = HANDLE_LEFT - 12;
const HANDLE_HOVER_RIGHT = HANDLE_LEFT + HANDLE_WIDTH + 6;
const DRAG_THRESHOLD = 6;
const PREVIEW_PADDING_X = 10;
const PREVIEW_PADDING_Y = 7;
const SCROLL_EDGE = 60;
const SCROLL_MAX_STEP = 14;
const MENU_WIDTH = 164;
const MENU_ESTIMATED_HEIGHT = 158;
const HIDE_DELAY = 220;
const HANDLE_FADE_OUT = 180;
const MIN_LIST_PREVIEW_WIDTH = 160;
const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function focusEditor(editor: Editor) {
  if (editor.isDestroyed) return;
  editor.view.dom.focus({ preventScroll: true });
}

function blockAnchorTop(block: BlockTarget): number {
  if (!block.dom) return 0;
  const rect = block.dom.getBoundingClientRect();
  const range = document.createRange();
  range.selectNodeContents(block.dom);
  const lineRects = Array.from(range.getClientRects()).filter(
    (line) => line.width > 0 && line.height > 0,
  );
  if (!lineRects.length) return rect.top;
  return Math.max(rect.top, Math.min(...lineRects.map((line) => line.top)));
}

function pointerInHandleGutter(
  container: HTMLElement,
  scroll: HTMLElement | null,
  x: number,
  y: number,
): boolean {
  const containerRect = container.getBoundingClientRect();
  const scrollRect = scroll?.getBoundingClientRect();
  return (
    x >= containerRect.left + HANDLE_HOVER_LEFT &&
    x <= containerRect.left + HANDLE_HOVER_RIGHT &&
    (!scrollRect || (y >= scrollRect.top && y <= scrollRect.bottom))
  );
}

function blockAtHandleGutter(editor: Editor, y: number): BlockTarget | null {
  const editorDom = editor.view.dom;
  const rect = editorDom.getBoundingClientRect();
  const target = document.elementFromPoint(rect.left + 6, y);
  if (!(target instanceof HTMLElement)) return null;
  if (target !== editorDom && !editorDom.contains(target)) return null;

  const listRoot = target.closest<HTMLElement>("li, ul, ol");
  if (listRoot) {
    const items =
      listRoot.tagName === "LI"
        ? [listRoot, ...listRoot.querySelectorAll<HTMLElement>("li")]
        : Array.from(listRoot.querySelectorAll<HTMLElement>("li"));
    let listItem: HTMLElement | null = null;
    let listItemDepth = -1;
    let listItemHeight = Number.POSITIVE_INFINITY;
    for (const item of items) {
      const itemRect = item.getBoundingClientRect();
      if (y < itemRect.top || y > itemRect.bottom) continue;
      let depth = 0;
      for (
        let parent = item.parentElement;
        parent && parent !== editorDom;
        parent = parent.parentElement
      ) {
        if (parent.tagName === "LI") depth += 1;
      }
      if (depth < listItemDepth) continue;
      if (depth === listItemDepth && itemRect.height >= listItemHeight) continue;
      listItem = item;
      listItemDepth = depth;
      listItemHeight = itemRect.height;
    }
    if (listItem) {
      return getDraggableBlockFromElement(editor, listItem, { x: rect.left + 6, y });
    }
  }

  return getDraggableBlockFromElement(editor, target, { x: rect.left + 6, y });
}

function textContentRight(element: HTMLElement): number | null {
  const range = document.createRange();
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let right: number | null = null;
  let node = walker.nextNode();
  while (node) {
    if (node.nodeValue?.trim()) {
      range.selectNodeContents(node);
      Array.from(range.getClientRects()).forEach((rect) => {
        if (rect.width <= 0 || rect.height <= 0) return;
        right = Math.max(right ?? rect.right, rect.right);
      });
    }
    node = walker.nextNode();
  }
  return right;
}

function createDragPreview(source: BlockTarget): HTMLElement | null {
  if (!source.dom) return null;
  const sourceRect = source.dom.getBoundingClientRect();
  const preview = document.createElement("div");
  preview.className = "block-drag-preview";
  preview.setAttribute("aria-hidden", "true");

  const content = document.createElement("div");
  content.className = "note-prose block-drag-preview-content";
  const clone = source.dom.cloneNode(true) as HTMLElement;
  clone.style.marginTop = "0";
  clone.style.marginBottom = "0";
  clone.querySelectorAll<HTMLElement>("[contenteditable], [tabindex]").forEach((element) => {
    element.removeAttribute("contenteditable");
    element.removeAttribute("tabindex");
  });
  clone.querySelectorAll<HTMLImageElement>("img").forEach((image) => {
    image.draggable = false;
  });

  let listPadding = 0;
  if (source.kind === "listItem" && source.dom.parentElement) {
    const listClone = source.dom.parentElement.cloneNode(false) as HTMLElement;
    listClone.style.marginTop = "0";
    listClone.style.marginBottom = "0";
    if (clone instanceof HTMLLIElement && source.dom.parentElement instanceof HTMLOListElement) {
      const start = Number.parseInt(source.dom.parentElement.getAttribute("start") ?? "1", 10) || 1;
      clone.value = start + source.index;
    }
    listClone.appendChild(clone);
    listPadding = Number.parseFloat(getComputedStyle(source.dom.parentElement).paddingLeft) || 0;
    const contentRight = textContentRight(source.dom);
    const hasWideContent = Boolean(source.dom.querySelector("img, video, iframe, table, pre"));
    const visibleWidth = hasWideContent
      ? sourceRect.width
      : contentRight === null
        ? MIN_LIST_PREVIEW_WIDTH
        : Math.min(
            sourceRect.width,
            Math.max(MIN_LIST_PREVIEW_WIDTH, contentRight - sourceRect.left),
          );
    content.style.width = `${visibleWidth + listPadding}px`;
    content.appendChild(listClone);
    preview.style.width = `${visibleWidth + listPadding + PREVIEW_PADDING_X * 2}px`;
    preview.style.left = `${sourceRect.left - listPadding - PREVIEW_PADDING_X}px`;
  } else {
    content.style.width = `${sourceRect.width}px`;
    content.appendChild(clone);
    preview.style.width = `${sourceRect.width + PREVIEW_PADDING_X * 2}px`;
    preview.style.left = `${sourceRect.left - PREVIEW_PADDING_X}px`;
  }

  preview.style.top = `${sourceRect.top - PREVIEW_PADDING_Y}px`;
  preview.appendChild(content);
  document.body.appendChild(preview);
  return preview;
}

function animatePreview(
  preview: HTMLElement,
  fromY: number,
  toY: number,
  duration: number,
): Promise<void> {
  if (prefersReducedMotion()) {
    preview.style.transform = `translate3d(0, ${toY}px, 0)`;
    return Promise.resolve();
  }
  const animation = preview.animate(
    [{ transform: `translate3d(0, ${fromY}px, 0)` }, { transform: `translate3d(0, ${toY}px, 0)` }],
    {
      duration,
      easing: "cubic-bezier(0.16, 1, 0.3, 1)",
      fill: "forwards",
    },
  );
  return animation.finished
    .catch(() => undefined)
    .then(() => {
      preview.style.transform = `translate3d(0, ${toY}px, 0)`;
      animation.cancel();
    });
}

export function BlockDragHandle({
  editor,
  containerRef,
  scrollRef,
  disabled = false,
}: BlockDragHandleProps) {
  const [activeBlock, setActiveBlock] = useState<BlockTarget | null>(null);
  const [handlePosition, setHandlePosition] = useState<HandlePosition | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [handleVisible, setHandleVisible] = useState(false);

  const handleRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const activeBlockRef = useRef<BlockTarget | null>(null);
  const menuOpenRef = useRef(false);
  const isDraggingRef = useRef(false);
  const handleVisibleRef = useRef(false);
  const handleWasShownRef = useRef(false);
  const hideTimeoutRef = useRef<number | null>(null);
  const unmountTimeoutRef = useRef<number | null>(null);
  const revealFrameRef = useRef<number | null>(null);
  const dragSessionRef = useRef<DragSession | null>(null);
  const cancelDragRef = useRef<(() => void) | null>(null);

  const clearHideTimeout = useCallback(() => {
    if (hideTimeoutRef.current === null) return;
    window.clearTimeout(hideTimeoutRef.current);
    hideTimeoutRef.current = null;
  }, []);

  const clearUnmountTimeout = useCallback(() => {
    if (unmountTimeoutRef.current === null) return;
    window.clearTimeout(unmountTimeoutRef.current);
    unmountTimeoutRef.current = null;
  }, []);

  const cancelRevealFrame = useCallback(() => {
    if (revealFrameRef.current === null) return;
    window.cancelAnimationFrame(revealFrameRef.current);
    revealFrameRef.current = null;
  }, []);

  const closeMenu = useCallback((returnFocus: boolean) => {
    setMenuOpen(false);
    menuOpenRef.current = false;
    if (returnFocus) {
      window.requestAnimationFrame(() => handleRef.current?.focus());
    }
  }, []);

  const clearActiveBlock = useCallback(() => {
    clearHideTimeout();
    clearUnmountTimeout();
    cancelRevealFrame();
    activeBlockRef.current = null;
    handleVisibleRef.current = false;
    handleWasShownRef.current = false;
    setActiveBlock(null);
    setHandlePosition(null);
    setHandleVisible(false);
    closeMenu(false);
  }, [cancelRevealFrame, clearHideTimeout, clearUnmountTimeout, closeMenu]);

  const updateHandlePosition = useCallback(
    (block: BlockTarget) => {
      const container = containerRef.current;
      if (!container || !block.dom) return;
      const containerRect = container.getBoundingClientRect();
      const anchorTop = blockAnchorTop(block);
      activeBlockRef.current = block;
      setActiveBlock(block);
      setHandlePosition({
        top: anchorTop - containerRect.top - 1,
        left: HANDLE_LEFT,
      });
    },
    [containerRef],
  );

  const revealHandle = useCallback(
    (block: BlockTarget) => {
      clearHideTimeout();
      clearUnmountTimeout();
      if (activeBlockRef.current?.pos !== block.pos || !handleRef.current) {
        updateHandlePosition(block);
      }
      if (handleVisibleRef.current || revealFrameRef.current !== null) return;
      if (prefersReducedMotion()) {
        handleVisibleRef.current = true;
        handleWasShownRef.current = true;
        setHandleVisible(true);
        return;
      }
      if (handleWasShownRef.current && handleRef.current) {
        handleVisibleRef.current = true;
        setHandleVisible(true);
        return;
      }
      revealFrameRef.current = window.requestAnimationFrame(() => {
        revealFrameRef.current = null;
        if (!activeBlockRef.current) return;
        revealFrameRef.current = window.requestAnimationFrame(() => {
          revealFrameRef.current = null;
          if (!activeBlockRef.current) return;
          handleRef.current?.getBoundingClientRect();
          handleVisibleRef.current = true;
          handleWasShownRef.current = true;
          setHandleVisible(true);
        });
      });
    },
    [clearHideTimeout, clearUnmountTimeout, updateHandlePosition],
  );

  const hideHandle = useCallback(() => {
    cancelRevealFrame();
    clearUnmountTimeout();
    if (!handleVisibleRef.current) return;
    handleVisibleRef.current = false;
    setHandleVisible(false);
    unmountTimeoutRef.current = window.setTimeout(() => {
      unmountTimeoutRef.current = null;
      activeBlockRef.current = null;
      handleWasShownRef.current = false;
      setActiveBlock(null);
      setHandlePosition(null);
    }, HANDLE_FADE_OUT);
  }, [cancelRevealFrame, clearUnmountTimeout]);

  const scheduleHide = useCallback(() => {
    cancelRevealFrame();
    if (hideTimeoutRef.current !== null || unmountTimeoutRef.current !== null) return;
    hideTimeoutRef.current = window.setTimeout(() => {
      hideTimeoutRef.current = null;
      if (isDraggingRef.current || menuOpenRef.current) return;
      hideHandle();
    }, HIDE_DELAY);
  }, [cancelRevealFrame, hideHandle]);

  const openMenu = useCallback(() => {
    const handle = handleRef.current;
    if (!handle || !activeBlockRef.current) return;
    clearHideTimeout();
    const rect = handle.getBoundingClientRect();
    const left = Math.min(
      Math.max(8, rect.left - 6),
      Math.max(8, window.innerWidth - MENU_WIDTH - 8),
    );
    let top = rect.bottom + 6;
    if (top + MENU_ESTIMATED_HEIGHT > window.innerHeight - 8) {
      top = Math.max(8, rect.top - MENU_ESTIMATED_HEIGHT - 6);
    }
    setMenuPosition({ top, left });
    setMenuOpen(true);
    menuOpenRef.current = true;
  }, [clearHideTimeout]);

  useEffect(() => {
    if (!editor || editor.isDestroyed || disabled) {
      clearActiveBlock();
      return;
    }
    const container = containerRef.current;
    if (!container) return;

    const handlePointerMove = (event: PointerEvent) => {
      if (
        dragSessionRef.current ||
        isDraggingRef.current ||
        menuOpenRef.current ||
        event.pointerType === "touch"
      ) {
        return;
      }
      const target = event.target;
      if (
        target instanceof Node &&
        (handleRef.current?.contains(target) || menuRef.current?.contains(target))
      ) {
        clearHideTimeout();
        return;
      }
      if (!pointerInHandleGutter(container, scrollRef.current, event.clientX, event.clientY)) {
        scheduleHide();
        return;
      }
      const block = blockAtHandleGutter(editor, event.clientY);
      if (!block) {
        scheduleHide();
        return;
      }
      revealHandle(block);
    };

    const handlePointerLeave = () => {
      if (!menuOpenRef.current && !isDraggingRef.current) scheduleHide();
    };

    const refreshHandle = () => {
      if (menuOpenRef.current) {
        closeMenu(false);
        return;
      }
      const current = activeBlockRef.current;
      if (!current?.dom?.isConnected || isDraggingRef.current) return;
      const fresh = getDraggableBlockFromElement(editor, current.dom);
      if (fresh) updateHandlePosition(fresh);
      else clearActiveBlock();
    };

    const resizeObserver = new ResizeObserver(refreshHandle);
    resizeObserver.observe(container);
    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    window.addEventListener("resize", refreshHandle);
    container.addEventListener("pointerleave", handlePointerLeave);
    const scrollElement = scrollRef.current;
    scrollElement?.addEventListener("scroll", refreshHandle, { passive: true });

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("resize", refreshHandle);
      container.removeEventListener("pointerleave", handlePointerLeave);
      scrollElement?.removeEventListener("scroll", refreshHandle);
      resizeObserver.disconnect();
      clearHideTimeout();
    };
  }, [
    clearActiveBlock,
    clearHideTimeout,
    closeMenu,
    containerRef,
    disabled,
    editor,
    scheduleHide,
    scrollRef,
    updateHandlePosition,
    revealHandle,
  ]);

  useEffect(() => {
    if (!menuOpen) return;
    const handleOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target) || handleRef.current?.contains(target)) return;
      closeMenu(false);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closeMenu(true);
    };
    window.addEventListener("pointerdown", handleOutsidePointer, true);
    window.addEventListener("keydown", handleEscape, true);
    return () => {
      window.removeEventListener("pointerdown", handleOutsidePointer, true);
      window.removeEventListener("keydown", handleEscape, true);
    };
  }, [closeMenu, menuOpen]);

  useLayoutEffect(() => {
    if (!menuOpen) return;
    const firstItem = menuRef.current?.querySelector<HTMLButtonElement>(
      '[role="menuitem"]:not(:disabled)',
    );
    firstItem?.focus();
  }, [menuOpen, menuPosition]);

  useEffect(() => {
    if (disabled) {
      cancelDragRef.current?.();
      clearActiveBlock();
    }
  }, [clearActiveBlock, disabled]);

  useEffect(() => {
    return () => {
      cancelDragRef.current?.();
      clearHideTimeout();
      clearUnmountTimeout();
      cancelRevealFrame();
    };
  }, [cancelRevealFrame, clearHideTimeout, clearUnmountTimeout, editor]);

  const startDragSession = (event: PointerEvent, source: BlockTarget) => {
    if (!editor || editor.isDestroyed) return;
    const siblings = getSiblingBlocks(editor, source);
    const sourceIndex = siblings.findIndex((block) => block.pos === source.pos);
    if (sourceIndex < 0) return;

    const slots: BlockSlot[] = [];
    for (const block of siblings) {
      if (!block.dom) return;
      const rect = block.dom.getBoundingClientRect();
      slots.push({ block, top: rect.top, bottom: rect.bottom });
    }

    const sourceRect = source.dom?.getBoundingClientRect();
    const scrollElement = scrollRef.current;
    if (!sourceRect || !scrollElement) return;
    const nextSibling = source.dom?.nextElementSibling;
    let sourceSpan = nextSibling
      ? nextSibling.getBoundingClientRect().top - sourceRect.top
      : sourceRect.height + (Number.parseFloat(getComputedStyle(source.dom!).marginBottom) || 0);
    if (!Number.isFinite(sourceSpan) || sourceSpan <= 0) sourceSpan = sourceRect.height;

    const session: DragSession = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      pointerX: event.clientX,
      pointerY: event.clientY,
      block: source,
      siblings,
      sourceIndex,
      sourceSpan,
      sourceTop: sourceRect.top,
      initialScroll: scrollElement.scrollTop,
      initialDoc: editor.state.doc,
      slots,
      preview: null,
      frame: null,
      active: false,
      dropping: false,
      cancelled: false,
      candidate: null,
      sourceAnimation: null,
      shiftAnimations: new Map(),
    };
    dragSessionRef.current = session;

    const scrollDelta = () =>
      (scrollRef.current?.scrollTop ?? session.initialScroll) - session.initialScroll;
    let lastTickTime: number | null = null;
    let autoScrollDirection = 0;
    let autoScrollBudget = 0;
    let lastPreviewOffset: number | null = null;

    const pointerInsideEditor = () => {
      const container = containerRef.current;
      const scroll = scrollRef.current;
      if (!container || !scroll) return false;
      const containerRect = container.getBoundingClientRect();
      const scrollRect = scroll.getBoundingClientRect();
      return (
        session.pointerX >= containerRect.left - 48 &&
        session.pointerX <= containerRect.right + 48 &&
        session.pointerY >= scrollRect.top &&
        session.pointerY <= scrollRect.bottom
      );
    };

    const updatePreview = (frameScale = 1) => {
      if (!session.active || !session.preview) return;
      const inside = pointerInsideEditor();
      const scroll = scrollRef.current;
      const scrollRect = scroll?.getBoundingClientRect();
      if (scroll && scrollRect && inside && !session.dropping) {
        const above = session.pointerY - scrollRect.top;
        const below = scrollRect.bottom - session.pointerY;
        const direction = above < SCROLL_EDGE ? -1 : below < SCROLL_EDGE ? 1 : 0;
        if (direction !== autoScrollDirection) autoScrollBudget = 0;
        autoScrollDirection = direction;
        if (direction !== 0) {
          const distance = direction < 0 ? above : below;
          const strength = Math.min(1, Math.max(0, (SCROLL_EDGE - distance) / SCROLL_EDGE));
          // Normalize to 60fps and carry fractional steps instead of scrolling once per frame.
          autoScrollBudget +=
            direction * strength * SCROLL_MAX_STEP * Math.min(2, Math.max(0.1, frameScale));
          const pixels = Math.trunc(autoScrollBudget);
          if (pixels !== 0) {
            autoScrollBudget -= pixels;
            scroll.scrollTop += pixels;
          }
        }
      } else {
        autoScrollDirection = 0;
        autoScrollBudget = 0;
      }

      const delta = scrollDelta();
      const candidate = inside
        ? calculateDropCandidate(
            session.slots,
            session.sourceIndex,
            session.pointerY + delta,
            session.candidate,
          )
        : null;
      session.candidate = candidate;

      const animateShift = (element: HTMLElement, shift: number) => {
        const previous = session.shiftAnimations.get(element);
        if (previous?.shift === shift) return;
        if (!previous && shift === 0) return;
        let currentShift = previous?.shift ?? 0;
        if (previous) {
          const transform = getComputedStyle(element).transform;
          if (transform && transform !== "none") {
            currentShift = new DOMMatrixReadOnly(transform).m42;
          }
          previous.animation.cancel();
        }
        const animation = element.animate(
          [{ transform: `translateY(${currentShift}px)` }, { transform: `translateY(${shift}px)` }],
          {
            duration: prefersReducedMotion() ? 0 : 180,
            easing: "cubic-bezier(0.16, 1, 0.3, 1)",
            fill: "forwards",
          },
        );
        session.shiftAnimations.set(element, { animation, shift });
      };

      session.slots.forEach((slot, index) => {
        if (index === session.sourceIndex || !slot.block.dom) return;
        const shift =
          candidate && !candidate.noop
            ? getBlockShift(
                index,
                session.sourceIndex,
                candidate.destinationIndex,
                session.sourceSpan,
              )
            : 0;
        animateShift(slot.block.dom, shift);
      });

      const previewOffset = session.pointerY - session.startY;
      if (previewOffset !== lastPreviewOffset) {
        lastPreviewOffset = previewOffset;
        session.preview.style.transform = `translate3d(0, ${previewOffset}px, 0)`;
      }
    };

    const tick = (time: number) => {
      if (!session.active || session.dropping) return;
      const elapsed =
        lastTickTime === null ? 1000 / 60 : Math.min(50, Math.max(1, time - lastTickTime));
      lastTickTime = time;
      updatePreview(elapsed / (1000 / 60));
      session.frame = window.requestAnimationFrame(tick);
    };

    const cleanupVisuals = () => {
      if (session.frame !== null) cancelAnimationFrame(session.frame);
      session.frame = null;
      session.preview?.remove();
      session.preview = null;
      session.shiftAnimations.forEach(({ animation }) => animation.cancel());
      session.shiftAnimations.clear();
      session.sourceAnimation?.cancel();
      session.sourceAnimation = null;
      document.body.classList.remove("is-sorting-blocks");
    };

    const removeListeners = () => {
      window.removeEventListener("pointermove", movePointer);
      window.removeEventListener("pointerup", finishPointer);
      window.removeEventListener("pointercancel", cancelPointer);
      window.removeEventListener("blur", blurWindow);
      window.removeEventListener("resize", resizeWindow);
      window.removeEventListener("keydown", escapeDrag, true);
      editor.off("transaction", handleTransaction);
    };

    const dispose = () => {
      cleanupVisuals();
      removeListeners();
      if (dragSessionRef.current === session) {
        dragSessionRef.current = null;
        cancelDragRef.current = null;
      }
      isDraggingRef.current = false;
      setIsDragging(false);
      activeBlockRef.current = null;
      handleVisibleRef.current = false;
      handleWasShownRef.current = false;
      setActiveBlock(null);
      setHandlePosition(null);
      setHandleVisible(false);
    };

    const returnPreviewToSource = async () => {
      if (!session.preview) return;
      const currentSourceTop =
        session.block.dom?.getBoundingClientRect().top ?? session.sourceTop - scrollDelta();
      const returnY = currentSourceTop - session.sourceTop;
      await animatePreview(session.preview, session.pointerY - session.startY, returnY, 140);
    };

    const resetSiblingShifts = () => {
      const animations: Promise<unknown>[] = [];
      session.shiftAnimations.forEach(({ animation }, element) => {
        const transform = getComputedStyle(element).transform;
        const currentShift =
          transform && transform !== "none" ? new DOMMatrixReadOnly(transform).m42 : 0;
        animation.cancel();
        if (!element.isConnected || Math.abs(currentShift) < 0.5) return;
        animations.push(
          element
            .animate(
              [{ transform: `translateY(${currentShift}px)` }, { transform: "translateY(0)" }],
              {
                duration: prefersReducedMotion() ? 0 : 140,
                easing: "cubic-bezier(0.16, 1, 0.3, 1)",
              },
            )
            .finished.catch(() => undefined),
        );
      });
      session.shiftAnimations.clear();
      return Promise.all(animations);
    };

    const restoreSource = () => {
      session.sourceAnimation?.cancel();
      session.sourceAnimation = null;
      if (!session.block.dom || prefersReducedMotion()) return Promise.resolve();
      const animation = session.block.dom.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: 140,
        easing: "cubic-bezier(0.16, 1, 0.3, 1)",
        fill: "forwards",
      });
      session.sourceAnimation = animation;
      return animation.finished.catch(() => undefined);
    };

    const animateBackToSource = async () => {
      try {
        await Promise.all([returnPreviewToSource(), resetSiblingShifts(), restoreSource()]);
      } finally {
        dispose();
      }
    };

    const cancel = async (animate: boolean, force = false) => {
      if (session.dropping && !force) return;
      session.dropping = true;
      session.cancelled = true;
      if (session.frame !== null) cancelAnimationFrame(session.frame);
      session.frame = null;
      if (animate && session.active) await animateBackToSource();
      else dispose();
    };

    const cancelPointer = () => {
      void cancel(true);
    };

    const blurWindow = () => {
      void cancel(false);
    };

    const resizeWindow = () => {
      void cancel(false);
    };

    const escapeDrag = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void cancel(true);
    };

    const handleTransaction = ({ transaction }: { transaction: { docChanged: boolean } }) => {
      if (session.dropping || !transaction.docChanged) return;
      void cancel(false);
    };

    const beginDrag = () => {
      const created = createDragPreview(session.block);
      if (!created) {
        void cancel(false);
        return;
      }
      session.preview = created;

      session.active = true;
      isDraggingRef.current = true;
      setIsDragging(true);
      closeMenu(false);
      clearHideTimeout();
      if (session.block.dom) {
        session.sourceAnimation = session.block.dom.animate([{ opacity: 1 }, { opacity: 0 }], {
          duration: prefersReducedMotion() ? 0 : 160,
          easing: "cubic-bezier(0.16, 1, 0.3, 1)",
          fill: "forwards",
        });
      }
      document.body.classList.add("is-sorting-blocks");
      editor.on("transaction", handleTransaction);
      tick(performance.now());
    };

    const animateBack = animateBackToSource;

    const finishDrop = async () => {
      if (!session.active) return;
      session.dropping = true;
      if (session.frame !== null) cancelAnimationFrame(session.frame);
      session.frame = null;
      updatePreview();
      let moved = false;
      try {
        const candidate = session.candidate;
        const targetIndex = candidate
          ? session.slots.findIndex((slot) => slot.block.pos === candidate.target.pos)
          : -1;
        if (
          !candidate ||
          candidate.noop ||
          targetIndex < 0 ||
          editor.state.doc !== session.initialDoc
        ) {
          await animateBack();
          return;
        }

        const preview = session.preview;
        if (!preview) {
          await animateBack();
          return;
        }

        const previewOffset = session.pointerY - session.startY;
        const beforeTops = new Map<HTMLElement, number>();
        session.slots.forEach(({ block }) => {
          if (!block.dom) return;
          beforeTops.set(block.dom, block.dom.getBoundingClientRect().top);
        });

        const movedPosition = moveBlock(
          editor,
          session.block,
          candidate.target,
          candidate.placement,
        );
        if (movedPosition === null) {
          await animateBack();
          return;
        }
        moved = true;

        const movedDom = editor.view.nodeDOM(movedPosition);
        if (!(movedDom instanceof HTMLElement)) return;

        session.shiftAnimations.forEach(({ animation }) => animation.cancel());
        session.shiftAnimations.clear();
        session.sourceAnimation?.cancel();
        document.body.classList.remove("is-sorting-blocks");
        session.sourceAnimation = movedDom.animate([{ opacity: 0 }, { opacity: 0 }], {
          duration: 1,
          fill: "forwards",
        });

        // Measure the committed layout so the preview lands exactly where the block will live.
        const finalTop = movedDom.getBoundingClientRect().top;
        const reducedMotion = prefersReducedMotion();
        if (!reducedMotion) {
          beforeTops.forEach((beforeTop, element) => {
            if (!element.isConnected || element === movedDom) return;
            const afterTop = element.getBoundingClientRect().top;
            if (Math.abs(beforeTop - afterTop) < 0.5) return;
            element.animate(
              [
                { transform: `translateY(${beforeTop - afterTop}px)` },
                { transform: "translateY(0)" },
              ],
              { duration: 180, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
            );
          });
        }

        await animatePreview(preview, previewOffset, finalTop - session.sourceTop, 160);
        if (session.cancelled) return;

        if (!reducedMotion) {
          session.sourceAnimation?.cancel();
          const fadeOut = preview.animate([{ opacity: 0.98 }, { opacity: 0 }], {
            duration: 90,
            easing: "cubic-bezier(0.16, 1, 0.3, 1)",
            fill: "forwards",
          });
          const fadeIn = movedDom.animate([{ opacity: 0 }, { opacity: 1 }], {
            duration: 110,
            easing: "cubic-bezier(0.16, 1, 0.3, 1)",
            fill: "forwards",
          });
          session.sourceAnimation = fadeIn;
          await Promise.all([
            fadeOut.finished.catch(() => undefined),
            fadeIn.finished.catch(() => undefined),
          ]);
          if (session.cancelled) return;
          fadeOut.cancel();
          fadeIn.cancel();
          session.sourceAnimation = null;
        }

        dispose();

        if (!reducedMotion) {
          movedDom.animate(
            [{ backgroundColor: "var(--accent-soft)" }, { backgroundColor: "transparent" }],
            { duration: 220, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
          );
        }
      } finally {
        dispose();
        if (moved) focusEditor(editor);
      }
    };

    const movePointer = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== session.pointerId || session.dropping) return;
      session.pointerX = moveEvent.clientX;
      session.pointerY = moveEvent.clientY;
      if (!session.active) {
        if (
          Math.hypot(session.pointerX - session.startX, session.pointerY - session.startY) >=
          DRAG_THRESHOLD
        ) {
          beginDrag();
        }
      }
    };

    const finishPointer = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== session.pointerId || session.dropping) return;
      session.pointerX = upEvent.clientX;
      session.pointerY = upEvent.clientY;
      if (!session.active) {
        removeListeners();
        dragSessionRef.current = null;
        cancelDragRef.current = null;
        const moved = Math.hypot(
          session.pointerX - session.startX,
          session.pointerY - session.startY,
        );
        if (moved < DRAG_THRESHOLD) openMenu();
        return;
      }
      void finishDrop();
    };

    cancelDragRef.current = () => {
      void cancel(false, true);
    };
    window.addEventListener("pointermove", movePointer);
    window.addEventListener("pointerup", finishPointer);
    window.addEventListener("pointercancel", cancelPointer);
    window.addEventListener("blur", blurWindow);
    window.addEventListener("resize", resizeWindow);
    window.addEventListener("keydown", escapeDrag, true);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (disabled || !editor || editor.isDestroyed) return;
    if (event.pointerType === "touch" || event.button !== 0 || !event.isPrimary) return;
    if (menuOpenRef.current) {
      closeMenu(false);
      return;
    }
    const current = activeBlockRef.current;
    if (!current?.dom) return;
    const fresh = getDraggableBlockFromElement(editor, current.dom);
    if (!fresh) return;
    event.preventDefault();
    event.stopPropagation();
    clearHideTimeout();
    event.currentTarget.setPointerCapture(event.pointerId);
    startDragSession(event.nativeEvent, fresh);
  };

  const handleHandleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (disabled || !activeBlockRef.current) return;
    if (menuOpen) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeMenu(true);
      }
      return;
    }
    if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
      event.preventDefault();
      openMenu();
    }
  };

  const runMenuAction = (action: (block: BlockTarget) => void) => {
    if (!editor || !activeBlockRef.current?.dom) return;
    try {
      const current = getDraggableBlockFromElement(editor, activeBlockRef.current.dom);
      if (current) action(current);
    } finally {
      closeMenu(false);
      clearActiveBlock();
      if (!editor.isDestroyed) focusEditor(editor);
    }
  };

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
      return;
    }
    if (event.key === "Tab") {
      closeMenu(false);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ??
        [],
    );
    if (!items.length) return;
    event.preventDefault();
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    let nextIndex = 0;
    if (event.key === "End") nextIndex = items.length - 1;
    else if (event.key === "ArrowDown") nextIndex = Math.max(0, (currentIndex + 1) % items.length);
    else if (event.key === "ArrowUp") {
      nextIndex = (currentIndex <= 0 ? items.length : currentIndex) - 1;
    }
    items[nextIndex]?.focus();
  };

  const canMoveUp = Boolean(activeBlock && activeBlock.index > 0);
  const canMoveDown = Boolean(activeBlock && activeBlock.index < activeBlock.parent.childCount - 1);

  return (
    <>
      {!disabled && activeBlock && handlePosition && (
        <button
          ref={handleRef}
          type="button"
          className={`block-drag-handle${handleVisible ? " is-visible" : ""}${menuOpen ? " is-active" : ""}${isDragging ? " is-dragging" : ""}`}
          style={{ top: `${handlePosition.top}px`, left: `${handlePosition.left}px` }}
          aria-label="拖动或操作当前块"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? "block-actions-menu" : undefined}
          onPointerDown={handlePointerDown}
          onClick={(event) => event.preventDefault()}
          onKeyDown={handleHandleKeyDown}
        >
          <span className="block-drag-dots" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
            <span />
            <span />
          </span>
        </button>
      )}
      {menuOpen &&
        menuPosition &&
        createPortal(
          <div
            ref={menuRef}
            id="block-actions-menu"
            className="block-actions-menu"
            style={{ top: `${menuPosition.top}px`, left: `${menuPosition.left}px` }}
            role="menu"
            aria-label="块操作"
            onKeyDown={handleMenuKeyDown}
          >
            <button
              type="button"
              className="block-action-item"
              role="menuitem"
              onClick={() =>
                runMenuAction((block) => {
                  duplicateBlock(editor!, block);
                })
              }
            >
              <Copy size={14} strokeWidth={1.8} aria-hidden="true" />
              <span>复制块</span>
            </button>
            <button
              type="button"
              className="block-action-item"
              role="menuitem"
              disabled={!canMoveUp}
              onClick={() =>
                runMenuAction((block) => {
                  moveBlockStep(editor!, block, "up");
                })
              }
            >
              <ArrowUp size={14} strokeWidth={1.8} aria-hidden="true" />
              <span>向上移动</span>
            </button>
            <button
              type="button"
              className="block-action-item"
              role="menuitem"
              disabled={!canMoveDown}
              onClick={() =>
                runMenuAction((block) => {
                  moveBlockStep(editor!, block, "down");
                })
              }
            >
              <ArrowDown size={14} strokeWidth={1.8} aria-hidden="true" />
              <span>向下移动</span>
            </button>
            <div className="block-action-separator" role="separator" />
            <button
              type="button"
              className="block-action-item is-danger"
              role="menuitem"
              onClick={() =>
                runMenuAction((block) => {
                  deleteBlock(editor!, block);
                })
              }
            >
              <Trash2 size={14} strokeWidth={1.8} aria-hidden="true" />
              <span>删除块</span>
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}
