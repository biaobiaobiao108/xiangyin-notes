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
  deleteBlocks,
  duplicateBlocks,
  getBlockShift,
  getDraggableBlockFromSelection,
  getDraggableBlockFromElement,
  getSelectedBlockRange,
  getSiblingBlocks,
  moveBlocks,
  moveBlocksStep,
  selectBlockRange,
  toDragSessionY,
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

const HANDLE_LEFT = -30;
const HANDLE_HEIGHT = 28;
const HANDLE_HOVER_LEFT = HANDLE_LEFT - 14;
const HANDLE_HOVER_RIGHT = 36;
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

function restoreEditorFocus(editor: Editor, scroll: HTMLElement | null) {
  if (editor.isDestroyed) return;
  const scrollTop = scroll?.scrollTop;
  try {
    if (!editor.view.hasFocus()) {
      editor.view.focus();
    }
  } catch {
    // Ignore focus errors
  }
  if (scroll && scrollTop !== undefined && scroll.scrollTop !== scrollTop) {
    scroll.scrollTop = scrollTop;
  }
}

function firstLineCenter(element: HTMLElement): number {
  const rect = element.getBoundingClientRect();
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return node.textContent && node.textContent.trim().length > 0
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_SKIP;
    },
  });
  const textNode = walker.nextNode();
  if (textNode) {
    try {
      const range = document.createRange();
      range.setStart(textNode, 0);
      range.setEnd(textNode, Math.min(1, textNode.textContent?.length ?? 1));
      const rangeRect = range.getBoundingClientRect();
      if (rangeRect.height > 0) {
        return rangeRect.top + rangeRect.height / 2;
      }
    } catch {
      // fallback
    }
  }

  const firstMedia = element.querySelector<HTMLElement>("img, input, pre, table, hr");
  if (firstMedia) {
    const mediaRect = firstMedia.getBoundingClientRect();
    if (mediaRect.height > 0) {
      return mediaRect.top + Math.min(14, mediaRect.height / 2);
    }
  }

  const style = getComputedStyle(element);
  const paddingTop = Number.parseFloat(style.paddingTop) || 0;
  const fontSize = Number.parseFloat(style.fontSize) || 16;
  const lineHeightRaw = style.lineHeight;
  const lineHeight =
    lineHeightRaw === "normal"
      ? fontSize * 1.5
      : Number.parseFloat(lineHeightRaw) || fontSize * 1.5;
  return rect.top + paddingTop + lineHeight / 2;
}

function blockHandleCenter(block: BlockTarget, scroll: HTMLElement | null): number {
  if (!block.dom) return 0;
  const center = firstLineCenter(block.dom);
  if (!scroll) return center;
  const scrollRect = scroll.getBoundingClientRect();
  const inset = HANDLE_HEIGHT / 2 + 4;
  return Math.min(
    Math.max(center, scrollRect.top + inset),
    Math.max(scrollRect.top + inset, scrollRect.bottom - inset),
  );
}

function translateY(element: HTMLElement): number {
  const transform = getComputedStyle(element).transform;
  return transform && transform !== "none" ? new DOMMatrixReadOnly(transform).m42 : 0;
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
    if (listRoot.tagName === "LI") {
      return getDraggableBlockFromElement(editor, listRoot, { x: rect.left + 6, y });
    }
    const items = Array.from(listRoot.querySelectorAll<HTMLElement>("li"));
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

export function createDragPreview(sources: BlockTarget[]): HTMLElement | null {
  const firstSource = sources[0];
  const firstDom = firstSource?.dom;
  if (!firstDom) return null;
  const firstRect = firstDom.getBoundingClientRect();

  const preview = document.createElement("div");
  preview.className = "block-drag-preview";
  preview.setAttribute("aria-hidden", "true");
  preview.setAttribute("inert", "");

  const content = document.createElement("div");
  content.className = "note-prose block-drag-preview-content";

  if (firstSource.kind === "listItem" && firstDom.parentElement) {
    const listParent = firstDom.parentElement;
    const listClone = listParent.cloneNode(false) as HTMLElement;
    listClone.style.marginTop = "0";
    listClone.style.marginBottom = "0";
    const listPadding = Number.parseFloat(getComputedStyle(listParent).paddingLeft) || 0;

    let maxVisibleWidth = MIN_LIST_PREVIEW_WIDTH;
    sources.forEach((source, index) => {
      if (!source.dom) return;
      const clone = source.dom.cloneNode(true) as HTMLElement;
      if (index === 0) clone.style.marginTop = "0";
      if (index === sources.length - 1) clone.style.marginBottom = "0";
      clone
        .querySelectorAll<HTMLElement>(
          "[contenteditable], button, input, select, textarea, a[href], [tabindex]",
        )
        .forEach((element) => {
          element.removeAttribute("contenteditable");
          element.setAttribute("tabindex", "-1");
        });
      clone.querySelectorAll<HTMLImageElement>("img").forEach((image) => {
        image.draggable = false;
      });
      if (clone instanceof HTMLLIElement && listParent instanceof HTMLOListElement) {
        const start = Number.parseInt(listParent.getAttribute("start") ?? "1", 10) || 1;
        clone.value = start + source.index;
      }
      listClone.appendChild(clone);

      const sourceRect = source.dom.getBoundingClientRect();
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
      maxVisibleWidth = Math.max(maxVisibleWidth, visibleWidth);
    });

    content.style.width = `${maxVisibleWidth + listPadding}px`;
    content.appendChild(listClone);
    preview.style.width = `${maxVisibleWidth + listPadding + PREVIEW_PADDING_X * 2}px`;
    preview.style.left = `${firstRect.left - listPadding - PREVIEW_PADDING_X}px`;
  } else {
    const sourceWidth = firstRect.width;
    sources.forEach((source, index) => {
      if (!source.dom) return;
      const clone = source.dom.cloneNode(true) as HTMLElement;
      if (index === 0) clone.style.marginTop = "0";
      if (index === sources.length - 1) clone.style.marginBottom = "0";
      clone
        .querySelectorAll<HTMLElement>(
          "[contenteditable], button, input, select, textarea, a[href], [tabindex]",
        )
        .forEach((element) => {
          element.removeAttribute("contenteditable");
          element.setAttribute("tabindex", "-1");
        });
      clone.querySelectorAll<HTMLImageElement>("img").forEach((image) => {
        image.draggable = false;
      });
      content.appendChild(clone);
    });

    content.style.width = `${sourceWidth}px`;
    preview.style.width = `${sourceWidth + PREVIEW_PADDING_X * 2}px`;
    preview.style.left = `${firstRect.left - PREVIEW_PADDING_X}px`;
  }

  if (sources.length > 1) {
    const badge = document.createElement("div");
    badge.className = "block-drag-count-badge";
    badge.textContent = String(sources.length);
    badge.setAttribute("aria-hidden", "true");
    preview.appendChild(badge);
  }

  preview.style.top = `${firstRect.top - PREVIEW_PADDING_Y}px`;
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
  const returnFocusRef = useRef<HTMLElement | null>(null);
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
    returnFocusRef.current = null;
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
      const centerY = blockHandleCenter(block, scrollRef.current);
      activeBlockRef.current = block;
      setActiveBlock(block);
      setHandlePosition({
        top: centerY - containerRect.top - HANDLE_HEIGHT / 2,
        left: HANDLE_LEFT,
      });
    },
    [containerRef, scrollRef],
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

    let pointerFrame: number | null = null;
    let pendingPointer: PointerEvent | null = null;
    const processPointer = () => {
      pointerFrame = null;
      const event = pendingPointer;
      pendingPointer = null;
      if (!event) return;
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
      const inGutter = pointerInHandleGutter(
        container,
        scrollRef.current,
        event.clientX,
        event.clientY,
      );
      if (!inGutter) {
        const activeDom = activeBlockRef.current?.dom;
        if (activeDom && handleVisibleRef.current) {
          const blockRect = activeDom.getBoundingClientRect();
          const containerLeft = container.getBoundingClientRect().left;
          if (
            event.clientX >= containerLeft + HANDLE_HOVER_LEFT &&
            event.clientX <= containerLeft + 64 &&
            event.clientY >= blockRect.top - 6 &&
            event.clientY <= blockRect.bottom + 6
          ) {
            clearHideTimeout();
            return;
          }
        }
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
    const handlePointerMove = (event: PointerEvent) => {
      pendingPointer = event;
      if (pointerFrame === null) pointerFrame = window.requestAnimationFrame(processPointer);
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
      if (isDraggingRef.current) return;
      if (!current?.dom?.isConnected) {
        clearActiveBlock();
        return;
      }
      const fresh = getDraggableBlockFromElement(editor, current.dom);
      if (fresh) updateHandlePosition(fresh);
      else clearActiveBlock();
    };

    const openMenuFromSelection = () => {
      const block = getDraggableBlockFromSelection(editor);
      if (!block) return false;
      const active = document.activeElement;
      returnFocusRef.current =
        active instanceof HTMLElement && active !== document.body ? active : null;
      updateHandlePosition(block);
      window.requestAnimationFrame(() =>
        window.requestAnimationFrame(() => {
          handleRef.current?.focus();
          openMenu();
        }),
      );
      return true;
    };

    const handleEditorKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || !editor.view.hasFocus()) return;
      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
      if (!openMenuFromSelection()) return;
      event.preventDefault();
      event.stopPropagation();
    };

    const handleEditorBlur = (event: FocusEvent) => {
      const next = event.relatedTarget;
      if (
        next instanceof Node &&
        (handleRef.current?.contains(next) || menuRef.current?.contains(next))
      )
        return;
      scheduleHide();
    };

    const resizeObserver = new ResizeObserver(refreshHandle);
    resizeObserver.observe(container);
    editor.view.dom.addEventListener("blur", handleEditorBlur);
    editor.view.dom.addEventListener("keydown", handleEditorKeyDown);
    editor.view.dom.setAttribute("aria-keyshortcuts", "Shift+F10");
    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    window.addEventListener("resize", refreshHandle);
    container.addEventListener("pointerleave", handlePointerLeave);
    const scrollElement = scrollRef.current;
    scrollElement?.addEventListener("scroll", refreshHandle, { passive: true });

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("resize", refreshHandle);
      editor.view.dom.removeEventListener("blur", handleEditorBlur);
      editor.view.dom.removeEventListener("keydown", handleEditorKeyDown);
      editor.view.dom.removeAttribute("aria-keyshortcuts");
      container.removeEventListener("pointerleave", handlePointerLeave);
      scrollElement?.removeEventListener("scroll", refreshHandle);
      resizeObserver.disconnect();
      if (pointerFrame !== null) cancelAnimationFrame(pointerFrame);
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
    openMenu,
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
    if (!Number.isFinite(sourceSpan) || sourceSpan <= 0)
      sourceSpan = lastRect.bottom - firstRect.top;

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
          await animateBack();
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
    const active = document.activeElement;
    returnFocusRef.current =
      active instanceof HTMLElement && active !== document.body && active !== event.currentTarget
        ? active
        : null;
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

  const runMenuAction = (action: (blocks: BlockTarget[]) => void) => {
    if (!editor || !activeBlockRef.current?.dom) return;
    try {
      const current = getDraggableBlockFromElement(editor, activeBlockRef.current.dom);
      if (current) {
        const blocks = getSelectedBlockRange(editor, current);
        action(blocks);
      }
    } finally {
      closeMenu(false);
      clearActiveBlock();
      if (!editor.isDestroyed) restoreEditorFocus(editor, scrollRef.current);
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
      event.preventDefault();
      closeMenu(true);
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

  const activeSelectedBlocks =
    editor && activeBlock
      ? getSelectedBlockRange(editor, activeBlock)
      : activeBlock
        ? [activeBlock]
        : [];
  const selectedCount = activeSelectedBlocks.length;
  const firstActive = activeSelectedBlocks[0];
  const lastActive = activeSelectedBlocks[activeSelectedBlocks.length - 1];
  const canMoveUp = Boolean(firstActive && firstActive.index > 0);
  const canMoveDown = Boolean(lastActive && lastActive.index < lastActive.parent.childCount - 1);

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
                runMenuAction((blocks) => {
                  duplicateBlocks(editor!, blocks);
                })
              }
            >
              <Copy size={14} strokeWidth={1.8} aria-hidden="true" />
              <span>{selectedCount > 1 ? `复制 ${selectedCount} 个块` : "复制块"}</span>
            </button>
            <button
              type="button"
              className="block-action-item"
              role="menuitem"
              disabled={!canMoveUp}
              onClick={() =>
                runMenuAction((blocks) => {
                  moveBlocksStep(editor!, blocks, "up");
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
                runMenuAction((blocks) => {
                  moveBlocksStep(editor!, blocks, "down");
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
                runMenuAction((blocks) => {
                  deleteBlocks(editor!, blocks);
                })
              }
            >
              <Trash2 size={14} strokeWidth={1.8} aria-hidden="true" />
              <span>{selectedCount > 1 ? `删除 ${selectedCount} 个块` : "删除块"}</span>
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}
