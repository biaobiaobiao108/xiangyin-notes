import type { Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Selection, TextSelection } from "@tiptap/pm/state";

export type BlockKind = "topLevel" | "listItem";

export type BlockTarget = {
  node: ProseMirrorNode;
  pos: number;
  endPos: number;
  parent: ProseMirrorNode;
  parentStart: number;
  index: number;
  dom: HTMLElement | null;
  kind: BlockKind;
};

export type DropPlacement = "before" | "after";

export type BlockIndexRange = {
  start: number;
  end: number;
};

export type BlockSlot = {
  block: BlockTarget;
  top: number;
  bottom: number;
};

export type DropCandidate = {
  target: BlockTarget;
  placement: DropPlacement;
  gap: number;
  destinationIndex: number;
  noop: boolean;
};

/** Converts a viewport Y coordinate into the drag session's initial scroll coordinates. */
export function toDragSessionY(viewportY: number, scrollDelta: number, translationY = 0) {
  return viewportY - translationY + scrollDelta;
}

const DROP_EDGE_HYSTERESIS = 8;

function targetFromResolvedPosition(
  editor: Editor,
  dom: HTMLElement,
  kind: BlockKind,
): BlockTarget | null {
  try {
    const pos = editor.view.posAtDOM(dom, 0);
    const $pos = editor.state.doc.resolve(pos);

    if (kind === "listItem") {
      for (let depth = $pos.depth; depth > 0; depth -= 1) {
        const node = $pos.node(depth);
        if (node.type.name !== "listItem" && node.type.name !== "taskItem") continue;
        return {
          node,
          pos: $pos.before(depth),
          endPos: $pos.after(depth),
          parent: $pos.node(depth - 1),
          parentStart: $pos.start(depth - 1),
          index: $pos.index(depth - 1),
          dom,
          kind,
        };
      }
      return null;
    }

    if ($pos.depth < 1) return null;
    return {
      node: $pos.node(1),
      pos: $pos.before(1),
      endPos: $pos.after(1),
      parent: $pos.node(0),
      parentStart: $pos.start(0),
      index: $pos.index(0),
      dom,
      kind,
    };
  } catch {
    return null;
  }
}

// Leaf blocks such as <hr> have no interior DOM offset, so resolve them through
// their parent instead of calling posAtDOM on the element itself.
function topLevelTargetFromDom(editor: Editor, dom: HTMLElement): BlockTarget | null {
  const editorDom = editor.view.dom;
  if (dom.parentElement !== editorDom) return null;
  const domIndex = Array.prototype.indexOf.call(editorDom.children, dom);
  if (domIndex < 0) return null;

  try {
    const pos = editor.view.posAtDOM(editorDom, domIndex);
    const $pos = editor.state.doc.resolve(pos);
    if ($pos.depth === 0) {
      const index = $pos.index(0);
      const node = $pos.parent.child(index);
      return {
        node,
        pos,
        endPos: pos + node.nodeSize,
        parent: $pos.parent,
        parentStart: 0,
        index,
        dom,
        kind: "topLevel",
      };
    }

    return targetFromResolvedPosition(editor, dom, "topLevel");
  } catch {
    return null;
  }
}

function closestTopLevelBlock(editor: Editor, y: number): BlockTarget | null {
  const editorDom = editor.view.dom;
  let closest: HTMLElement | null = null;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (const element of Array.from(editorDom.children)) {
    if (!(element instanceof HTMLElement)) continue;
    const rect = element.getBoundingClientRect();
    const distance = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
    if (distance >= closestDistance) continue;
    closest = element;
    closestDistance = distance;
    if (distance === 0) break;
  }
  return closest ? topLevelTargetFromDom(editor, closest) : null;
}

/**
 * Resolves the movable block from a DOM node inside the editor.
 * List items move as their own block; everything else moves as a top-level node.
 */
export function getDraggableBlockFromElement(
  editor: Editor,
  targetElement: HTMLElement,
  point?: { x: number; y: number },
): BlockTarget | null {
  const editorDom = editor.view.dom;
  if (!editorDom.contains(targetElement)) return null;
  if (targetElement === editorDom) {
    return point ? closestTopLevelBlock(editor, point.y) : null;
  }

  const listItemDom = targetElement.closest<HTMLElement>("li");
  if (listItemDom && editorDom.contains(listItemDom)) {
    return targetFromResolvedPosition(editor, listItemDom, "listItem");
  }

  const listDom = targetElement.closest<HTMLElement>("ul, ol");
  if (listDom && editorDom.contains(listDom)) {
    const items = Array.from(listDom.children).filter(
      (element): element is HTMLElement =>
        element instanceof HTMLElement && element.tagName === "LI",
    );
    if (!items.length) return null;
    if (!point) return targetFromResolvedPosition(editor, items[0], "listItem");
    let closest = items[0];
    let closestDistance = Number.POSITIVE_INFINITY;
    for (const item of items) {
      const rect = item.getBoundingClientRect();
      const distance =
        point.y < rect.top ? rect.top - point.y : point.y > rect.bottom ? point.y - rect.bottom : 0;
      if (distance < closestDistance) {
        closest = item;
        closestDistance = distance;
        if (distance === 0) break;
      }
    }
    return targetFromResolvedPosition(editor, closest, "listItem");
  }

  let current: HTMLElement | null = targetElement;
  while (current.parentElement && current.parentElement !== editorDom) {
    current = current.parentElement;
  }
  if (!current || current.parentElement !== editorDom) return null;

  return topLevelTargetFromDom(editor, current);
}

/**
 * Returns the draggable siblings in document order. Drag operations never
 * cross a list boundary, so a list item only sees its direct `li` siblings.
 */
export function getSiblingBlocks(editor: Editor, source: BlockTarget): BlockTarget[] {
  const blocks: BlockTarget[] = [];
  let position = source.parentStart;
  for (let index = 0; index < source.parent.childCount; index += 1) {
    const node = source.parent.child(index);
    let dom: HTMLElement | null = null;
    try {
      const nodeDom = editor.view.nodeDOM(position);
      if (nodeDom instanceof HTMLElement) dom = nodeDom;
    } catch {
      dom = null;
    }
    blocks.push({
      node,
      pos: position,
      endPos: position + node.nodeSize,
      parent: source.parent,
      parentStart: source.parentStart,
      index,
      dom,
      kind: source.kind,
    });
    position += node.nodeSize;
  }
  return blocks;
}

/** Resolves the movable block that currently owns the editor selection. */
export function getDraggableBlockFromSelection(editor: Editor): BlockTarget | null {
  const { $from } = editor.state.selection;
  if ($from.depth < 1) return null;

  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type.name !== "listItem" && node.type.name !== "taskItem") continue;
    const dom = editor.view.nodeDOM($from.before(depth));
    return dom instanceof HTMLElement ? targetFromResolvedPosition(editor, dom, "listItem") : null;
  }

  const dom = editor.view.nodeDOM($from.before(1));
  return dom instanceof HTMLElement ? topLevelTargetFromDom(editor, dom) : null;
}

/**
 * Resolves the contiguous range of sibling blocks covered by the current
 * editor selection when the anchor block is part of that selection.
 * If there is no multi-block selection or the anchor block is not selected,
 * only the anchor block is returned.
 */
export function getSelectedBlockRange(editor: Editor, anchorBlock: BlockTarget): BlockTarget[] {
  const { state } = editor;
  const { selection } = state;
  if (selection.empty) {
    return [anchorBlock];
  }

  // If the selection does not intersect anchorBlock, only drag anchorBlock
  if (selection.from >= anchorBlock.endPos || selection.to <= anchorBlock.pos) {
    return [anchorBlock];
  }

  const siblings = getSiblingBlocks(editor, anchorBlock);
  const selectedSiblings = siblings.filter(
    (sibling) => selection.from < sibling.endPos && selection.to > sibling.pos,
  );

  if (selectedSiblings.length <= 1) {
    return [anchorBlock];
  }

  // Ensure the selected siblings form a contiguous range
  const firstIndex = selectedSiblings[0].index;
  const lastIndex = selectedSiblings[selectedSiblings.length - 1].index;
  if (lastIndex - firstIndex + 1 !== selectedSiblings.length) {
    return [anchorBlock];
  }

  return selectedSiblings;
}

/** Selects all text spanning from fromBlock to toBlock if they share the same parent. */
export function selectBlockRange(
  editor: Editor,
  fromBlock: BlockTarget,
  toBlock: BlockTarget,
): boolean {
  if (!fromBlock.parent.eq(toBlock.parent)) return false;
  const startPos = Math.min(fromBlock.pos, toBlock.pos);
  const endPos = Math.max(fromBlock.endPos, toBlock.endPos);
  try {
    const { doc } = editor.state;
    const $from = doc.resolve(Math.min(startPos + 1, doc.content.size));
    const $to = doc.resolve(Math.min(Math.max(1, endPos - 1), doc.content.size));
    const selection = TextSelection.between($from, $to);
    editor.view.dispatch(editor.state.tr.setSelection(selection));
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds the closest insertion edge from sibling geometry. The original
 * placement is kept until the pointer moves a few pixels past the next edge,
 * so small pointer movements around a boundary do not make nearby text jump.
 */
export function calculateDropCandidate(
  slots: readonly BlockSlot[],
  sourceRange: number | BlockIndexRange,
  pointerY: number,
  current: DropCandidate | null = null,
  sourceSpan = 0,
): DropCandidate | null {
  const sourceStart = typeof sourceRange === "number" ? sourceRange : sourceRange.start;
  const sourceEnd = typeof sourceRange === "number" ? sourceRange : sourceRange.end;
  const count = sourceEnd - sourceStart + 1;

  let best:
    | {
        block: BlockTarget;
        placement: DropPlacement;
        gap: number;
        distance: number;
      }
    | undefined;

  const currentDest = current && !current.noop ? current.destinationIndex : null;

  // If we already have an active destination, check if pointer is inside the opened hole
  if (current && !current.noop && currentDest !== null && sourceSpan > 0) {
    let holeTop = -Infinity;
    let holeBottom = Infinity;
    if (currentDest < sourceStart) {
      if (currentDest > 0) {
        holeTop = slots[currentDest - 1].bottom;
      } else if (slots.length > 0) {
        holeTop = slots[0].top;
      }
      if (currentDest < slots.length) {
        holeBottom = slots[currentDest].top + sourceSpan;
      }
    } else {
      const gap = currentDest + count;
      if (gap > 0 && gap - 1 < slots.length) {
        holeTop = slots[gap - 1].bottom - sourceSpan;
      }
      if (gap < slots.length) {
        holeBottom = slots[gap].top;
      }
    }
    if (
      pointerY >= holeTop - DROP_EDGE_HYSTERESIS &&
      pointerY <= holeBottom + DROP_EDGE_HYSTERESIS
    ) {
      return current;
    }
  }

  slots.forEach((slot, targetIndex) => {
    if (targetIndex >= sourceStart && targetIndex <= sourceEnd) return;
    const shift =
      currentDest !== null && sourceSpan > 0
        ? getBlockShift(targetIndex, sourceRange, currentDest, sourceSpan)
        : 0;
    const vtop = slot.top + shift;
    const vbottom = slot.bottom + shift;

    (["before", "after"] as const).forEach((placement) => {
      const edge = placement === "before" ? vtop : vbottom;
      const distance = Math.abs(pointerY - edge);
      if (best && distance >= best.distance) return;
      best = {
        block: slot.block,
        placement,
        gap: targetIndex + (placement === "after" ? 1 : 0),
        distance,
      };
    });
  });

  if (!best) return null;
  const currentIndex = current
    ? slots.findIndex((slot) => slot.block.pos === current.target.pos)
    : -1;
  if (current && currentIndex >= 0 && (currentIndex < sourceStart || currentIndex > sourceEnd)) {
    const currShift =
      currentDest !== null && sourceSpan > 0
        ? getBlockShift(currentIndex, sourceRange, currentDest, sourceSpan)
        : 0;
    const edge =
      (current.placement === "before" ? slots[currentIndex].top : slots[currentIndex].bottom) +
      currShift;
    if (Math.abs(pointerY - edge) <= best.distance + DROP_EDGE_HYSTERESIS) {
      best.block = slots[currentIndex].block;
      best.placement = current.placement;
      best.gap = currentIndex + (current.placement === "after" ? 1 : 0);
    }
  }

  const noop = best.gap >= sourceStart && best.gap <= sourceEnd + 1;
  const destinationIndex = best.gap > sourceEnd ? best.gap - count : best.gap;
  return {
    target: best.block,
    placement: best.placement,
    gap: best.gap,
    destinationIndex,
    noop,
  };
}

/**
 * Returns how far a sibling moves while previewing the move. Only the source
 * blocks change position, so every crossed sibling shifts by their occupied span.
 */
export function getBlockShift(
  index: number,
  sourceRange: number | BlockIndexRange,
  destinationIndex: number,
  sourceSpan: number,
): number {
  const sourceStart = typeof sourceRange === "number" ? sourceRange : sourceRange.start;
  const sourceEnd = typeof sourceRange === "number" ? sourceRange : sourceRange.end;
  const count = sourceEnd - sourceStart + 1;

  const gap = destinationIndex > sourceStart ? destinationIndex + count : destinationIndex;
  if (gap > sourceEnd + 1 && index > sourceEnd && index < gap) {
    return -sourceSpan;
  }
  if (gap < sourceStart && index >= gap && index < sourceStart) {
    return sourceSpan;
  }
  return 0;
}

function insertionPosition(
  parent: ProseMirrorNode,
  parentStart: number,
  gap: number,
): number | null {
  if (gap < 0 || gap > parent.childCount) return null;
  let position = parentStart;
  for (let index = 0; index < gap; index += 1) {
    position += parent.child(index).nodeSize;
  }
  return position;
}

/**
 * Moves one or more contiguous sibling blocks before or after a target sibling.
 * The transaction is isolated from typing history and restores selection.
 */
export function moveBlocks(
  editor: Editor,
  sources: BlockTarget[],
  target: BlockTarget,
  placement: DropPlacement,
): number | null {
  if (!sources.length) return null;
  const firstSource = sources[0];
  const lastSource = sources[sources.length - 1];

  for (const source of sources) {
    if (!source.parent.eq(target.parent)) return null;
  }

  const sourceStart = firstSource.index;
  const sourceEnd = lastSource.index;
  const gap = target.index + (placement === "after" ? 1 : 0);
  if (gap >= sourceStart && gap <= sourceEnd + 1) return null;

  const insertOriginal = insertionPosition(firstSource.parent, firstSource.parentStart, gap);
  if (insertOriginal === null) return null;

  const { state, view } = editor;
  for (const source of sources) {
    const node = state.doc.nodeAt(source.pos);
    if (!node || !node.eq(source.node)) return null;
  }

  const $insertOriginal = state.doc.resolve(insertOriginal);
  const insertIndex = $insertOriginal.index();
  for (const source of sources) {
    if (!$insertOriginal.parent.canReplaceWith(insertIndex, insertIndex, source.node.type)) {
      return null;
    }
  }

  const selectionInsideSources =
    state.selection.from >= firstSource.pos && state.selection.to <= lastSource.endPos;

  view.dispatch(closeHistory(state.tr));
  const transaction = view.state.tr;

  const deleteStart = firstSource.pos;
  const deleteEnd = lastSource.endPos;
  const sourceNodes = sources.map((s) => s.node);

  transaction.delete(deleteStart, deleteEnd);
  const insertPosition = transaction.mapping.map(insertOriginal, 1);

  let curPos = insertPosition;
  for (const node of sourceNodes) {
    transaction.insert(curPos, node);
    curPos += node.nodeSize;
  }

  if (selectionInsideSources) {
    if (state.selection.empty) {
      transaction.setSelection(
        Selection.near(
          transaction.doc.resolve(Math.min(insertPosition + 1, transaction.doc.content.size)),
        ),
      );
    } else {
      const offsetFrom = state.selection.from - deleteStart;
      const offsetTo = state.selection.to - deleteStart;
      const newFrom = Math.min(
        Math.max(1, insertPosition + offsetFrom),
        transaction.doc.content.size,
      );
      const newTo = Math.min(Math.max(1, insertPosition + offsetTo), transaction.doc.content.size);
      try {
        const $from = transaction.doc.resolve(newFrom);
        const $to = transaction.doc.resolve(newTo);
        if ($from.parent.inlineContent && $to.parent.inlineContent) {
          transaction.setSelection(new TextSelection($from, $to));
        } else {
          transaction.setSelection(
            Selection.near(
              transaction.doc.resolve(Math.min(insertPosition + 1, transaction.doc.content.size)),
            ),
          );
        }
      } catch {
        transaction.setSelection(
          Selection.near(
            transaction.doc.resolve(Math.min(insertPosition + 1, transaction.doc.content.size)),
          ),
        );
      }
    }
  }

  view.dispatch(closeHistory(transaction));
  view.dispatch(closeHistory(view.state.tr));
  return insertPosition;
}

export function moveBlock(
  editor: Editor,
  source: BlockTarget,
  target: BlockTarget,
  placement: DropPlacement,
): number | null {
  return moveBlocks(editor, [source], target, placement);
}

function siblingTarget(block: BlockTarget, index: number): BlockTarget | null {
  if (index < 0 || index >= block.parent.childCount) return null;
  let pos = block.parentStart;
  for (let current = 0; current < index; current += 1) {
    pos += block.parent.child(current).nodeSize;
  }
  const node = block.parent.child(index);
  return {
    node,
    pos,
    endPos: pos + node.nodeSize,
    parent: block.parent,
    parentStart: block.parentStart,
    index,
    dom: null,
    kind: block.kind,
  };
}

export function moveBlocksStep(
  editor: Editor,
  blocks: BlockTarget[],
  direction: "up" | "down",
): boolean {
  if (!blocks.length) return false;
  const firstBlock = blocks[0];
  const lastBlock = blocks[blocks.length - 1];
  const targetIndex = direction === "up" ? firstBlock.index - 1 : lastBlock.index + 1;
  const target = siblingTarget(firstBlock, targetIndex);
  if (!target) return false;
  return moveBlocks(editor, blocks, target, direction === "up" ? "before" : "after") !== null;
}

export function moveBlockStep(
  editor: Editor,
  block: BlockTarget,
  direction: "up" | "down",
): boolean {
  return moveBlocksStep(editor, [block], direction);
}

export function duplicateBlocks(editor: Editor, blocks: BlockTarget[]): boolean {
  if (!blocks.length) return false;
  const { state, view } = editor;
  const lastBlock = blocks[blocks.length - 1];

  for (const block of blocks) {
    const node = state.doc.nodeAt(block.pos);
    if (!node || !node.eq(block.node)) return false;
  }

  const $insert = state.doc.resolve(lastBlock.endPos);
  const duplicateInsertIndex = $insert.index();
  for (const block of blocks) {
    if (
      !$insert.parent.canReplaceWith(duplicateInsertIndex, duplicateInsertIndex, block.node.type)
    ) {
      return false;
    }
  }

  view.dispatch(closeHistory(state.tr));
  const transaction = view.state.tr;
  let curPos = lastBlock.endPos;
  for (const block of blocks) {
    transaction.insert(curPos, block.node.copy(block.node.content));
    curPos += block.node.nodeSize;
  }
  view.dispatch(closeHistory(transaction));
  view.dispatch(closeHistory(view.state.tr));
  return true;
}

export function duplicateBlock(editor: Editor, block: BlockTarget): boolean {
  return duplicateBlocks(editor, [block]);
}

export function deleteBlocks(editor: Editor, blocks: BlockTarget[]): boolean {
  if (!blocks.length) return false;

  const { state, view } = editor;
  const firstBlock = blocks[0];
  const lastBlock = blocks[blocks.length - 1];

  for (const block of blocks) {
    const node = state.doc.nodeAt(block.pos);
    if (!node || !node.eq(block.node)) return false;
  }

  if (firstBlock.kind === "listItem" && blocks.length === firstBlock.parent.childCount) {
    const listPos = firstBlock.parentStart - 1;
    const list = state.doc.nodeAt(listPos);
    if (!list || !list.eq(firstBlock.parent)) return false;

    const listEnd = listPos + list.nodeSize;
    const $list = state.doc.resolve(listPos);
    let replacement: ProseMirrorNode | null = null;
    if ($list.parent.childCount === 1) {
      replacement = state.schema.nodes.paragraph?.createAndFill() ?? null;
      if (!replacement) return false;
    }
    view.dispatch(closeHistory(state.tr));
    const transaction = view.state.tr;
    if (replacement) {
      transaction.replaceWith(listPos, listEnd, replacement);
    } else {
      transaction.delete(listPos, listEnd);
    }
    transaction.setSelection(
      Selection.near(transaction.doc.resolve(Math.min(listPos, transaction.doc.content.size))),
    );
    view.dispatch(closeHistory(transaction));
    view.dispatch(closeHistory(view.state.tr));
    return true;
  }

  const isAllDoc =
    firstBlock.parent.type.name === "doc" && blocks.length === firstBlock.parent.childCount;
  const replacement = isAllDoc ? (state.schema.nodes.paragraph?.createAndFill() ?? null) : null;
  if (isAllDoc && !replacement) return false;
  view.dispatch(closeHistory(state.tr));
  const transaction = view.state.tr;
  if (replacement) {
    transaction.replaceWith(firstBlock.pos, lastBlock.endPos, replacement);
    transaction.setSelection(Selection.near(transaction.doc.resolve(1)));
  } else {
    transaction.delete(firstBlock.pos, lastBlock.endPos);
    transaction.setSelection(
      Selection.near(
        transaction.doc.resolve(Math.min(firstBlock.pos, transaction.doc.content.size)),
      ),
    );
  }
  view.dispatch(closeHistory(transaction));
  view.dispatch(closeHistory(view.state.tr));
  return true;
}

export function deleteBlock(editor: Editor, block: BlockTarget): boolean {
  return deleteBlocks(editor, [block]);
}
