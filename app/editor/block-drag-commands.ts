import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Selection } from "@tiptap/pm/state";

export type BlockTarget = {
  node: ProseMirrorNode;
  pos: number;
  endPos: number;
  dom: HTMLElement | null;
  depth: number;
  isListItem: boolean;
};

export type DropPlacement = "before" | "after";

export type DropTargetInfo = {
  block: BlockTarget;
  placement: DropPlacement;
  indicatorY: number;
};

/**
 * Resolves the draggable block from a DOM node inside the editor view.
 */
export function getDraggableBlockFromElement(
  editor: Editor,
  targetElement: HTMLElement,
): BlockTarget | null {
  const editorDom = editor.view.dom;
  if (!editorDom.contains(targetElement) || targetElement === editorDom) {
    return null;
  }

  // Check if target is inside a list item first (for item-level dragging)
  const listItemDom = targetElement.closest<HTMLElement>(
    "li[data-type='taskItem'], li, .task-list-item",
  );
  if (listItemDom && editorDom.contains(listItemDom)) {
    try {
      const pos = editor.view.posAtDOM(listItemDom, 0);
      const $pos = editor.state.doc.resolve(pos);
      for (let depth = $pos.depth; depth > 0; depth -= 1) {
        const node = $pos.node(depth);
        if (node.type.name === "listItem" || node.type.name === "taskItem") {
          const blockPos = $pos.before(depth);
          return {
            node,
            pos: blockPos,
            endPos: $pos.after(depth),
            dom: listItemDom,
            depth,
            isListItem: true,
          };
        }
      }
    } catch {
      // fallback to top-level block
    }
  }

  // Otherwise, find the direct top-level block (depth = 1)
  let current: HTMLElement | null = targetElement;
  while (current && current.parentElement && current.parentElement !== editorDom) {
    current = current.parentElement;
  }
  if (!current || current.parentElement !== editorDom) {
    return null;
  }

  try {
    const pos = editor.view.posAtDOM(current, 0);
    const $pos = editor.state.doc.resolve(pos);
    if ($pos.depth >= 1) {
      const node = $pos.node(1);
      const blockPos = $pos.before(1);
      return {
        node,
        pos: blockPos,
        endPos: $pos.after(1),
        dom: current,
        depth: 1,
        isListItem: false,
      };
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Resolves the block target at a given viewport coordinate (x, y).
 */
export function getDraggableBlockAtCoords(
  editor: Editor,
  coords: { x: number; y: number },
): BlockTarget | null {
  const element = document.elementFromPoint(coords.x, coords.y);
  if (element instanceof HTMLElement) {
    const block = getDraggableBlockFromElement(editor, element);
    if (block) return block;
  }

  const posInfo = editor.view.posAtCoords({ left: coords.x, top: coords.y });
  if (!posInfo) return null;

  try {
    const $pos = editor.state.doc.resolve(posInfo.pos);
    // Check list item
    for (let depth = $pos.depth; depth > 0; depth -= 1) {
      const node = $pos.node(depth);
      if (node.type.name === "listItem" || node.type.name === "taskItem") {
        const blockPos = $pos.before(depth);
        const dom = editor.view.nodeDOM(blockPos);
        if (dom instanceof HTMLElement) {
          return {
            node,
            pos: blockPos,
            endPos: $pos.after(depth),
            dom,
            depth,
            isListItem: true,
          };
        }
      }
    }

    if ($pos.depth >= 1) {
      const node = $pos.node(1);
      const blockPos = $pos.before(1);
      const dom = editor.view.nodeDOM(blockPos);
      if (dom instanceof HTMLElement) {
        return {
          node,
          pos: blockPos,
          endPos: $pos.after(1),
          dom,
          depth: 1,
          isListItem: false,
        };
      }
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Calculates drop target placement (before or after) and indicator line coordinate.
 */
export function calculateDropTarget(targetBlock: BlockTarget, pointerY: number): DropTargetInfo {
  const rect = targetBlock.dom?.getBoundingClientRect() ?? {
    top: 0,
    bottom: 0,
    height: 0,
    left: 0,
    right: 0,
    width: 0,
  };
  const middleY = rect.top + rect.height / 2;
  const placement: DropPlacement = pointerY < middleY ? "before" : "after";
  const indicatorY = placement === "before" ? rect.top : rect.bottom;

  return {
    block: targetBlock,
    placement,
    indicatorY,
  };
}

/**
 * Moves a source block to before or after a target block within a transaction.
 */
export function moveBlock(
  editor: Editor,
  source: BlockTarget,
  target: BlockTarget,
  placement: DropPlacement,
): boolean {
  if (source.pos === target.pos) return false;

  const { state, view } = editor;
  const { tr } = state;

  // Verify positions are still valid and node matches
  const currentSourceNode = tr.doc.nodeAt(source.pos);
  if (!currentSourceNode || currentSourceNode.type !== source.node.type) {
    return false;
  }

  const rawTargetInsertPos = placement === "before" ? target.pos : target.endPos;
  const slice = state.doc.slice(source.pos, source.endPos);

  // Delete source block
  tr.delete(source.pos, source.endPos);

  // Map insertion position after deletion
  const mappedInsertPos = tr.mapping.map(rawTargetInsertPos);

  try {
    const $insert = tr.doc.resolve(mappedInsertPos);
    const parent = $insert.parent;
    const index = $insert.index();

    if (parent.canReplaceWith(index, index, source.node.type)) {
      tr.insert(mappedInsertPos, source.node);
      const newSelectionPos = Math.min(mappedInsertPos + 1, tr.doc.content.size);
      tr.setSelection(Selection.near(tr.doc.resolve(newSelectionPos)));
      view.dispatch(tr.scrollIntoView());
      return true;
    }

    // Fallback: replace with slice content
    tr.replaceWith(mappedInsertPos, mappedInsertPos, slice.content);
    view.dispatch(tr.scrollIntoView());
    return true;
  } catch {
    return false;
  }
}

/**
 * Duplicates the specified block immediately below it.
 */
export function duplicateBlock(editor: Editor, block: BlockTarget): boolean {
  const { state, view } = editor;
  const { tr } = state;
  const clone = block.node.copy(block.node.content);

  try {
    tr.insert(block.endPos, clone);
    const targetSelectionPos = Math.min(block.endPos + 1, tr.doc.content.size);
    tr.setSelection(Selection.near(tr.doc.resolve(targetSelectionPos)));
    view.dispatch(tr.scrollIntoView());
    return true;
  } catch {
    return false;
  }
}

/**
 * Moves a block one step up or down relative to its siblings.
 */
export function moveBlockStep(
  editor: Editor,
  block: BlockTarget,
  direction: "up" | "down",
): boolean {
  const { state, view } = editor;
  const $pos = state.doc.resolve(block.pos);
  const parent = $pos.parent;
  const index = $pos.index();

  if (direction === "up") {
    if (index === 0) return false;
    const prevSibling = parent.child(index - 1);
    const prevPos = block.pos - prevSibling.nodeSize;
    let prevDom: HTMLElement | null = null;
    try {
      const nodeDom = view.nodeDOM(prevPos);
      if (nodeDom instanceof HTMLElement) prevDom = nodeDom;
    } catch {
      // headless environment
    }

    return moveBlock(
      editor,
      block,
      {
        node: prevSibling,
        pos: prevPos,
        endPos: block.pos,
        dom: prevDom ?? block.dom,
        depth: block.depth,
        isListItem: block.isListItem,
      },
      "before",
    );
  }

  if (direction === "down") {
    if (index >= parent.childCount - 1) return false;
    const nextSibling = parent.child(index + 1);
    const nextPos = block.endPos;
    const nextEndPos = nextPos + nextSibling.nodeSize;
    let nextDom: HTMLElement | null = null;
    try {
      const nodeDom = view.nodeDOM(nextPos);
      if (nodeDom instanceof HTMLElement) nextDom = nodeDom;
    } catch {
      // headless environment
    }

    return moveBlock(
      editor,
      block,
      {
        node: nextSibling,
        pos: nextPos,
        endPos: nextEndPos,
        dom: nextDom ?? block.dom,
        depth: block.depth,
        isListItem: block.isListItem,
      },
      "after",
    );
  }

  return false;
}

/**
 * Deletes the specified block.
 */
export function deleteBlock(editor: Editor, block: BlockTarget): boolean {
  const { state, view } = editor;
  const { tr } = state;

  tr.delete(block.pos, block.endPos);
  const targetPos = Math.min(block.pos, tr.doc.content.size);
  tr.setSelection(Selection.near(tr.doc.resolve(targetPos)));
  view.dispatch(tr.scrollIntoView());
  return true;
}
