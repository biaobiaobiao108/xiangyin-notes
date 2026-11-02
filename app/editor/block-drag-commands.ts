import type { Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Selection } from "@tiptap/pm/state";

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
    const dom = editor.view.nodeDOM(position);
    blocks.push({
      node,
      pos: position,
      endPos: position + node.nodeSize,
      parent: source.parent,
      parentStart: source.parentStart,
      index,
      dom: dom instanceof HTMLElement ? dom : null,
      kind: source.kind,
    });
    position += node.nodeSize;
  }
  return blocks;
}

/**
 * Finds the closest insertion edge from sibling geometry. The original
 * placement is kept until the pointer moves a few pixels past the next edge,
 * so small pointer movements around a boundary do not make nearby text jump.
 */
export function calculateDropCandidate(
  slots: readonly BlockSlot[],
  sourceIndex: number,
  pointerY: number,
  current: DropCandidate | null = null,
): DropCandidate | null {
  let best:
    | {
        block: BlockTarget;
        placement: DropPlacement;
        gap: number;
        distance: number;
      }
    | undefined;

  slots.forEach((slot, targetIndex) => {
    if (targetIndex === sourceIndex) return;
    (["before", "after"] as const).forEach((placement) => {
      const edge = placement === "before" ? slot.top : slot.bottom;
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
  if (current && currentIndex >= 0 && currentIndex !== sourceIndex) {
    const edge =
      current.placement === "before" ? slots[currentIndex].top : slots[currentIndex].bottom;
    if (Math.abs(pointerY - edge) <= best.distance + DROP_EDGE_HYSTERESIS) {
      best.block = slots[currentIndex].block;
      best.placement = current.placement;
      best.gap = currentIndex + (current.placement === "after" ? 1 : 0);
    }
  }

  const destinationIndex = best.gap > sourceIndex ? best.gap - 1 : best.gap;
  return {
    target: best.block,
    placement: best.placement,
    gap: best.gap,
    destinationIndex,
    noop: destinationIndex === sourceIndex,
  };
}

/**
 * Returns how far a sibling moves while previewing the move. Only the source
 * block changes position, so every crossed sibling shifts by its occupied span.
 */
export function getBlockShift(
  index: number,
  sourceIndex: number,
  destinationIndex: number,
  sourceSpan: number,
): number {
  if (destinationIndex > sourceIndex && index > sourceIndex && index <= destinationIndex) {
    return -sourceSpan;
  }
  if (destinationIndex < sourceIndex && index >= destinationIndex && index < sourceIndex) {
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
 * Moves a block before or after a sibling. The transaction is isolated from
 * the current typing history so one undo restores the complete reorder.
 */
export function moveBlock(
  editor: Editor,
  source: BlockTarget,
  target: BlockTarget,
  placement: DropPlacement,
): number | null {
  if (source.pos === target.pos) return null;
  if (!source.parent.eq(target.parent)) return null;

  const gap = target.index + (placement === "after" ? 1 : 0);
  if (gap === source.index || gap === source.index + 1) return null;

  const insertOriginal = insertionPosition(source.parent, source.parentStart, gap);
  if (insertOriginal === null) return null;

  const { state, view } = editor;
  const sourceNode = state.doc.nodeAt(source.pos);
  if (!sourceNode || !sourceNode.eq(source.node)) return null;

  const selectionInsideSource =
    state.selection.from >= source.pos && state.selection.to <= source.endPos;
  const transaction = state.tr;
  transaction.delete(source.pos, source.endPos);
  const insertPosition = transaction.mapping.map(insertOriginal, 1);
  const $insert = transaction.doc.resolve(insertPosition);

  if (!$insert.parent.canReplaceWith($insert.index(), $insert.index(), sourceNode.type)) {
    return null;
  }

  transaction.insert(insertPosition, sourceNode);
  if (selectionInsideSource) {
    transaction.setSelection(
      Selection.near(
        transaction.doc.resolve(Math.min(insertPosition + 1, transaction.doc.content.size)),
      ),
    );
  }
  closeHistory(transaction);
  view.dispatch(transaction);
  return insertPosition;
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

export function moveBlockStep(
  editor: Editor,
  block: BlockTarget,
  direction: "up" | "down",
): boolean {
  const targetIndex = block.index + (direction === "up" ? -1 : 1);
  const target = siblingTarget(block, targetIndex);
  if (!target) return false;
  return moveBlock(editor, block, target, direction === "up" ? "before" : "after") !== null;
}

export function duplicateBlock(editor: Editor, block: BlockTarget): boolean {
  const { state, view } = editor;
  const sourceNode = state.doc.nodeAt(block.pos);
  if (!sourceNode || !sourceNode.eq(block.node)) return false;

  const transaction = state.tr;
  const $insert = transaction.doc.resolve(block.endPos);
  if (!$insert.parent.canReplaceWith($insert.index(), $insert.index(), sourceNode.type)) {
    return false;
  }
  transaction.insert(block.endPos, sourceNode.copy(sourceNode.content));
  closeHistory(transaction);
  view.dispatch(transaction);
  return true;
}

export function canDeleteBlock(block: BlockTarget): boolean {
  if (block.kind === "listItem") return block.parent.childCount > 1;
  return true;
}

export function deleteBlock(editor: Editor, block: BlockTarget): boolean {
  if (!canDeleteBlock(block)) return false;

  const { state, view } = editor;
  const sourceNode = state.doc.nodeAt(block.pos);
  if (!sourceNode || !sourceNode.eq(block.node)) return false;

  const transaction = state.tr;
  if (block.parent.type.name === "doc" && block.parent.childCount === 1) {
    const replacement = state.schema.nodes.paragraph?.createAndFill();
    if (!replacement) return false;
    transaction.replaceWith(block.pos, block.endPos, replacement);
    transaction.setSelection(Selection.near(transaction.doc.resolve(1)));
  } else {
    transaction.delete(block.pos, block.endPos);
    transaction.setSelection(
      Selection.near(transaction.doc.resolve(Math.min(block.pos, transaction.doc.content.size))),
    );
  }
  closeHistory(transaction);
  view.dispatch(transaction);
  return true;
}
