import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { GripHorizontal, GripVertical, Minus, MoreHorizontal, Plus, Trash2 } from "lucide-react";
import type { Editor } from "@tiptap/core";
import { adjustActiveTableSize, getActiveTableContext, getActiveTableSnapshot, getTableEdgeDragDelta, restoreActiveTableSnapshot, type TableEdgeAxis, type TableEdgeSnapshot } from "./table-edge-commands";

type TableControlsPosition = {
  columns: { top: number; left: number; height: number };
  rows: { top: number; left: number; width: number };
  menu: { top: number; left: number };
  rowCount: number;
  columnCount: number;
};

type DragSession = {
  pointerId: number;
  startX: number;
  startY: number;
  distance: number;
  delta: number;
  initialSize: number;
  step: number;
  snapshot: TableEdgeSnapshot;
  startPosition: { top: number; left: number; width?: number; height?: number };
};

function getSelectedTableShell(editor: Editor): HTMLElement | null {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name !== "table") continue;
    const nodeDom = editor.view.nodeDOM($from.before(depth));
    if (!(nodeDom instanceof HTMLElement)) return null;
    return nodeDom.closest<HTMLElement>(".table-scroll-shell, .tableWrapper")
      ?? nodeDom.querySelector<HTMLElement>(".table-scroll-shell, .tableWrapper")
      ?? (nodeDom.matches("table") ? nodeDom : null);
  }
  return null;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(value, maximum));
}

function getTableEdgeDragStep(editor: Editor, axis: TableEdgeAxis, fallbackSize: number) {
  const table = getSelectedTableShell(editor)?.querySelector("table");
  if (!table) return 28;

  if (axis === "columns") {
    const cells = Array.from(table.querySelector("tr")?.children ?? []);
    const widths = cells.map((cell) => cell.getBoundingClientRect().width).filter((width) => width > 0);
    const measuredWidth = widths.length ? widths.reduce((total, width) => total + width, 0) / widths.length : table.getBoundingClientRect().width / Math.max(1, fallbackSize);
    return Math.max(20, measuredWidth);
  }

  const rows = Array.from(table.querySelectorAll("tr"));
  const heights = rows.map((row) => row.getBoundingClientRect().height).filter((height) => height > 0);
  const measuredHeight = heights.length ? heights.reduce((total, height) => total + height, 0) / heights.length : table.getBoundingClientRect().height / Math.max(1, fallbackSize);
  return Math.max(20, measuredHeight);
}

function TableEdgeRail({ editor, axis, size, position, disabled, visible, onAdjust }: {
  editor: Editor;
  axis: TableEdgeAxis;
  size: number;
  position: { top: number; left: number; width?: number; height?: number };
  disabled: boolean;
  visible: boolean;
  onAdjust: (delta: number) => boolean;
}) {
  const dragRef = useRef<DragSession | null>(null);
  const suppressClickRef = useRef(false);
  const removeWindowListenersRef = useRef<(() => void) | null>(null);
  const onAdjustRef = useRef(onAdjust);
  onAdjustRef.current = onAdjust;
  const [previewDelta, setPreviewDelta] = useState(0);
  const [dragDistance, setDragDistance] = useState(0);
  const isColumnRail = axis === "columns";
  const noun = isColumnRail ? "列" : "行";
  const inward = isColumnRail ? "向左" : "向上";
  const outward = isColumnRail ? "向右" : "向下";

  const clearDrag = (pointerId?: number) => {
    const drag = dragRef.current;
    if (!drag || (pointerId !== undefined && drag.pointerId !== pointerId)) return null;
    dragRef.current = null;
    removeWindowListenersRef.current?.();
    removeWindowListenersRef.current = null;
    return drag;
  };

  const cancelDrag = (pointerId?: number) => {
    const drag = clearDrag(pointerId);
    if (!drag) return;
    restoreActiveTableSnapshot(editor, drag.snapshot, { addToHistory: false, emitUpdate: false, closeHistory: true });
    suppressClickRef.current = false;
    setDragDistance(0);
    setPreviewDelta(0);
  };

  const finishDrag = (event: { pointerId: number; clientX: number; clientY: number; preventDefault: () => void }) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const distance = isColumnRail ? event.clientX - drag.startX : event.clientY - drag.startY;
    const delta = getTableEdgeDragDelta(distance, drag.initialSize, drag.step);
    clearDrag(event.pointerId);

    if (Math.abs(distance) >= 6) {
      event.preventDefault();
      suppressClickRef.current = true;
      restoreActiveTableSnapshot(editor, drag.snapshot, { addToHistory: false, emitUpdate: false, closeHistory: true });
      if (delta) onAdjustRef.current(delta);
    } else {
      suppressClickRef.current = false;
    }
    setDragDistance(0);
    setPreviewDelta(0);
  };

  const moveDrag = (event: { pointerId: number; clientX: number; clientY: number }) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const distance = isColumnRail ? event.clientX - drag.startX : event.clientY - drag.startY;
    const delta = getTableEdgeDragDelta(distance, drag.initialSize, drag.step);
    drag.distance = distance;
    setDragDistance(distance);
    if (drag.delta !== delta) {
      restoreActiveTableSnapshot(editor, drag.snapshot, { addToHistory: false, emitUpdate: false });
      if (delta) adjustActiveTableSize(editor, axis, delta, { addToHistory: false, emitUpdate: false });
      drag.delta = delta;
      setPreviewDelta(delta);
    }
  };

  useEffect(() => () => {
    removeWindowListenersRef.current?.();
    removeWindowListenersRef.current = null;
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag && !editor.isDestroyed) {
      restoreActiveTableSnapshot(editor, drag.snapshot, { addToHistory: false, emitUpdate: false, closeHistory: true });
    }
  }, [editor]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (disabled || !event.isPrimary || event.button !== 0) return;
    suppressClickRef.current = false;
    const snapshot = getActiveTableSnapshot(editor);
    if (!snapshot) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      distance: 0,
      delta: 0,
      initialSize: size,
      step: getTableEdgeDragStep(editor, axis, size),
      snapshot,
      startPosition: { ...position },
    };
    const handleWindowPointerMove = (pointerEvent: PointerEvent) => moveDrag(pointerEvent);
    const handleWindowPointerUp = (pointerEvent: PointerEvent) => finishDrag(pointerEvent);
    const handleWindowPointerCancel = (pointerEvent: PointerEvent) => cancelDrag(pointerEvent.pointerId);
    const handleWindowBlur = () => cancelDrag();
    window.addEventListener("pointermove", handleWindowPointerMove, true);
    window.addEventListener("pointerup", handleWindowPointerUp, true);
    window.addEventListener("pointercancel", handleWindowPointerCancel, true);
    window.addEventListener("blur", handleWindowBlur);
    removeWindowListenersRef.current = () => {
      window.removeEventListener("pointermove", handleWindowPointerMove, true);
      window.removeEventListener("pointerup", handleWindowPointerUp, true);
      window.removeEventListener("pointercancel", handleWindowPointerCancel, true);
      window.removeEventListener("blur", handleWindowBlur);
    };
    setDragDistance(0);
  };

  const handleDragHandleClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (suppressClickRef.current && event.detail > 0) {
      suppressClickRef.current = false;
      event.preventDefault();
      return;
    }
    onAdjustRef.current(1);
  };

  const activeDrag = dragRef.current;
  const railPosition = activeDrag
    ? {
      top: activeDrag.startPosition.top + (isColumnRail ? 0 : dragDistance),
      left: activeDrag.startPosition.left + (isColumnRail ? dragDistance : 0),
      width: activeDrag.startPosition.width,
      height: activeDrag.startPosition.height,
    }
    : position;

  return <div
    className={`table-edge-rail table-edge-rail--${axis}${visible || activeDrag ? " is-visible" : ""}`}
    style={{ top: railPosition.top, left: railPosition.left, width: railPosition.width, height: railPosition.height }}
    role="group"
    aria-label={`调整表格${noun}数`}
  >
    <button
      className="table-edge-step table-edge-step--remove"
      type="button"
      aria-label={`删除最${isColumnRail ? "右侧一" : "下方一"}${noun}`}
      title={`删除最${isColumnRail ? "右侧一" : "下方一"}${noun}`}
      disabled={disabled || size <= 1}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onAdjust(-1)}
    ><Minus size={14} aria-hidden="true" /></button>
    <button
      className="table-edge-drag-handle"
      type="button"
      aria-label={`点击增加一${noun}，或${inward}拖动删除、${outward}拖动增加${noun}`}
      title={`点击增加一${noun}；${inward}删除，${outward}增加`}
      disabled={disabled}
      onPointerDown={handlePointerDown}
      onPointerUp={finishDrag}
      onPointerCancel={(event) => cancelDrag(event.pointerId)}
      onLostPointerCapture={(event) => cancelDrag(event.pointerId)}
      onClick={handleDragHandleClick}
    >{isColumnRail ? <GripVertical size={15} aria-hidden="true" /> : <GripHorizontal size={15} aria-hidden="true" />}</button>
    <button
      className="table-edge-step table-edge-step--add"
      type="button"
      aria-label={`在最${isColumnRail ? "右侧" : "下方"}增加一${noun}`}
      title={`在最${isColumnRail ? "右侧" : "下方"}增加一${noun}`}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onAdjust(1)}
    ><Plus size={14} aria-hidden="true" /></button>
    {previewDelta !== 0 && <output className="table-edge-preview" aria-live="polite">
      {previewDelta > 0 ? `+${previewDelta}` : previewDelta} {noun}
    </output>}
  </div>;
}

export function TableEdgeControls({ editor, deferredLoading }: { editor: Editor; deferredLoading: boolean }) {
  const [position, setPosition] = useState<TableControlsPosition | null>(null);
  const [visibleRails, setVisibleRails] = useState({ columns: false, rows: false });
  const menuRef = useRef<HTMLDetailsElement>(null);
  const pointerPositionRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    let frame: number | null = null;
    let observedShell: HTMLElement | null = null;
    let resizeObserver: ResizeObserver | null = null;

    const updatePosition = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        if (editor.isDestroyed || !editor.isEditable) {
          setPosition(null);
          setVisibleRails((current) => current.columns || current.rows ? { columns: false, rows: false } : current);
          return;
        }

        const shell = getSelectedTableShell(editor);
        if (shell !== observedShell) {
          resizeObserver?.disconnect();
          observedShell = shell;
          if (shell) resizeObserver?.observe(shell);
        }
        const context = getActiveTableContext(editor);
        if (!shell || !context) {
          setPosition(null);
          setVisibleRails((current) => current.columns || current.rows ? { columns: false, rows: false } : current);
          return;
        }

        const shellRect = shell.getBoundingClientRect();
        const tableRect = shell.querySelector("table")?.getBoundingClientRect() ?? shellRect;
        if (shellRect.bottom < 0 || shellRect.top > window.innerHeight || shellRect.right < 0 || shellRect.left > window.innerWidth) {
          setPosition(null);
          setVisibleRails((current) => current.columns || current.rows ? { columns: false, rows: false } : current);
          return;
        }

        const padding = 10;
        const columnRailHeight = clamp(tableRect.height, 72, 280);
        const columnTop = clamp(tableRect.top + (tableRect.height - columnRailHeight) / 2, padding, window.innerHeight - columnRailHeight - padding);
        const visibleTableLeft = Math.max(shellRect.left, tableRect.left);
        const visibleTableRight = Math.min(shellRect.right, tableRect.right);
        const visibleTableWidth = Math.max(96, visibleTableRight - visibleTableLeft);
        const columnLeft = clamp(visibleTableRight + 5, padding, window.innerWidth - 34 - padding);
        const rowRailWidth = clamp(Math.min(visibleTableWidth - 12, window.innerWidth - padding * 2), 96, window.innerWidth - padding * 2);
        const rowLeft = clamp(visibleTableLeft + (visibleTableWidth - rowRailWidth) / 2, padding, window.innerWidth - rowRailWidth - padding);
        const rowTop = clamp(tableRect.bottom + 4, padding, window.innerHeight - 36 - padding);
        const menuLeft = clamp(visibleTableRight - 30, padding, window.innerWidth - 36 - padding);
        const menuTop = clamp(shellRect.top - 38, padding, window.innerHeight - 36 - padding);
        const next: TableControlsPosition = {
          columns: { top: columnTop, left: columnLeft, height: columnRailHeight },
          rows: { top: rowTop, left: rowLeft, width: rowRailWidth },
          menu: { top: menuTop, left: menuLeft },
          rowCount: context.rows,
          columnCount: context.columns,
        };
        const pointer = pointerPositionRef.current;
        if (!pointer) {
          setVisibleRails((current) => current.columns || current.rows ? { columns: false, rows: false } : current);
        } else {
          const inBand = (left: number, top: number, width: number, height: number, padding = 8) =>
            pointer.x >= left - padding && pointer.x <= left + width + padding &&
            pointer.y >= top - padding && pointer.y <= top + height + padding;
          const visibleTableTop = Math.max(shellRect.top, tableRect.top);
          const visibleTableBottom = Math.min(shellRect.bottom, tableRect.bottom);
          const inColumnEdgeBand = pointer.x >= visibleTableRight - 10 && pointer.x <= next.columns.left + 38 &&
            pointer.y >= visibleTableTop - 8 && pointer.y <= visibleTableBottom + 8;
          const inRowEdgeBand = pointer.x >= visibleTableLeft - 8 && pointer.x <= visibleTableRight + 8 &&
            pointer.y >= tableRect.bottom - 10 && pointer.y <= next.rows.top + 38;
          const inColumnRail = inBand(next.columns.left, next.columns.top, 30, next.columns.height);
          const inRowRail = inBand(next.rows.left, next.rows.top, next.rows.width, 30);
          setVisibleRails((current) => {
            const columns = inColumnEdgeBand || inColumnRail;
            const rows = inRowEdgeBand || inRowRail;
            return current.columns === columns && current.rows === rows ? current : { columns, rows };
          });
        }
        setPosition((current) => current &&
          Math.abs(current.columns.top - next.columns.top) < 1 &&
          Math.abs(current.columns.left - next.columns.left) < 1 &&
          Math.abs(current.columns.height - next.columns.height) < 1 &&
          Math.abs(current.rows.top - next.rows.top) < 1 &&
          Math.abs(current.rows.left - next.rows.left) < 1 &&
          Math.abs(current.rows.width - next.rows.width) < 1 &&
          Math.abs(current.menu.top - next.menu.top) < 1 &&
          Math.abs(current.menu.left - next.menu.left) < 1 &&
          current.rowCount === next.rowCount &&
          current.columnCount === next.columnCount
          ? current
          : next);
      });
    };

    resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updatePosition);

    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" && event.pointerType !== "pen") return;
      pointerPositionRef.current = { x: event.clientX, y: event.clientY };
      updatePosition();
    };
    const handlePointerOut = (event: PointerEvent) => {
      if (event.relatedTarget !== null) return;
      pointerPositionRef.current = null;
      updatePosition();
    };

    editor.on("selectionUpdate", updatePosition);
    editor.on("transaction", updatePosition);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    window.addEventListener("pointerout", handlePointerOut);
    updatePosition();
    return () => {
      editor.off("selectionUpdate", updatePosition);
      editor.off("transaction", updatePosition);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerout", handlePointerOut);
      resizeObserver?.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [editor]);

  useEffect(() => {
    const handleOutsidePointer = (event: PointerEvent) => {
      const menu = menuRef.current;
      if (!menu?.open) return;
      if (!menu.contains(event.target as Node)) menu.open = false;
    };
    const handleEscape = (event: KeyboardEvent) => {
      const menu = menuRef.current;
      if (!menu?.open) return;
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229) return;
      menu.open = false;
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener("pointerdown", handleOutsidePointer, true);
    document.addEventListener("keydown", handleEscape, true);
    return () => {
      document.removeEventListener("pointerdown", handleOutsidePointer, true);
      document.removeEventListener("keydown", handleEscape, true);
    };
  }, []);

  if (typeof document === "undefined" || !position) return null;
  return createPortal(<div className="table-edge-controls-overlay" aria-label="表格边缘操作">
    <TableEdgeRail
      editor={editor}
      axis="columns"
      size={position.columnCount}
      position={position.columns}
      disabled={deferredLoading}
      visible={visibleRails.columns}
      onAdjust={(delta) => adjustActiveTableSize(editor, "columns", delta)}
    />
    <TableEdgeRail
      editor={editor}
      axis="rows"
      size={position.rowCount}
      position={position.rows}
      disabled={deferredLoading}
      visible={visibleRails.rows}
      onAdjust={(delta) => adjustActiveTableSize(editor, "rows", delta)}
    />
    <details className="table-edge-menu" ref={menuRef} style={{ top: position.menu.top, left: position.menu.left }}>
      <summary aria-label="更多表格操作" title="更多表格操作"><MoreHorizontal size={17} aria-hidden="true" /></summary>
      <div className="table-edge-menu-panel" role="group" aria-label="表格更多操作">
        <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => editor.chain().deleteTable().run()}>
          <Trash2 size={14} aria-hidden="true" />删除整个表格
        </button>
      </div>
    </details>
  </div>, document.body);
}
