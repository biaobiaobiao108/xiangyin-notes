import type { Editor } from "@tiptap/core";
import { Fragment, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { closeHistory } from "@tiptap/pm/history";
import { TextSelection } from "@tiptap/pm/state";

export type TableEdgeAxis = "columns" | "rows";

export type ActiveTableContext = {
  node: ProseMirrorNode;
  position: number;
  rows: number;
  columns: number;
  lastCellTextPosition: number;
};

export type TableEdgeSnapshot = Pick<
  ActiveTableContext,
  "node" | "position" | "lastCellTextPosition"
>;

export type TableEdgeTransactionOptions = {
  addToHistory?: boolean;
  emitUpdate?: boolean;
  closeHistory?: boolean;
};

export function getTableEdgeDragDelta(
  distance: number,
  currentSize: number,
  step = 28,
  existingItemSizes?: readonly number[],
) {
  if (!Number.isFinite(distance) || currentSize < 1 || step < 1) return 0;
  if (distance >= 0) return Math.round(distance / step);

  let delta = 0;
  let boundary = 0;
  let nearestDistance = Math.abs(distance);
  for (let index = currentSize - 1; index > 0; index -= 1) {
    boundary -= Math.max(1, existingItemSizes?.[index] || step);
    const distanceToBoundary = Math.abs(distance - boundary);
    if (distanceToBoundary >= nearestDistance) break;
    nearestDistance = distanceToBoundary;
    delta = index - currentSize;
  }
  return delta;
}

export function snapTableEdgeDrag(
  distance: number,
  currentSize: number,
  step = 28,
  existingItemSizes?: readonly number[],
) {
  const delta = getTableEdgeDragDelta(distance, currentSize, step, existingItemSizes);
  if (delta >= 0) return { delta, snappedDistance: delta * step };

  let snappedDistance = 0;
  for (let index = currentSize - 1; index >= currentSize + delta; index -= 1) {
    snappedDistance -= Math.max(1, existingItemSizes?.[index] || step);
  }
  return { delta, snappedDistance };
}

function createTableContext(node: ProseMirrorNode, position: number): ActiveTableContext | null {
  if (node.type.name !== "table" || node.childCount === 0) return null;
  const lastRowIndex = node.childCount - 1;
  let lastCellTextPosition = position + node.nodeSize - 2;
  node.forEach((row, rowOffset, rowIndex) => {
    if (rowIndex !== lastRowIndex) return;
    const lastColumnIndex = row.childCount - 1;
    row.forEach((_cell, cellOffset, cellIndex) => {
      if (cellIndex !== lastColumnIndex) return;
      lastCellTextPosition = position + 4 + rowOffset + cellOffset;
    });
  });

  return {
    node,
    position,
    rows: node.childCount,
    columns: node.firstChild?.childCount ?? 0,
    lastCellTextPosition,
  };
}

export function getActiveTableContext(
  editor: Editor,
  tablePosition?: number,
): ActiveTableContext | null {
  if (tablePosition !== undefined) {
    const node = editor.state.doc.nodeAt(tablePosition);
    return node ? createTableContext(node, tablePosition) : null;
  }

  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name === "table") {
      return createTableContext($from.node(depth), $from.before(depth));
    }
  }
  return null;
}

export function getActiveTableSnapshot(
  editor: Editor,
  tablePosition?: number,
): TableEdgeSnapshot | null {
  const context = getActiveTableContext(editor, tablePosition);
  if (!context) return null;
  return {
    node: context.node,
    position: context.position,
    lastCellTextPosition: context.lastCellTextPosition,
  };
}

export function restoreActiveTableSnapshot(
  editor: Editor,
  snapshot: TableEdgeSnapshot,
  options: TableEdgeTransactionOptions = {},
) {
  const context = getActiveTableContext(editor, snapshot.position);
  if (!context) return false;

  return editor
    .chain()
    .command(({ tr }) => {
      tr.replaceWith(context.position, context.position + context.node.nodeSize, snapshot.node);
      tr.setSelection(TextSelection.near(tr.doc.resolve(snapshot.lastCellTextPosition), 1));
      if (options.addToHistory === false) tr.setMeta("addToHistory", false);
      if (options.emitUpdate === false) tr.setMeta("preventUpdate", true);
      if (options.closeHistory) closeHistory(tr);
      return true;
    })
    .run();
}

export function previewActiveTableSize(
  editor: Editor,
  snapshot: TableEdgeSnapshot,
  axis: TableEdgeAxis,
  delta: number,
) {
  const context = getActiveTableContext(editor, snapshot.position);
  if (!context) return false;

  const nextTable = delta
    ? resizeTableNode(snapshot.node, axis, delta, editor.state.schema)
    : snapshot.node;
  if (!nextTable) return false;

  const tr = editor.state.tr.replaceWith(
    context.position,
    context.position + context.node.nodeSize,
    nextTable,
  );
  tr.setSelection(editor.state.selection.map(tr.doc, tr.mapping));
  tr.setMeta("addToHistory", false).setMeta("preventUpdate", true);
  editor.view.dispatch(tr);
  return true;
}

export function adjustActiveTableSize(
  editor: Editor,
  axis: TableEdgeAxis,
  delta: number,
  options: TableEdgeTransactionOptions = {},
  tablePosition?: number,
) {
  const context = getActiveTableContext(editor, tablePosition);
  const amount = Math.trunc(delta);
  if (!context || !amount) return false;

  const nextTable = resizeTableNode(context.node, axis, amount, editor.state.schema);
  if (!nextTable) return false;

  const lastCellPosition = getLastCellTextPosition(context.position, nextTable);
  return editor
    .chain()
    .command(({ tr }) => {
      tr.replaceWith(context.position, context.position + context.node.nodeSize, nextTable);
      tr.setSelection(TextSelection.near(tr.doc.resolve(lastCellPosition), 1));
      if (options.addToHistory === false) tr.setMeta("addToHistory", false);
      if (options.emitUpdate === false) tr.setMeta("preventUpdate", true);
      if (options.closeHistory) closeHistory(tr);
      return true;
    })
    .run();
}

function resizeTableNode(
  table: ProseMirrorNode,
  axis: TableEdgeAxis,
  delta: number,
  schema: Editor["state"]["schema"],
) {
  const amount = Math.trunc(delta);
  if (!amount) return null;

  const currentSize = axis === "columns" ? (table.firstChild?.childCount ?? 0) : table.childCount;
  const operationCount = amount > 0 ? amount : Math.min(currentSize - 1, Math.abs(amount));
  if (operationCount < 1) return null;

  let nextTable = table;
  for (let index = 0; index < operationCount; index += 1) {
    const next =
      axis === "columns"
        ? amount > 0
          ? addTrailingColumn(nextTable, schema)
          : removeTrailingColumn(nextTable)
        : amount > 0
          ? addTrailingRow(nextTable, schema)
          : removeTrailingRow(nextTable);
    if (!next) return null;
    nextTable = next;
  }
  return nextTable;
}

function getLastCellTextPosition(tablePosition: number, table: ProseMirrorNode) {
  const lastRow = table.lastChild;
  if (!lastRow?.lastChild) return tablePosition + table.nodeSize - 2;
  const lastRowOffset = table.content.size - lastRow.nodeSize;
  const lastCellOffset = lastRow.content.size - lastRow.lastChild.nodeSize;
  return tablePosition + 4 + lastRowOffset + lastCellOffset;
}

function addTrailingColumn(table: ProseMirrorNode, schema: Editor["state"]["schema"]) {
  const rows: ProseMirrorNode[] = [];
  let valid = true;
  table.forEach((row) => {
    const cells: ProseMirrorNode[] = [];
    row.forEach((cell) => cells.push(cell));
    const lastCell = cells[cells.length - 1];
    const isHeader = lastCell?.type.spec.tableRole === "header_cell";
    const cellType = schema.nodes[isHeader ? "tableHeader" : "tableCell"];
    const newCell = cellType?.createAndFill({ ...lastCell?.attrs, colwidth: null });
    if (!newCell) valid = false;
    else cells.push(newCell);
    rows.push(row.copy(Fragment.fromArray(cells)));
  });
  return valid ? table.copy(Fragment.fromArray(rows)) : null;
}

function removeTrailingColumn(table: ProseMirrorNode) {
  const rows: ProseMirrorNode[] = [];
  table.forEach((row) => {
    const cells: ProseMirrorNode[] = [];
    row.forEach((cell, _offset, index) => {
      if (index < row.childCount - 1) cells.push(cell);
    });
    rows.push(row.copy(Fragment.fromArray(cells)));
  });
  return table.copy(Fragment.fromArray(rows));
}

function addTrailingRow(table: ProseMirrorNode, schema: Editor["state"]["schema"]) {
  const lastRow = table.lastChild;
  const rowType = schema.nodes.tableRow;
  const cellType = schema.nodes.tableCell;
  if (!lastRow || !rowType || !cellType) return null;

  const cells: ProseMirrorNode[] = [];
  for (let index = 0; index < lastRow.childCount; index += 1) {
    const sourceCell = lastRow.child(index);
    const cell = cellType.createAndFill(sourceCell.attrs);
    if (!cell) return null;
    cells.push(cell);
  }
  const row = rowType.createAndFill(lastRow.attrs, Fragment.fromArray(cells));
  if (!row) return null;
  return table.copy(table.content.append(Fragment.from(row)));
}

function removeTrailingRow(table: ProseMirrorNode) {
  const rows: ProseMirrorNode[] = [];
  table.forEach((row, _offset, index) => {
    if (index < table.childCount - 1) rows.push(row);
  });
  return table.copy(Fragment.fromArray(rows));
}
