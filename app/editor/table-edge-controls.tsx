import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { adjustActiveTableSize, getActiveTableContext, getActiveTableSnapshot, getTableEdgeDragDelta, restoreActiveTableSnapshot, type TableEdgeAxis, type TableEdgeSnapshot } from "./table-edge-commands";

type TableControlsPosition = {
  columns: { top: number; left: number; height: number };
  rows: { top: number; left: number; width: number };
  rowCount: number;
  columnCount: number;
  tablePosition: number;
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

function getTableShellAtPosition(editor: Editor, position: number): HTMLElement | null {
  const nodeDom = editor.view.nodeDOM(position);
  if (!(nodeDom instanceof HTMLElement)) return null;
  return nodeDom.closest<HTMLElement>(".table-scroll-shell, .tableWrapper")
    ?? nodeDom.querySelector<HTMLElement>(".table-scroll-shell, .tableWrapper")
    ?? (nodeDom.matches("table") ? nodeDom : null);
}

const tablePositionsByDocument = new WeakMap<ProseMirrorNode, Map<HTMLElement, number>>();

function getTablePositionForShell(editor: Editor, shell: HTMLElement) {
  let positions = tablePositionsByDocument.get(editor.state.doc);
  if (!positions) {
    positions = new Map();
    editor.state.doc.descendants((node, position) => {
      if (node.type.name !== "table") return;
      const nodeDom = editor.view.nodeDOM(position);
      if (!(nodeDom instanceof HTMLElement)) return;
      const tableShell = nodeDom.closest<HTMLElement>(".table-scroll-shell, .tableWrapper")
        ?? nodeDom.querySelector<HTMLElement>(".table-scroll-shell, .tableWrapper");
      if (tableShell) positions?.set(tableShell, position);
    });
    tablePositionsByDocument.set(editor.state.doc, positions);
  }
  return positions.get(shell) ?? null;
}

function getTableShellNearPointer(editor: Editor, pointer: { x: number; y: number }) {
  const hit = document.elementFromPoint(pointer.x, pointer.y);
  const directShell = hit instanceof HTMLElement
    ? hit.closest<HTMLElement>(".table-scroll-shell, .tableWrapper")
    : null;
  if (directShell && editor.view.dom.contains(directShell)) return directShell;

  let nearest: HTMLElement | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  const shells = editor.view.dom.querySelectorAll<HTMLElement>(".table-scroll-shell, .tableWrapper");
  shells.forEach((shell) => {
    const tableRect = shell.querySelector("table")?.getBoundingClientRect() ?? shell.getBoundingClientRect();
    const shellRect = shell.getBoundingClientRect();
    const visibleRight = Math.min(tableRect.right, shellRect.right);
    const rightDistance = Math.abs(pointer.x - visibleRight);
    const bottomDistance = Math.abs(pointer.y - tableRect.bottom);
    const besideRight = rightDistance <= 34 && pointer.y >= tableRect.top - 14 && pointer.y <= tableRect.bottom + 14;
    const belowBottom = bottomDistance <= 34 && pointer.x >= tableRect.left - 14 && pointer.x <= visibleRight + 14;
    if (!besideRight && !belowBottom) return;
    const distance = Math.min(
      besideRight ? rightDistance : Number.POSITIVE_INFINITY,
      belowBottom ? bottomDistance : Number.POSITIVE_INFINITY,
    );
    if (distance < nearestDistance) {
      nearest = shell;
      nearestDistance = distance;
    }
  });
  return nearest;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(value, maximum));
}

function getTableEdgeDragStep(shell: HTMLElement | null, axis: TableEdgeAxis, fallbackSize: number) {
  const table = shell?.querySelector("table");
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

function TableEdgeRail({ editor, axis, size, tablePosition, shell, position, disabled, visible, onAdjust, onDragPositionChange }: {
  editor: Editor;
  axis: TableEdgeAxis;
  size: number;
  tablePosition: number;
  shell: HTMLElement | null;
  position: { top: number; left: number; width?: number; height?: number };
  disabled: boolean;
  visible: boolean;
  onAdjust: (delta: number, position?: number) => boolean;
  onDragPositionChange: (position: number | null) => void;
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

  const clearDrag = (pointerId?: number) => {
    const drag = dragRef.current;
    if (!drag || (pointerId !== undefined && drag.pointerId !== pointerId)) return null;
    dragRef.current = null;
    onDragPositionChange(null);
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
      if (delta) onAdjustRef.current(delta, drag.snapshot.position);
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
      if (delta) adjustActiveTableSize(editor, axis, delta, { addToHistory: false, emitUpdate: false }, drag.snapshot.position);
      drag.delta = delta;
      setPreviewDelta(delta);
    }
  };

  useEffect(() => () => {
    removeWindowListenersRef.current?.();
    removeWindowListenersRef.current = null;
    onDragPositionChange(null);
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag && !editor.isDestroyed) {
      restoreActiveTableSnapshot(editor, drag.snapshot, { addToHistory: false, emitUpdate: false, closeHistory: true });
    }
  }, [editor, onDragPositionChange]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (disabled || !event.isPrimary || event.button !== 0) return;
    suppressClickRef.current = false;
    const snapshot = getActiveTableSnapshot(editor, tablePosition);
    if (!snapshot) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    onDragPositionChange(tablePosition);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      distance: 0,
      delta: 0,
      initialSize: size,
      step: getTableEdgeDragStep(shell, axis, size),
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
    onAdjustRef.current(1, tablePosition);
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
      className="table-edge-drag-handle"
      type="button"
      aria-label={`增加一${noun}`}
      disabled={disabled}
      onPointerDown={handlePointerDown}
      onPointerUp={finishDrag}
      onPointerCancel={(event) => cancelDrag(event.pointerId)}
      onLostPointerCapture={(event) => cancelDrag(event.pointerId)}
      onClick={handleDragHandleClick}
    ><span className="table-edge-grip" aria-hidden="true" /></button>
    {previewDelta !== 0 && <output className="table-edge-preview" aria-live="polite">
      {previewDelta > 0 ? `+${previewDelta}` : previewDelta} {noun}
    </output>}
  </div>;
}

export function TableEdgeControls({ editor, deferredLoading }: { editor: Editor; deferredLoading: boolean }) {
  const [position, setPosition] = useState<TableControlsPosition | null>(null);
  const [visibleRails, setVisibleRails] = useState({ columns: false, rows: false });
  const pointerPositionRef = useRef<{ x: number; y: number } | null>(null);
  const dragTablePositionRef = useRef<number | null>(null);
  const onDragPositionChange = useCallback((tablePosition: number | null) => {
    dragTablePositionRef.current = tablePosition;
  }, []);

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

        const pointer = pointerPositionRef.current;
        const hoveredShell = pointer ? getTableShellNearPointer(editor, pointer) : null;
        const hoveredPosition = hoveredShell ? getTablePositionForShell(editor, hoveredShell) : null;
        const activeContext = getActiveTableContext(editor);
        const tablePosition = dragTablePositionRef.current ?? hoveredPosition ?? activeContext?.position;
        const context = tablePosition === undefined ? null : getActiveTableContext(editor, tablePosition);
        const shell = tablePosition === undefined ? null : getTableShellAtPosition(editor, tablePosition);
        if (shell !== observedShell) {
          resizeObserver?.disconnect();
          observedShell = shell;
          if (shell) resizeObserver?.observe(shell);
        }
        if (!shell || !context || tablePosition === undefined) {
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
        const columnLeft = clamp(visibleTableRight + 4, padding, window.innerWidth - 14 - padding);
        const rowRailWidth = clamp(Math.min(visibleTableWidth - 12, window.innerWidth - padding * 2), 96, window.innerWidth - padding * 2);
        const rowLeft = clamp(visibleTableLeft + (visibleTableWidth - rowRailWidth) / 2, padding, window.innerWidth - rowRailWidth - padding);
        const rowTop = clamp(tableRect.bottom + 4, padding, window.innerHeight - 14 - padding);
        const next: TableControlsPosition = {
          columns: { top: columnTop, left: columnLeft, height: columnRailHeight },
          rows: { top: rowTop, left: rowLeft, width: rowRailWidth },
          rowCount: context.rows,
          columnCount: context.columns,
          tablePosition,
        };
        if (!pointer) {
          const hasHover = window.matchMedia?.("(hover: hover)").matches ?? true;
          setVisibleRails((current) => {
            const nextVisibility = hasHover ? { columns: false, rows: false } : { columns: true, rows: true };
            return current.columns === nextVisibility.columns && current.rows === nextVisibility.rows ? current : nextVisibility;
          });
        } else {
          const inBand = (left: number, top: number, width: number, height: number, padding = 8) =>
            pointer.x >= left - padding && pointer.x <= left + width + padding &&
            pointer.y >= top - padding && pointer.y <= top + height + padding;
          const visibleTableTop = Math.max(shellRect.top, tableRect.top);
          const visibleTableBottom = Math.min(shellRect.bottom, tableRect.bottom);
          const inColumnEdgeBand = pointer.x >= visibleTableRight - 10 && pointer.x <= next.columns.left + 22 &&
            pointer.y >= visibleTableTop - 8 && pointer.y <= visibleTableBottom + 8;
          const inRowEdgeBand = pointer.x >= visibleTableLeft - 8 && pointer.x <= visibleTableRight + 8 &&
            pointer.y >= tableRect.bottom - 10 && pointer.y <= next.rows.top + 22;
          const inColumnRail = inBand(next.columns.left, next.columns.top, 14, next.columns.height);
          const inRowRail = inBand(next.rows.left, next.rows.top, next.rows.width, 14);
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
          current.rowCount === next.rowCount &&
          current.columnCount === next.columnCount &&
          current.tablePosition === next.tablePosition
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

  if (typeof document === "undefined" || !position) return null;
  return createPortal(<div className="table-edge-controls-overlay" aria-label="表格边缘操作">
    <TableEdgeRail
      editor={editor}
      axis="columns"
      size={position.columnCount}
      tablePosition={position.tablePosition}
      shell={getTableShellAtPosition(editor, position.tablePosition)}
      position={position.columns}
      disabled={deferredLoading}
      visible={visibleRails.columns}
      onAdjust={(delta, tablePosition) => adjustActiveTableSize(editor, "columns", delta, {}, tablePosition ?? position.tablePosition)}
      onDragPositionChange={onDragPositionChange}
    />
    <TableEdgeRail
      editor={editor}
      axis="rows"
      size={position.rowCount}
      tablePosition={position.tablePosition}
      shell={getTableShellAtPosition(editor, position.tablePosition)}
      position={position.rows}
      disabled={deferredLoading}
      visible={visibleRails.rows}
      onAdjust={(delta, tablePosition) => adjustActiveTableSize(editor, "rows", delta, {}, tablePosition ?? position.tablePosition)}
      onDragPositionChange={onDragPositionChange}
    />
  </div>, document.body);
}
