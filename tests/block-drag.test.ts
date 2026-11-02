import { describe, expect, test } from "bun:test";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { createMarkdownExtension } from "../app/editor/markdown-config";
import {
  calculateDropCandidate,
  deleteBlock,
  duplicateBlock,
  getBlockShift,
  moveBlock,
  moveBlockStep,
  type BlockSlot,
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

function topLevelBlock(editor: Editor, index: number): BlockTarget {
  const parent = editor.state.doc;
  let pos = 0;
  for (let current = 0; current < index; current += 1) {
    pos += parent.child(current).nodeSize;
  }
  const node = parent.child(index);
  return {
    node,
    pos,
    endPos: pos + node.nodeSize,
    parent,
    parentStart: 0,
    index,
    dom: null,
    kind: "topLevel",
  };
}

function listItemBlock(editor: Editor, list: BlockTarget, index: number): BlockTarget {
  let pos = list.pos + 1;
  for (let current = 0; current < index; current += 1) {
    pos += list.node.child(current).nodeSize;
  }
  const node = list.node.child(index);
  return {
    node,
    pos,
    endPos: pos + node.nodeSize,
    parent: list.node,
    parentStart: list.pos + 1,
    index,
    dom: null,
    kind: "listItem",
  };
}

function blockTexts(editor: Editor): string[] {
  return Array.from(
    { length: editor.state.doc.childCount },
    (_, index) => editor.state.doc.child(index).textContent,
  );
}

describe("block drag commands", () => {
  test("moves a top-level block after another block", () => {
    const editor = createTestEditor("第一段\n\n第二段\n\n第三段");
    const first = topLevelBlock(editor, 0);
    const second = topLevelBlock(editor, 1);

    expect(moveBlock(editor, first, second, "after")).not.toBeNull();
    expect(blockTexts(editor)).toEqual(["第二段", "第一段", "第三段"]);
  });

  test("moves a top-level block before an earlier block", () => {
    const editor = createTestEditor("段落A\n\n段落B\n\n段落C");
    const third = topLevelBlock(editor, 2);
    const first = topLevelBlock(editor, 0);

    expect(moveBlock(editor, third, first, "before")).not.toBeNull();
    expect(blockTexts(editor)).toEqual(["段落C", "段落A", "段落B"]);
  });

  test("rejects no-op and cross-parent moves", () => {
    const editor = createTestEditor("段落A\n\n段落B\n\n- 列表项");
    const first = topLevelBlock(editor, 0);
    const second = topLevelBlock(editor, 1);
    const list = topLevelBlock(editor, 2);
    const item = listItemBlock(editor, list, 0);
    const before = editor.getMarkdown();

    expect(moveBlock(editor, first, second, "before")).toBeNull();
    expect(moveBlock(editor, item, first, "before")).toBeNull();
    expect(moveBlock(editor, first, item, "after")).toBeNull();
    expect(editor.getMarkdown()).toBe(before);
  });

  test("moves list items within the same list and keeps nested children", () => {
    const editor = createTestEditor("- 项目1\n  - 子项\n- 项目2\n- 项目3");
    const list = topLevelBlock(editor, 0);
    const first = listItemBlock(editor, list, 0);
    const second = listItemBlock(editor, list, 1);

    expect(moveBlock(editor, first, second, "after")).not.toBeNull();
    const updatedList = editor.state.doc.child(0);
    expect(updatedList.child(0).textContent).toBe("项目2");
    expect(updatedList.child(1).textContent).toContain("项目1");
    expect(updatedList.child(1).textContent).toContain("子项");
    expect(updatedList.child(2).textContent).toBe("项目3");
  });

  test("moves ordered list items without changing the list", () => {
    const editor = createTestEditor("1. 第一项\n2. 第二项\n3. 第三项");
    const list = topLevelBlock(editor, 0);
    const first = listItemBlock(editor, list, 0);
    const third = listItemBlock(editor, list, 2);

    expect(moveBlock(editor, first, third, "after")).not.toBeNull();
    expect(editor.state.doc.child(0).type.name).toBe("orderedList");
    expect(Array.from(editor.state.doc.child(0).content.content)).toHaveLength(3);
    expect(editor.getMarkdown()).toContain("1. 第二项\n2. 第三项\n3. 第一项");
  });

  test("moves task list items and preserves their checked state", () => {
    const editor = createTestEditor("- [x] 已完成\n- [ ] 未完成");
    const list = topLevelBlock(editor, 0);
    const first = listItemBlock(editor, list, 0);
    const second = listItemBlock(editor, list, 1);

    expect(moveBlock(editor, first, second, "after")).not.toBeNull();
    const updatedList = editor.state.doc.child(0);
    expect(updatedList.type.name).toBe("taskList");
    expect(updatedList.child(0).textContent).toBe("未完成");
    expect((updatedList.child(1).attrs as { checked: boolean }).checked).toBe(true);
  });

  test("reorders nested list items without moving their parent", () => {
    const editor = createTestEditor("- 父项一\n  - 子项一\n  - 子项二\n- 父项二");
    const outer = topLevelBlock(editor, 0);
    const parent = listItemBlock(editor, outer, 0);
    const nestedIndex = parent.node.childCount - 1;
    const nestedPos =
      parent.pos +
      1 +
      Array.from({ length: nestedIndex }, (_, index) => parent.node.child(index).nodeSize).reduce(
        (sum, size) => sum + size,
        0,
      );
    const nestedNode = parent.node.child(nestedIndex);
    const nested: BlockTarget = {
      node: nestedNode,
      pos: nestedPos,
      endPos: nestedPos + nestedNode.nodeSize,
      parent: parent.node,
      parentStart: parent.pos + 1,
      index: nestedIndex,
      dom: null,
      kind: "listItem",
    };
    const first = listItemBlock(editor, nested, 0);
    const second = listItemBlock(editor, nested, 1);

    expect(moveBlock(editor, first, second, "after")).not.toBeNull();
    const updatedOuter = editor.state.doc.child(0);
    expect(updatedOuter.childCount).toBe(2);
    expect(updatedOuter.child(0).textContent).toContain("父项一");
    expect(updatedOuter.child(0).textContent).toContain("子项二");
    expect(updatedOuter.child(0).textContent).toContain("子项一");
    expect(updatedOuter.child(1).textContent).toBe("父项二");
  });

  test("moves a block step down and up", () => {
    const editor = createTestEditor("行1\n\n行2\n\n行3");

    expect(moveBlockStep(editor, topLevelBlock(editor, 0), "down")).toBe(true);
    expect(blockTexts(editor)).toEqual(["行2", "行1", "行3"]);
    expect(moveBlockStep(editor, topLevelBlock(editor, 1), "up")).toBe(true);
    expect(blockTexts(editor)).toEqual(["行1", "行2", "行3"]);
  });

  test("duplicates a block below it", () => {
    const editor = createTestEditor("首段内容\n\n尾段内容");
    expect(duplicateBlock(editor, topLevelBlock(editor, 0))).toBe(true);
    expect(blockTexts(editor)).toEqual(["首段内容", "首段内容", "尾段内容"]);
  });

  test("deletes a block and keeps the document valid when it is the last block", () => {
    const editor = createTestEditor("待删除");
    const block = topLevelBlock(editor, 0);

    expect(deleteBlock(editor, block)).toBe(true);
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.child(0).textContent).toBe("");
  });

  test("deletes the only item in a list and leaves an empty paragraph", () => {
    const editor = createTestEditor("- 唯一项目");
    const list = topLevelBlock(editor, 0);
    const item = listItemBlock(editor, list, 0);

    expect(deleteBlock(editor, item)).toBe(true);
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.child(0).type.name).toBe("paragraph");
    expect(editor.state.doc.child(0).textContent).toBe("");
  });

  test("deletes a sole list item without removing surrounding blocks", () => {
    const editor = createTestEditor("前文\n\n- 唯一项目\n\n后文");
    const list = topLevelBlock(editor, 1);
    const item = listItemBlock(editor, list, 0);

    expect(deleteBlock(editor, item)).toBe(true);
    expect(blockTexts(editor)).toEqual(["前文", "后文"]);
  });

  test("deletes a sole nested list without removing its parent item", () => {
    const editor = createTestEditor("- 父项\n  - 子项");
    const outer = topLevelBlock(editor, 0);
    const parent = listItemBlock(editor, outer, 0);
    const nestedList = parent.node.child(parent.node.childCount - 1);
    const nestedPos =
      parent.pos +
      1 +
      Array.from(
        { length: parent.node.childCount - 1 },
        (_, index) => parent.node.child(index).nodeSize,
      ).reduce((sum, size) => sum + size, 0);
    const nestedItem = listItemBlock(
      editor,
      {
        node: nestedList,
        pos: nestedPos,
        endPos: nestedPos + nestedList.nodeSize,
        parent: parent.node,
        parentStart: parent.pos + 1,
        index: parent.node.childCount - 1,
        dom: null,
        kind: "listItem",
      },
      0,
    );

    expect(deleteBlock(editor, nestedItem)).toBe(true);
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.child(0).textContent).toBe("父项");
  });
});

describe("block drag geometry", () => {
  const editor = createTestEditor("A\n\nB\n\nC");
  const blocks = [0, 1, 2].map((index) => topLevelBlock(editor, index));
  const slots: BlockSlot[] = [
    { block: blocks[0], top: 100, bottom: 120 },
    { block: blocks[1], top: 140, bottom: 160 },
    { block: blocks[2], top: 180, bottom: 200 },
  ];

  test("keeps the original slot while the pointer is over the source block", () => {
    const candidate = calculateDropCandidate(slots, 1, 150);
    expect(candidate?.noop).toBe(true);
    expect(candidate?.destinationIndex).toBe(1);
  });

  test("finds insertions above and below the source block", () => {
    expect(calculateDropCandidate(slots, 1, 90)).toMatchObject({
      gap: 0,
      destinationIndex: 0,
      noop: false,
    });
    expect(calculateDropCandidate(slots, 1, 210)).toMatchObject({
      gap: 3,
      destinationIndex: 2,
      noop: false,
    });
  });

  test("shifts only the siblings crossed by the source block", () => {
    expect([0, 1, 2].map((index) => getBlockShift(index, 0, 2, 40))).toEqual([0, -40, -40]);
    expect([0, 1, 2].map((index) => getBlockShift(index, 2, 0, 40))).toEqual([40, 40, 0]);
    expect([0, 1, 2].map((index) => getBlockShift(index, 1, 1, 40))).toEqual([0, 0, 0]);
  });

  test("keeps the current insertion edge through small pointer movements", () => {
    const initial = calculateDropCandidate(slots, 0, 150);
    expect(initial).toMatchObject({ destinationIndex: 0, noop: true });

    const nudged = calculateDropCandidate(slots, 0, 154, initial);
    expect(nudged).toMatchObject({ destinationIndex: 0, noop: true });

    const moved = calculateDropCandidate(slots, 0, 160, nudged);
    expect(moved).toMatchObject({ destinationIndex: 1, noop: false });
    expect(calculateDropCandidate(slots, 0, 153, moved)).toMatchObject({
      destinationIndex: 1,
      noop: false,
    });
    expect(calculateDropCandidate(slots, 0, 140, moved)).toMatchObject({
      destinationIndex: 0,
      noop: true,
    });
  });
});
