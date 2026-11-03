import { describe, expect, test } from "bun:test";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { createMarkdownExtension } from "../app/editor/markdown-config";
import { history, undo } from "@tiptap/pm/history";
import { EditorState, type Transaction } from "@tiptap/pm/state";
import {
  calculateDropCandidate,
  deleteBlock,
  deleteBlocks,
  duplicateBlock,
  duplicateBlocks,
  getBlockShift,
  getSelectedBlockRange,
  moveBlock,
  moveBlocks,
  moveBlockStep,
  moveBlocksStep,
  selectBlockRange,
  toDragSessionY,
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

  test("keeps block operations separate from surrounding typing in undo history", () => {
    const source = createTestEditor("A\n\nB");
    let state = EditorState.create({ doc: source.state.doc, plugins: [history()] });
    const view = {
      get state() {
        return state;
      },
      dispatch(transaction: Transaction) {
        state = state.apply(transaction);
      },
    };
    const editor = {
      get state() {
        return state;
      },
      view,
      isDestroyed: false,
    } as unknown as Editor;
    const dispatch = (transaction: Transaction) => {
      state = state.apply(transaction);
    };
    const text = () => state.doc.textBetween(0, state.doc.content.size, "|");

    dispatch(state.tr.insertText("x", 1));
    moveBlock(editor, topLevelBlock(editor, 0), topLevelBlock(editor, 1), "after");
    dispatch(state.tr.insertText("y"));

    expect(text()).toBe("B|yxA");
    undo(state, dispatch);
    expect(text()).toBe("B|xA");
    undo(state, dispatch);
    expect(text()).toBe("xA|B");
    source.destroy();
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

  test("converts scrolled and animated geometry back to stable session coordinates", () => {
    expect(toDragSessionY(100, 0)).toBe(100);
    expect(toDragSessionY(50, 50)).toBe(100);
    expect(toDragSessionY(50, 50, 20)).toBe(80);
  });

  test("calculates drop candidate and shifts for multi-block source range", () => {
    const fourSlots: BlockSlot[] = [
      { block: blocks[0], top: 100, bottom: 120 },
      { block: blocks[1], top: 130, bottom: 150 },
      { block: blocks[2], top: 160, bottom: 180 },
      { block: { ...blocks[2], index: 3, pos: 99 }, top: 190, bottom: 210 },
    ];
    const candidate = calculateDropCandidate(fourSlots, { start: 1, end: 2 }, 95);
    expect(candidate?.destinationIndex).toBe(0);
    expect(candidate?.noop).toBe(false);

    const noopCandidate = calculateDropCandidate(fourSlots, { start: 1, end: 2 }, 140);
    expect(noopCandidate?.noop).toBe(true);

    // When moving [1, 2] to index 0, block 0 shifts down by sourceSpan (+80)
    expect(getBlockShift(0, { start: 1, end: 2 }, 0, 80)).toBe(80);
    expect(getBlockShift(0, { start: 1, end: 2 }, 1, 80)).toBe(0);
    // Cross sibling downwards: block 3 shifts up by sourceSpan (-80)
    expect(getBlockShift(3, { start: 0, end: 1 }, 2, 80)).toBe(-80);
  });

  test("maintains the opened avoidance slot while dragging inside the hole and does not avoid the block above", () => {
    const sampleSlots: BlockSlot[] = [
      { block: blocks[0], top: 100, bottom: 150 },
      { block: blocks[1], top: 160, bottom: 210 },
      { block: blocks[2], top: 220, bottom: 260 },
      { block: { ...blocks[0], index: 3, pos: 300 }, top: 270, bottom: 310 },
      { block: { ...blocks[0], index: 4, pos: 400 }, top: 320, bottom: 360 },
    ];
    const sourceSpan = 100;

    // User dragged down to after slot 3:
    const movedDown = calculateDropCandidate(
      sampleSlots,
      { start: 1, end: 2 },
      315,
      null,
      sourceSpan,
    );
    expect(movedDown).toMatchObject({ destinationIndex: 2, noop: false });

    // User now moves UP inside the opened hole (pointer at 250):
    // It must stay in destinationIndex: 2 and NOT prematurely avoid the block above!
    const inHole = calculateDropCandidate(
      sampleSlots,
      { start: 1, end: 2 },
      250,
      movedDown,
      sourceSpan,
    );
    expect(inHole).toMatchObject({ destinationIndex: 2, noop: false });

    // Moving further up into slot 3's visual body (around 180):
    // Returns to the original slot
    const backInSlot = calculateDropCandidate(
      sampleSlots,
      { start: 1, end: 2 },
      180,
      inHole,
      sourceSpan,
    );
    expect(backInSlot?.noop).toBe(true);
    expect(backInSlot?.destinationIndex).toBe(1);
  });
});

describe("multi-block operations", () => {
  test("moves multiple consecutive top-level blocks downwards and upwards", () => {
    const editor = createTestEditor("段落A\n\n段落B\n\n段落C\n\n段落D\n\n段落E");
    const b0 = topLevelBlock(editor, 0);
    const b1 = topLevelBlock(editor, 1);
    const target = topLevelBlock(editor, 3); // 段落D

    expect(moveBlocks(editor, [b0, b1], target, "after")).not.toBeNull();
    expect(blockTexts(editor)).toEqual(["段落C", "段落D", "段落A", "段落B", "段落E"]);

    // Move them back up before 段落C
    const b2 = topLevelBlock(editor, 2);
    const b3 = topLevelBlock(editor, 3);
    const first = topLevelBlock(editor, 0);
    expect(moveBlocks(editor, [b2, b3], first, "before")).not.toBeNull();
    expect(blockTexts(editor)).toEqual(["段落A", "段落B", "段落C", "段落D", "段落E"]);
  });

  test("moves multiple list items within the same list", () => {
    const editor = createTestEditor("- 项1\n- 项2\n- 项3\n- 项4");
    const list = topLevelBlock(editor, 0);
    const i0 = listItemBlock(editor, list, 0);
    const i1 = listItemBlock(editor, list, 1);
    const target = listItemBlock(editor, list, 3);

    expect(moveBlocks(editor, [i0, i1], target, "after")).not.toBeNull();
    const updatedList = topLevelBlock(editor, 0);
    const itemTexts = Array.from(
      { length: updatedList.node.childCount },
      (_, i) => updatedList.node.child(i).textContent,
    );
    expect(itemTexts).toEqual(["项3", "项4", "项1", "项2"]);
  });

  test("moves multiple blocks step up and down", () => {
    const editor = createTestEditor("行1\n\n行2\n\n行3\n\n行4");
    const b1 = topLevelBlock(editor, 1);
    const b2 = topLevelBlock(editor, 2);

    expect(moveBlocksStep(editor, [b1, b2], "down")).toBe(true);
    expect(blockTexts(editor)).toEqual(["行1", "行4", "行2", "行3"]);

    const newB2 = topLevelBlock(editor, 2);
    const newB3 = topLevelBlock(editor, 3);
    expect(moveBlocksStep(editor, [newB2, newB3], "up")).toBe(true);
    expect(blockTexts(editor)).toEqual(["行1", "行2", "行3", "行4"]);
  });

  test("duplicates multiple blocks below the range", () => {
    const editor = createTestEditor("首段\n\n次段\n\n尾段");
    const b0 = topLevelBlock(editor, 0);
    const b1 = topLevelBlock(editor, 1);

    expect(duplicateBlocks(editor, [b0, b1])).toBe(true);
    expect(blockTexts(editor)).toEqual(["首段", "次段", "首段", "次段", "尾段"]);
  });

  test("deletes multiple blocks and keeps doc valid", () => {
    const editor = createTestEditor("段1\n\n段2\n\n段3\n\n段4");
    const b1 = topLevelBlock(editor, 1);
    const b2 = topLevelBlock(editor, 2);

    expect(deleteBlocks(editor, [b1, b2])).toBe(true);
    expect(blockTexts(editor)).toEqual(["段1", "段4"]);
  });

  test("selectBlockRange selects across blocks and getSelectedBlockRange resolves them", () => {
    const editor = createTestEditor("块甲\n\n块乙\n\n块丙");
    const b0 = topLevelBlock(editor, 0);
    const b1 = topLevelBlock(editor, 1);

    // When no selection, getSelectedBlockRange returns just the anchor block
    expect(getSelectedBlockRange(editor, b0)).toHaveLength(1);

    // Select range across b0 and b1
    expect(selectBlockRange(editor, b0, b1)).toBe(true);
    const selected = getSelectedBlockRange(editor, b0);
    expect(selected).toHaveLength(2);
    expect(selected[0].index).toBe(0);
    expect(selected[1].index).toBe(1);
  });
});
