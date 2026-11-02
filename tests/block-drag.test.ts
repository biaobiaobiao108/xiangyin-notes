import { describe, expect, test } from "bun:test";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { createMarkdownExtension } from "../app/editor/markdown-config";
import {
  calculateDropTarget,
  deleteBlock,
  duplicateBlock,
  getDraggableBlockFromElement,
  moveBlock,
  moveBlockStep,
  type BlockTarget,
} from "../app/editor/block-drag-commands";

function createTestEditor(content: string) {
  return new Editor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4, 5, 6] },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      createMarkdownExtension(),
    ],
    content,
    contentType: "markdown",
  });
}

describe("block drag and drop commands", () => {
  test("moves a top-level block after another top-level block", () => {
    const editor = createTestEditor("第一段\n\n第二段\n\n第三段");
    const doc = editor.state.doc;
    expect(doc.childCount).toBe(3);

    const firstNode = doc.child(0);
    const secondNode = doc.child(1);

    const sourceBlock: BlockTarget = {
      node: firstNode,
      pos: 0,
      endPos: firstNode.nodeSize,
      dom: null,
      depth: 1,
      isListItem: false,
    };

    const targetBlock: BlockTarget = {
      node: secondNode,
      pos: firstNode.nodeSize,
      endPos: firstNode.nodeSize + secondNode.nodeSize,
      dom: null,
      depth: 1,
      isListItem: false,
    };

    const success = moveBlock(editor, sourceBlock, targetBlock, "after");
    expect(success).toBe(true);

    const updatedDoc = editor.state.doc;
    expect(updatedDoc.child(0).textContent).toBe("第二段");
    expect(updatedDoc.child(1).textContent).toBe("第一段");
    expect(updatedDoc.child(2).textContent).toBe("第三段");
  });

  test("moves a top-level block before another top-level block", () => {
    const editor = createTestEditor("段落A\n\n段落B\n\n段落C");
    const doc = editor.state.doc;
    const thirdNode = doc.child(2);
    const firstNode = doc.child(0);

    const sourcePos = doc.child(0).nodeSize + doc.child(1).nodeSize;
    const sourceBlock: BlockTarget = {
      node: thirdNode,
      pos: sourcePos,
      endPos: sourcePos + thirdNode.nodeSize,
      dom: null,
      depth: 1,
      isListItem: false,
    };

    const targetBlock: BlockTarget = {
      node: firstNode,
      pos: 0,
      endPos: firstNode.nodeSize,
      dom: null,
      depth: 1,
      isListItem: false,
    };

    const success = moveBlock(editor, sourceBlock, targetBlock, "before");
    expect(success).toBe(true);

    const updatedDoc = editor.state.doc;
    expect(updatedDoc.child(0).textContent).toBe("段落C");
    expect(updatedDoc.child(1).textContent).toBe("段落A");
    expect(updatedDoc.child(2).textContent).toBe("段落B");
  });

  test("duplicates a block below it", () => {
    const editor = createTestEditor("首段内容\n\n尾段内容");
    const doc = editor.state.doc;
    const firstNode = doc.child(0);

    const block: BlockTarget = {
      node: firstNode,
      pos: 0,
      endPos: firstNode.nodeSize,
      dom: null,
      depth: 1,
      isListItem: false,
    };

    const success = duplicateBlock(editor, block);
    expect(success).toBe(true);

    const updatedDoc = editor.state.doc;
    expect(updatedDoc.childCount).toBe(3);
    expect(updatedDoc.child(0).textContent).toBe("首段内容");
    expect(updatedDoc.child(1).textContent).toBe("首段内容");
    expect(updatedDoc.child(2).textContent).toBe("尾段内容");
  });

  test("moves a block step down and up", () => {
    const editor = createTestEditor("行1\n\n行2\n\n行3");
    const doc = editor.state.doc;
    const firstNode = doc.child(0);

    const block: BlockTarget = {
      node: firstNode,
      pos: 0,
      endPos: firstNode.nodeSize,
      dom: null,
      depth: 1,
      isListItem: false,
    };

    // Move down
    const movedDown = moveBlockStep(editor, block, "down");
    expect(movedDown).toBe(true);
    expect(editor.state.doc.child(0).textContent).toBe("行2");
    expect(editor.state.doc.child(1).textContent).toBe("行1");

    // Move up
    const reloadedDoc = editor.state.doc;
    const secondNode = reloadedDoc.child(1);
    const movedBlock: BlockTarget = {
      node: secondNode,
      pos: reloadedDoc.child(0).nodeSize,
      endPos: reloadedDoc.child(0).nodeSize + secondNode.nodeSize,
      dom: null,
      depth: 1,
      isListItem: false,
    };
    const movedUp = moveBlockStep(editor, movedBlock, "up");
    expect(movedUp).toBe(true);
    expect(editor.state.doc.child(0).textContent).toBe("行1");
    expect(editor.state.doc.child(1).textContent).toBe("行2");
  });

  test("deletes a block", () => {
    const editor = createTestEditor("待删除\n\n保留项");
    const doc = editor.state.doc;
    const firstNode = doc.child(0);

    const block: BlockTarget = {
      node: firstNode,
      pos: 0,
      endPos: firstNode.nodeSize,
      dom: null,
      depth: 1,
      isListItem: false,
    };

    const success = deleteBlock(editor, block);
    expect(success).toBe(true);
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.child(0).textContent).toBe("保留项");
  });

  test("calculates drop target indicator correctly", () => {
    const fakeDom = {
      getBoundingClientRect: () => ({
        top: 100,
        bottom: 140,
        height: 40,
        left: 20,
        right: 200,
        width: 180,
      }),
    } as unknown as HTMLElement;

    const block: BlockTarget = {
      node: null as any,
      pos: 0,
      endPos: 10,
      dom: fakeDom,
      depth: 1,
      isListItem: false,
    };

    // Pointer above middle (middle is 120)
    const targetTop = calculateDropTarget(block, 110);
    expect(targetTop.placement).toBe("before");
    expect(targetTop.indicatorY).toBe(100);

    // Pointer below middle
    const targetBottom = calculateDropTarget(block, 130);
    expect(targetBottom.placement).toBe("after");
    expect(targetBottom.indicatorY).toBe(140);
  });

  test("moves a list item within a list", () => {
    const editor = createTestEditor("- 项目1\n- 项目2\n- 项目3");
    const doc = editor.state.doc;
    const listNode = doc.child(0);
    expect(listNode.childCount).toBe(3);

    // First item is at pos 1 inside the bulletList
    const item1 = listNode.child(0);
    const item2 = listNode.child(1);

    const sourceItem: BlockTarget = {
      node: item1,
      pos: 1,
      endPos: 1 + item1.nodeSize,
      dom: null,
      depth: 2,
      isListItem: true,
    };

    const targetItem: BlockTarget = {
      node: item2,
      pos: 1 + item1.nodeSize,
      endPos: 1 + item1.nodeSize + item2.nodeSize,
      dom: null,
      depth: 2,
      isListItem: true,
    };

    const moved = moveBlock(editor, sourceItem, targetItem, "after");
    expect(moved).toBe(true);

    const updatedList = editor.state.doc.child(0);
    expect(updatedList.child(0).textContent).toBe("项目2");
    expect(updatedList.child(1).textContent).toBe("项目1");
    expect(updatedList.child(2).textContent).toBe("项目3");
  });
});
