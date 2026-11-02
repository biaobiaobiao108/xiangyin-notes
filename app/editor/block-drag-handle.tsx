import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { Editor } from "@tiptap/core";
import { GripVertical, Copy, ArrowUp, ArrowDown, Trash2 } from "lucide-react";
import {
  calculateDropTarget,
  deleteBlock,
  duplicateBlock,
  getDraggableBlockAtCoords,
  getDraggableBlockFromElement,
  moveBlock,
  moveBlockStep,
  type BlockTarget,
  type DropTargetInfo,
} from "./block-drag-commands";

type BlockDragHandleProps = {
  editor: Editor | null;
  containerRef: React.RefObject<HTMLDivElement | null>;
  disabled?: boolean;
  onBlockChange?: () => void;
};

type HandlePosition = {
  top: number;
  left: number;
};

type IndicatorPosition = {
  top: number;
  left: number;
  width: number;
};

export function BlockDragHandle({
  editor,
  containerRef,
  disabled = false,
  onBlockChange,
}: BlockDragHandleProps) {
  const [activeBlock, setActiveBlock] = useState<BlockTarget | null>(null);
  const [handlePosition, setHandlePosition] = useState<HandlePosition | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [dropIndicator, setDropIndicator] = useState<IndicatorPosition | null>(null);

  const handleRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const dragSourceBlockRef = useRef<BlockTarget | null>(null);
  const currentDropTargetRef = useRef<DropTargetInfo | null>(null);
  const hideTimeoutRef = useRef<number | null>(null);

  // Compute handle position relative to editor-document container
  const updateHandlePositionForBlock = useCallback(
    (block: BlockTarget) => {
      const container = containerRef.current;
      if (!container || !block.dom) return;
      const containerRect = container.getBoundingClientRect();
      const blockRect = block.dom.getBoundingClientRect();

      // Find first line anchor element
      const firstElement = block.dom.firstElementChild as HTMLElement | null;
      const anchorRect = firstElement ? firstElement.getBoundingClientRect() : blockRect;

      const handleWidth = 20;
      const left = Math.max(0, blockRect.left - containerRect.left - handleWidth - 6);
      // Align with the first line's vertical center
      const lineCenter = anchorRect.top + Math.min(13, anchorRect.height / 2);
      const top = lineCenter - containerRect.top - 11;

      setHandlePosition({ top, left });
      setActiveBlock(block);
    },
    [containerRef],
  );

  // Hover tracking
  useEffect(() => {
    if (disabled || !editor || editor.isDestroyed) {
      setActiveBlock(null);
      setHandlePosition(null);
      setMenuOpen(false);
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (isDragging) return;

      // Don't update hover block while menu is open
      if (menuOpen) return;

      const target = event.target as HTMLElement | null;
      if (target && (handleRef.current?.contains(target) || menuRef.current?.contains(target))) {
        if (hideTimeoutRef.current !== null) {
          window.clearTimeout(hideTimeoutRef.current);
          hideTimeoutRef.current = null;
        }
        return;
      }

      const block = getDraggableBlockAtCoords(editor, {
        x: event.clientX,
        y: event.clientY,
      });

      if (block) {
        if (hideTimeoutRef.current !== null) {
          window.clearTimeout(hideTimeoutRef.current);
          hideTimeoutRef.current = null;
        }
        updateHandlePositionForBlock(block);
      } else {
        // Mouse outside draggable block area: grace period to avoid flickering
        if (!hideTimeoutRef.current) {
          hideTimeoutRef.current = window.setTimeout(() => {
            hideTimeoutRef.current = null;
            setActiveBlock(null);
            setHandlePosition(null);
          }, 240);
        }
      }
    };

    const editorDom = editor.view.dom;
    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      if (hideTimeoutRef.current !== null) {
        window.clearTimeout(hideTimeoutRef.current);
        hideTimeoutRef.current = null;
      }
    };
  }, [disabled, editor, isDragging, menuOpen, updateHandlePositionForBlock]);

  // Drag operations
  const handleDragStart = useCallback(
    (event: ReactDragEvent) => {
      if (!activeBlock || !activeBlock.dom || !editor) return;
      setIsDragging(true);
      setMenuOpen(false);
      dragSourceBlockRef.current = activeBlock;

      activeBlock.dom.classList.add("block-is-dragging");

      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", activeBlock.node.textContent || "");
    },
    [activeBlock, editor],
  );

  const handleDragOver = useCallback(
    (event: DragEvent) => {
      event.preventDefault();
      event.dataTransfer!.dropEffect = "move";

      if (!editor || !containerRef.current) return;
      const targetBlock = getDraggableBlockAtCoords(editor, {
        x: event.clientX,
        y: event.clientY,
      });
      if (!targetBlock || !targetBlock.dom) {
        setDropIndicator(null);
        currentDropTargetRef.current = null;
        return;
      }

      const dropInfo = calculateDropTarget(targetBlock, event.clientY);
      currentDropTargetRef.current = dropInfo;

      const containerRect = containerRef.current.getBoundingClientRect();
      const blockRect = targetBlock.dom.getBoundingClientRect();

      setDropIndicator({
        top: dropInfo.indicatorY - containerRect.top,
        left: blockRect.left - containerRect.left,
        width: blockRect.width,
      });
    },
    [containerRef, editor],
  );

  const handleDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault();
      const source = dragSourceBlockRef.current;
      const dropTarget = currentDropTargetRef.current;

      if (editor && source && dropTarget) {
        const moved = moveBlock(editor, source, dropTarget.block, dropTarget.placement);
        if (moved) {
          onBlockChange?.();
        }
      }

      setIsDragging(false);
      setDropIndicator(null);
      dragSourceBlockRef.current?.dom?.classList.remove("block-is-dragging");
      dragSourceBlockRef.current = null;
      currentDropTargetRef.current = null;
      setActiveBlock(null);
      setHandlePosition(null);
    },
    [editor, onBlockChange],
  );

  const handleDragEnd = useCallback(() => {
    setIsDragging(false);
    setDropIndicator(null);
    dragSourceBlockRef.current?.dom?.classList.remove("block-is-dragging");
    dragSourceBlockRef.current = null;
    currentDropTargetRef.current = null;
    setActiveBlock(null);
    setHandlePosition(null);
  }, []);

  // Setup global drag listeners on editor document
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.addEventListener("dragover", handleDragOver);
    container.addEventListener("drop", handleDrop);
    container.addEventListener("dragend", handleDragEnd);

    return () => {
      container.removeEventListener("dragover", handleDragOver);
      container.removeEventListener("drop", handleDrop);
      container.removeEventListener("dragend", handleDragEnd);
    };
  }, [containerRef, handleDragEnd, handleDragOver, handleDrop]);

  // Close menu on click outside or Escape
  useEffect(() => {
    if (!menuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && !menuRef.current?.contains(target) && !handleRef.current?.contains(target)) {
        setMenuOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMenuOpen(false);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown, { capture: true });
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, { capture: true });
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  // Handle menu actions
  const handleDuplicate = (event: ReactMouseEvent) => {
    event.stopPropagation();
    if (editor && activeBlock) {
      if (duplicateBlock(editor, activeBlock)) {
        onBlockChange?.();
      }
    }
    setMenuOpen(false);
  };

  const handleMoveUp = (event: ReactMouseEvent) => {
    event.stopPropagation();
    if (editor && activeBlock) {
      if (moveBlockStep(editor, activeBlock, "up")) {
        onBlockChange?.();
      }
    }
    setMenuOpen(false);
  };

  const handleMoveDown = (event: ReactMouseEvent) => {
    event.stopPropagation();
    if (editor && activeBlock) {
      if (moveBlockStep(editor, activeBlock, "down")) {
        onBlockChange?.();
      }
    }
    setMenuOpen(false);
  };

  const handleDelete = (event: ReactMouseEvent) => {
    event.stopPropagation();
    if (editor && activeBlock) {
      if (deleteBlock(editor, activeBlock)) {
        onBlockChange?.();
      }
    }
    setMenuOpen(false);
  };

  if (disabled || !handlePosition || !activeBlock) {
    return dropIndicator ? (
      <div
        className="block-drop-indicator"
        style={{
          top: `${dropIndicator.top}px`,
          left: `${dropIndicator.left}px`,
          width: `${dropIndicator.width}px`,
        }}
        aria-hidden="true"
      />
    ) : null;
  }

  return (
    <>
      <div
        ref={handleRef}
        className={`block-drag-handle ${menuOpen ? "is-active" : ""}`}
        style={{
          top: `${handlePosition.top}px`,
          left: `${handlePosition.left}px`,
        }}
        draggable={!menuOpen}
        onDragStart={handleDragStart}
        onClick={(event) => {
          event.stopPropagation();
          setMenuOpen((prev) => !prev);
        }}
        aria-label="拖拽移动或操作当前块"
        role="button"
        tabIndex={-1}
      >
        <GripVertical size={14} strokeWidth={2} />
      </div>

      {menuOpen && (
        <div
          ref={menuRef}
          className="block-actions-menu"
          style={{
            top: `${handlePosition.top + 24}px`,
            left: `${handlePosition.left}px`,
          }}
          role="menu"
          aria-label="块操作"
        >
          <button
            type="button"
            className="block-action-item"
            role="menuitem"
            onClick={handleDuplicate}
          >
            <Copy size={13} strokeWidth={1.8} aria-hidden="true" />
            <span>复制块</span>
          </button>
          <button
            type="button"
            className="block-action-item"
            role="menuitem"
            onClick={handleMoveUp}
          >
            <ArrowUp size={13} strokeWidth={1.8} aria-hidden="true" />
            <span>向上移动</span>
          </button>
          <button
            type="button"
            className="block-action-item"
            role="menuitem"
            onClick={handleMoveDown}
          >
            <ArrowDown size={13} strokeWidth={1.8} aria-hidden="true" />
            <span>向下移动</span>
          </button>
          <div className="block-action-separator" role="separator" />
          <button
            type="button"
            className="block-action-item is-danger"
            role="menuitem"
            onClick={handleDelete}
          >
            <Trash2 size={13} strokeWidth={1.8} aria-hidden="true" />
            <span>删除块</span>
          </button>
        </div>
      )}

      {dropIndicator && (
        <div
          className="block-drop-indicator"
          style={{
            top: `${dropIndicator.top}px`,
            left: `${dropIndicator.left}px`,
            width: `${dropIndicator.width}px`,
          }}
          aria-hidden="true"
        />
      )}
    </>
  );
}
