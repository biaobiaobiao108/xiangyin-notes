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
  deleteBlocks,
  duplicateBlocks,
  getDraggableBlockFromElement,
  getDraggableBlockFromSelection,
  getSelectedBlockRange,
  moveBlocksStep,
  type BlockTarget,
} from "./block-drag-commands";
import {
  blockAtHandleGutter,
  blockHandleCenter,
  HANDLE_FADE_OUT,
  HANDLE_HEIGHT,
  HANDLE_HOVER_LEFT,
  HANDLE_LEFT,
  HIDE_DELAY,
  MENU_ESTIMATED_HEIGHT,
  MENU_WIDTH,
  pointerInHandleGutter,
  prefersReducedMotion,
  restoreEditorFocus,
} from "./block-drag-dom";
import { startBlockDragSession, type DragSession } from "./block-drag-session";

export { createDragPreview } from "./block-drag-dom";

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
    const editorDom = editor.view.dom;

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
    editorDom.addEventListener("blur", handleEditorBlur);
    editorDom.addEventListener("keydown", handleEditorKeyDown);
    editorDom.setAttribute("aria-keyshortcuts", "Shift+F10");
    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    window.addEventListener("resize", refreshHandle);
    container.addEventListener("pointerleave", handlePointerLeave);
    const scrollElement = scrollRef.current;
    scrollElement?.addEventListener("scroll", refreshHandle, { passive: true });

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("resize", refreshHandle);
      editorDom.removeEventListener("blur", handleEditorBlur);
      editorDom.removeEventListener("keydown", handleEditorKeyDown);
      editorDom.removeAttribute("aria-keyshortcuts");
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
    startBlockDragSession({
      editor,
      event: event.nativeEvent,
      source: fresh,
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
    });
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
