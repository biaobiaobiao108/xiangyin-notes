import type { MutableRefObject, RefObject } from "react";
import type { Editor } from "@tiptap/core";
import {
  calculateDropCandidate,
  getBlockShift,
  getDraggableBlockFromSelection,
  getSelectedBlockRange,
  getSiblingBlocks,
  moveBlocks,
  selectBlockRange,
  toDragSessionY,
  type BlockSlot,
  type BlockTarget,
  type DropCandidate,
} from "./block-drag-commands";
import {
  animatePreview,
  createDragPreview,
  DRAG_THRESHOLD,
  prefersReducedMotion,
  restoreEditorFocus,
  SCROLL_EDGE,
  SCROLL_MAX_STEP,
  translateY,
} from "./block-drag-dom";

export type DragSession = {
  pointerId: number;
  startX: number;
  startY: number;
  pointerX: number;
  pointerY: number;
  returnFocus: HTMLElement | null;
  blocks: BlockTarget[];
  siblings: BlockTarget[];
  sourceStart: number;
  sourceEnd: number;
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
  sourceAnimations: Animation[];
  shiftAnimations: Map<HTMLElement, { animation: Animation; shift: number }>;
};

export type StartBlockDragSessionOptions = {
  editor: Editor;
  event: PointerEvent;
  source: BlockTarget;
  containerRef: RefObject<HTMLDivElement | null>;
  scrollRef: RefObject<HTMLDivElement | null>;
  dragSessionRef: MutableRefObject<DragSession | null>;
  cancelDragRef: MutableRefObject<(() => void) | null>;
  returnFocusRef: MutableRefObject<HTMLElement | null>;
  isDraggingRef: MutableRefObject<boolean>;
  activeBlockRef: MutableRefObject<BlockTarget | null>;
  handleVisibleRef: MutableRefObject<boolean>;
  handleWasShownRef: MutableRefObject<boolean>;
  setIsDragging: (dragging: boolean) => void;
  setActiveBlock: (block: BlockTarget | null) => void;
  setHandlePosition: (position: { top: number; left: number } | null) => void;
  setHandleVisible: (visible: boolean) => void;
  clearHideTimeout: () => void;
  closeMenu: (returnFocus: boolean) => void;
  openMenu: () => void;
};

export function startBlockDragSession({
  editor,
  event,
  source,
  containerRef,
  scrollRef,
  dragSessionRef,
  cancelDragRef,
  returnFocusRef,
  isDraggingRef,
  activeBlockRef,
  handleVisibleRef,
  handleWasShownRef,
  setIsDragging,
  setActiveBlock,
  setHandlePosition,
  setHandleVisible,
  clearHideTimeout,
  closeMenu,
  openMenu,
}: StartBlockDragSessionOptions) {
  if (editor.isDestroyed) return;
  const siblings = getSiblingBlocks(editor, source);
  const selectedBlocks = getSelectedBlockRange(editor, source);
  const sourceStart = siblings.findIndex((block) => block.pos === selectedBlocks[0].pos);
  const sourceEnd = siblings.findIndex(
    (block) => block.pos === selectedBlocks[selectedBlocks.length - 1].pos,
  );
  if (sourceStart < 0 || sourceEnd < 0) return;

  const slots: BlockSlot[] = [];
  for (const block of siblings) {
    if (!block.dom) return;
    const rect = block.dom.getBoundingClientRect();
    slots.push({ block, top: rect.top, bottom: rect.bottom });
  }

  const firstDom = selectedBlocks[0].dom;
  const lastDom = selectedBlocks[selectedBlocks.length - 1].dom;
  const scrollElement = scrollRef.current;
  if (!firstDom || !lastDom || !scrollElement) return;

  const firstRect = firstDom.getBoundingClientRect();
  const lastRect = lastDom.getBoundingClientRect();
  const nextSibling = lastDom.nextElementSibling;
  let sourceSpan =
    nextSibling instanceof HTMLElement
      ? nextSibling.getBoundingClientRect().top - firstRect.top
      : lastRect.bottom -
        firstRect.top +
        (Number.parseFloat(getComputedStyle(lastDom).marginBottom) || 0);
  if (!Number.isFinite(sourceSpan) || sourceSpan <= 0) sourceSpan = lastRect.bottom - firstRect.top;

  const session: DragSession = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    pointerX: event.clientX,
    pointerY: event.clientY,
    returnFocus: returnFocusRef.current,
    blocks: selectedBlocks,
    siblings,
    sourceStart,
    sourceEnd,
    sourceSpan,
    sourceTop: firstRect.top,
    initialScroll: scrollElement.scrollTop,
    initialDoc: editor.state.doc,
    slots,
    preview: null,
    frame: null,
    active: false,
    dropping: false,
    cancelled: false,
    candidate: null,
    sourceAnimations: [],
    shiftAnimations: new Map(),
  };
  dragSessionRef.current = session;

  const scrollDelta = () =>
    (scrollRef.current?.scrollTop ?? session.initialScroll) - session.initialScroll;
  const refreshGeometry = () => {
    const delta = scrollDelta();
    session.siblings.forEach((block, index) => {
      if (!block.dom) return;
      const rect = block.dom.getBoundingClientRect();
      const offset = translateY(block.dom);
      session.slots[index] = {
        block,
        top: toDragSessionY(rect.top, delta, offset),
        bottom: toDragSessionY(rect.bottom, delta, offset),
      };
    });

    const firstBlockDom = session.blocks[0]?.dom;
    const lastBlockDom = session.blocks[session.blocks.length - 1]?.dom;
    if (firstBlockDom && lastBlockDom) {
      const firstTop = toDragSessionY(
        firstBlockDom.getBoundingClientRect().top,
        delta,
        translateY(firstBlockDom),
      );
      const next = lastBlockDom.nextElementSibling;
      if (next instanceof HTMLElement) {
        const nextTop = toDragSessionY(next.getBoundingClientRect().top, delta, translateY(next));
        if (nextTop > firstTop) session.sourceSpan = nextTop - firstTop;
      } else {
        const lastBottom = toDragSessionY(
          lastBlockDom.getBoundingClientRect().bottom,
          delta,
          translateY(lastBlockDom),
        );
        if (lastBottom > firstTop) session.sourceSpan = lastBottom - firstTop;
      }
    }
  };
  let geometryDirty = false;
  const resizeObserver = new ResizeObserver(() => {
    geometryDirty = true;
  });
  for (const block of siblings) if (block.dom) resizeObserver.observe(block.dom);
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
    if (geometryDirty) {
      refreshGeometry();
      geometryDirty = false;
    }
    const candidate = inside
      ? calculateDropCandidate(
          session.slots,
          { start: session.sourceStart, end: session.sourceEnd },
          session.pointerY + delta,
          session.candidate,
          session.sourceSpan,
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
      if ((index >= session.sourceStart && index <= session.sourceEnd) || !slot.block.dom) return;
      if (
        scrollRect &&
        (slot.bottom - delta < scrollRect.top - 80 || slot.top - delta > scrollRect.bottom + 80)
      )
        return;
      const shift =
        candidate && !candidate.noop
          ? getBlockShift(
              index,
              { start: session.sourceStart, end: session.sourceEnd },
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
    session.sourceAnimations.forEach((animation) => animation.cancel());
    session.sourceAnimations = [];
    document.body.classList.remove("is-sorting-blocks");
  };

  const removeListeners = () => {
    window.removeEventListener("pointermove", movePointer);
    window.removeEventListener("pointerup", finishPointer);
    window.removeEventListener("pointercancel", cancelPointer);
    window.removeEventListener("lostpointercapture", cancelPointer, true);
    window.removeEventListener("blur", blurWindow);
    window.removeEventListener("resize", resizeWindow);
    window.removeEventListener("keydown", escapeDrag, true);
    editor.off("transaction", handleTransaction);
    resizeObserver.disconnect();
  };

  const dispose = () => {
    cleanupVisuals();
    removeListeners();
    if (dragSessionRef.current === session) {
      dragSessionRef.current = null;
      cancelDragRef.current = null;
    }
    returnFocusRef.current = null;
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
    const firstDom = session.blocks[0]?.dom;
    const currentSourceTop =
      firstDom?.getBoundingClientRect().top ?? session.sourceTop - scrollDelta();
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
    session.sourceAnimations.forEach((animation) => animation.cancel());
    session.sourceAnimations = [];
    if (prefersReducedMotion()) return Promise.resolve();
    const animations: Promise<unknown>[] = [];
    for (const block of session.blocks) {
      if (!block.dom) continue;
      const animation = block.dom.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: 140,
        easing: "cubic-bezier(0.16, 1, 0.3, 1)",
        fill: "forwards",
      });
      session.sourceAnimations.push(animation);
      animations.push(animation.finished.catch(() => undefined));
    }
    return Promise.all(animations);
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

  const escapeDrag = (keydownEvent: KeyboardEvent) => {
    if (keydownEvent.isComposing || keydownEvent.keyCode === 229 || keydownEvent.key !== "Escape")
      return;
    keydownEvent.preventDefault();
    keydownEvent.stopImmediatePropagation();
    void cancel(true);
  };

  const handleTransaction = ({ transaction }: { transaction: { docChanged: boolean } }) => {
    if (session.dropping || !transaction.docChanged) return;
    void cancel(false);
  };

  const beginDrag = () => {
    const created = createDragPreview(session.blocks);
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
    session.sourceAnimations = [];
    for (const block of session.blocks) {
      if (!block.dom) continue;
      const animation = block.dom.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: prefersReducedMotion() ? 0 : 160,
        easing: "cubic-bezier(0.16, 1, 0.3, 1)",
        fill: "forwards",
      });
      session.sourceAnimations.push(animation);
    }
    document.body.classList.add("is-sorting-blocks");
    editor.on("transaction", handleTransaction);
    tick(performance.now());
  };

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
        await animateBackToSource();
        return;
      }

      const preview = session.preview;
      if (!preview) {
        await animateBackToSource();
        return;
      }

      const previewOffset = session.pointerY - session.startY;
      const siblingShifts = new Map<HTMLElement, { currentShift: number; targetShift: number }>();
      session.slots.forEach(({ block }, index) => {
        if (!block.dom) return;
        const targetShift =
          candidate && !candidate.noop
            ? getBlockShift(
                index,
                { start: session.sourceStart, end: session.sourceEnd },
                candidate.destinationIndex,
                session.sourceSpan,
              )
            : 0;
        const currentShift = translateY(block.dom);
        siblingShifts.set(block.dom, { currentShift, targetShift });
      });

      const movedPosition = moveBlocks(
        editor,
        session.blocks,
        candidate.target,
        candidate.placement,
      );
      if (movedPosition === null) {
        await animateBackToSource();
        return;
      }
      moved = true;

      let curPos = movedPosition;
      const movedDoms: HTMLElement[] = [];
      for (const block of session.blocks) {
        const dom = editor.view.nodeDOM(curPos);
        if (dom instanceof HTMLElement) {
          movedDoms.push(dom);
        }
        curPos += block.node.nodeSize;
      }
      if (!movedDoms.length) return;

      session.shiftAnimations.forEach(({ animation }) => animation.cancel());
      session.shiftAnimations.clear();
      session.sourceAnimations.forEach((animation) => animation.cancel());
      session.sourceAnimations = [];
      document.body.classList.remove("is-sorting-blocks");
      session.sourceAnimations = movedDoms.map((dom) =>
        dom.animate([{ opacity: 0 }, { opacity: 0 }], {
          duration: 1,
          fill: "forwards",
        }),
      );

      // Measure the committed layout so the preview lands exactly where the block will live.
      const finalTop = movedDoms[0].getBoundingClientRect().top;
      const reducedMotion = prefersReducedMotion();
      if (!reducedMotion) {
        const movedDomSet = new Set(movedDoms);
        siblingShifts.forEach(({ currentShift, targetShift }, element) => {
          if (!element.isConnected || movedDomSet.has(element)) return;
          const offset = currentShift - targetShift;
          // Blocks already at their destination do not animate to avoid text jitter
          if (Math.abs(offset) < 2) return;
          const duration = Math.min(160, Math.max(70, Math.abs(offset) * 2.2));
          element.animate(
            [{ transform: `translateY(${offset}px)` }, { transform: "translateY(0)" }],
            { duration, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
          );
        });
      }

      await animatePreview(preview, previewOffset, finalTop - session.sourceTop, 160);
      if (session.cancelled) return;

      if (!reducedMotion) {
        session.sourceAnimations.forEach((animation) => animation.cancel());
        session.sourceAnimations = [];
        const fadeOut = preview.animate([{ opacity: 0.98 }, { opacity: 0 }], {
          duration: 80,
          easing: "cubic-bezier(0.16, 1, 0.3, 1)",
          fill: "forwards",
        });
        const fadeInAnims = movedDoms.map((dom) =>
          dom.animate([{ opacity: 0 }, { opacity: 1 }], {
            duration: 80,
            easing: "cubic-bezier(0.16, 1, 0.3, 1)",
            fill: "forwards",
          }),
        );
        session.sourceAnimations = fadeInAnims;
        await Promise.all([
          fadeOut.finished.catch(() => undefined),
          ...fadeInAnims.map((animation) => animation.finished.catch(() => undefined)),
        ]);
        if (session.cancelled) return;
        fadeOut.cancel();
        fadeInAnims.forEach((animation) => animation.cancel());
        session.sourceAnimations = [];
      }

      if (!reducedMotion) {
        for (const dom of movedDoms) {
          dom.animate(
            [
              { backgroundColor: "var(--accent-soft)", borderRadius: "var(--radius-sm)" },
              { backgroundColor: "transparent", borderRadius: "var(--radius-sm)" },
            ],
            { duration: 260, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
          );
        }
      }
    } finally {
      dispose();
      if (moved) restoreEditorFocus(editor, scrollRef.current);
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
      if (moved < DRAG_THRESHOLD) {
        if (upEvent.shiftKey) {
          const currentSelectionBlock = getDraggableBlockFromSelection(editor);
          if (currentSelectionBlock && currentSelectionBlock.pos !== session.blocks[0].pos) {
            if (selectBlockRange(editor, currentSelectionBlock, session.blocks[0])) {
              return;
            }
          }
        }
        openMenu();
      }
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
  window.addEventListener("lostpointercapture", cancelPointer, true);
  window.addEventListener("blur", blurWindow);
  window.addEventListener("resize", resizeWindow);
  window.addEventListener("keydown", escapeDrag, true);
}
