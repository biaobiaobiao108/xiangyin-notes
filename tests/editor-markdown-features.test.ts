import { describe, expect, test } from "bun:test";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { Info, Table2 } from "lucide-react";
import { CalloutNode, CALLOUT_TYPES, shouldExitCalloutOnEnter } from "../app/editor/callout-node";
import { CodeBlockDoubleEnter, handleCodeBlockDoubleEnter, shouldExitCodeBlockOnEnter } from "../app/editor/code-block-enter";
import { adjustActiveTableSize, getActiveTableContext, getTableEdgeDragDelta } from "../app/editor/table-edge-commands";
import { filterSlashCommandItems, findSlashCommandMatch, getNextGroupedSlashCommandIndex, getNextSlashCommandIndex, groupSlashCommandItems, insertSlashCommand, isSlashCommandImeEscape, isSlashCommandImeEvent } from "../app/editor/slash-command-menu";
import { createTableExtensions } from "../app/editor/table-extensions";

function createMarkdownEditor(content: string) {
  return new Editor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3, 4] }, codeBlock: { exitOnTripleEnter: false } }),
      CodeBlockDoubleEnter,
      ...createTableExtensions(),
      Markdown,
      CalloutNode,
    ],
    content,
    contentType: "markdown",
  });
}

describe("GFM table markdown integration", () => {
  test("parses and serializes table headers, cells, inline formatting, and alignment", () => {
    const source = "| 名称 | 状态 |\n| :--- | ---: |\n| **阅读** | 待办 |";
    const editor = createMarkdownEditor(source);

    try {
      const table = editor.state.doc.firstChild;
      expect(table?.type.name).toBe("table");
      expect(table?.childCount).toBe(2);
      expect(table?.firstChild?.childCount).toBe(2);
      expect(table?.firstChild?.firstChild?.attrs.align).toBe("left");
      expect(table?.firstChild?.lastChild?.attrs.align).toBe("right");

      const markdown = (editor as Editor & { getMarkdown: () => string }).getMarkdown();
      expect(markdown.replace(/[ \t]+/gu, " ")).toContain("| 名称 | 状态 |");
      expect(markdown).toContain("**阅读**");
      expect(markdown).toContain(":---");
      expect(markdown).toContain("---:");

      const roundTrip = createMarkdownEditor(markdown);
      try {
        expect(roundTrip.state.doc.firstChild?.type.name).toBe("table");
        expect(roundTrip.state.doc.firstChild?.textContent).toBe(table?.textContent);
      } finally {
        roundTrip.destroy();
      }
    } finally {
      editor.destroy();
    }
  });

  test("table commands insert a header table and mutate rows and columns", () => {
    const editor = new Editor({
      extensions: [
        StarterKit.configure({ heading: { levels: [1, 2, 3, 4] } }),
        ...createTableExtensions(),
        Markdown,
        CalloutNode,
      ],
      content: { type: "doc", content: [{ type: "paragraph" }] },
    });
    try {
      expect(editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: true })).toBe(true);
      expect(editor.state.doc.firstChild?.type.name).toBe("table");
      expect(editor.commands.addRowAfter()).toBe(true);
      expect(editor.state.doc.firstChild?.childCount).toBe(3);
      expect(editor.commands.addColumnAfter()).toBe(true);
      expect(editor.state.doc.firstChild?.firstChild?.childCount).toBe(3);
      const beforeNextCell = editor.state.selection.$from.pos;
      expect(editor.commands.goToNextCell()).toBe(true);
      expect(editor.state.selection.$from.pos).not.toBe(beforeNextCell);
      expect(editor.commands.goToPreviousCell()).toBe(true);
      expect(editor.state.selection.$from.pos).toBe(beforeNextCell);
    } finally {
      editor.destroy();
    }
  });

  test("keeps each table cell to one paragraph with inline content", () => {
    const editor = createMarkdownEditor("| A |\n| --- |\n| B |");
    try {
      const cell = editor.schema.nodes.tableCell;
      const paragraph = editor.schema.nodes.paragraph;
      const heading = editor.schema.nodes.heading;
      const afterParagraph = cell.contentMatch.matchType(paragraph);

      expect(afterParagraph?.validEnd).toBe(true);
      expect(afterParagraph?.matchType(paragraph)).toBeNull();
      expect(cell.contentMatch.matchType(heading)).toBeNull();
    } finally {
      editor.destroy();
    }
  });

  test("parses and serializes H4 headings", () => {
    const editor = createMarkdownEditor("#### 四级标题");
    try {
      expect(editor.state.doc.firstChild?.type.name).toBe("heading");
      expect(editor.state.doc.firstChild?.attrs.level).toBe(4);
      expect((editor as Editor & { getMarkdown: () => string }).getMarkdown()).toBe("#### 四级标题");
    } finally {
      editor.destroy();
    }
  });
});

describe("table edge controls", () => {
  test("drag distance adds and removes edge rows or columns without crossing one", () => {
    expect(getTableEdgeDragDelta(27, 3)).toBe(0);
    expect(getTableEdgeDragDelta(28, 3)).toBe(1);
    expect(getTableEdgeDragDelta(19, 3, 20)).toBe(0);
    expect(getTableEdgeDragDelta(20, 3, 20)).toBe(1);
    expect(getTableEdgeDragDelta(84, 3)).toBe(3);
    expect(getTableEdgeDragDelta(-56, 3)).toBe(-2);
    expect(getTableEdgeDragDelta(-140, 3)).toBe(-2);
  });

  test("adjusts the far edge in a single transaction and preserves one row and column", () => {
    const editor = new Editor({
      extensions: [StarterKit.configure({ heading: { levels: [1, 2, 3, 4] } }), ...createTableExtensions(), Markdown],
      content: { type: "doc", content: [{ type: "paragraph" }] },
    });
    try {
      editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: true });
      const context = getActiveTableContext(editor);
      expect(context).not.toBeNull();
      expect(context?.rows).toBe(2);
      expect(context?.columns).toBe(2);
      expect(editor.state.doc.resolve(context!.lastCellTextPosition).parent.type.name).toBe("paragraph");

      let transactionCount = 0;
      const countTransaction = () => { transactionCount += 1; };
      editor.on("transaction", countTransaction);
      expect(adjustActiveTableSize(editor, "columns", 3)).toBe(true);
      editor.off("transaction", countTransaction);
      const tableAfterAdd = editor.state.doc.firstChild!;
      expect(tableAfterAdd.childCount).toBe(2);
      expect(tableAfterAdd.firstChild?.childCount).toBe(5);
      expect(tableAfterAdd.lastChild?.childCount).toBe(5);
      expect(transactionCount).toBe(1);

      expect(adjustActiveTableSize(editor, "columns", -20)).toBe(true);
      expect(editor.state.doc.firstChild?.firstChild?.childCount).toBe(1);
      expect(editor.state.doc.firstChild?.lastChild?.childCount).toBe(1);
      expect(adjustActiveTableSize(editor, "columns", -1)).toBe(false);

      expect(adjustActiveTableSize(editor, "rows", 2)).toBe(true);
      expect(editor.state.doc.firstChild?.childCount).toBe(4);
      expect(adjustActiveTableSize(editor, "rows", -20)).toBe(true);
      expect(editor.state.doc.firstChild?.childCount).toBe(1);
    } finally {
      editor.destroy();
    }
  });
});

describe("code block double Enter behavior", () => {
  test("exits on the second Enter at the end after removing the single empty line", () => {
    const editor = createMarkdownEditor("```ts\nconst value = 1;\n```");
    try {
      const codeBlock = editor.state.doc.firstChild!;
      editor.commands.setTextSelection(1 + codeBlock.content.size);
      expect(editor.commands.newlineInCode()).toBe(true);
      expect(editor.state.doc.firstChild?.type.name).toBe("codeBlock");
      expect(editor.state.doc.firstChild?.textContent).toBe("const value = 1;\n");
      expect(shouldExitCodeBlockOnEnter(editor.state)).toBe(true);

      expect(handleCodeBlockDoubleEnter(editor, { key: "Enter", isComposing: true, keyCode: 229 })).toBe(false);
      expect(editor.state.doc.firstChild?.textContent).toBe("const value = 1;\n");
      expect(handleCodeBlockDoubleEnter(editor, { key: "Enter", isComposing: false, keyCode: 13 })).toBe(true);
      expect(editor.state.doc.firstChild?.textContent).toBe("const value = 1;");
      expect(editor.state.doc.childCount).toBe(2);
      expect(editor.state.doc.lastChild?.type.name).toBe("paragraph");
    } finally {
      editor.destroy();
    }
  });

  test("keeps ordinary code newlines and does not exit from a non-empty selection", () => {
    const editor = createMarkdownEditor("```\nfirst\nsecond\n```");
    try {
      const codeBlock = editor.state.doc.firstChild!;
      editor.commands.setTextSelection(1 + codeBlock.content.size - 1);
      expect(shouldExitCodeBlockOnEnter(editor.state)).toBe(false);
      expect(editor.commands.newlineInCode()).toBe(true);
      expect(editor.state.doc.firstChild?.type.name).toBe("codeBlock");

      editor.commands.setTextSelection({ from: 3, to: 5 });
      expect(shouldExitCodeBlockOnEnter(editor.state)).toBe(false);
    } finally {
      editor.destroy();
    }
  });
});

describe("callout markdown integration", () => {
  test("round-trips every supported type using blockquote syntax", () => {
    for (const type of CALLOUT_TYPES) {
      const editor = createMarkdownEditor(`> [!${type}]\n> 说明正文`);
      try {
        expect(editor.state.doc.firstChild?.type.name).toBe("callout");
        expect(editor.state.doc.firstChild?.attrs.type).toBe(type);
        const markdown = (editor as Editor & { getMarkdown: () => string }).getMarkdown();
        expect(markdown).toBe(`> [!${type}]\n> 说明正文`);
        const labels: Record<(typeof CALLOUT_TYPES)[number], string> = { NOTE: "说明", TIP: "建议", IMPORTANT: "重要", WARNING: "警告", CAUTION: "注意" };
        const htmlSpec = editor.schema.nodes.callout.spec.toDOM?.(editor.state.doc.firstChild!);
        const htmlSpecText = JSON.stringify(htmlSpec);
        expect(htmlSpecText).toContain("note-callout-icon");
        expect(htmlSpecText).toContain('aria-label":"' + labels[type] + '提示块"');
        expect(htmlSpecText).not.toContain("note-callout-label");

        const roundTrip = createMarkdownEditor(markdown);
        try {
          expect(roundTrip.state.doc.firstChild?.type.name).toBe("callout");
          expect(roundTrip.state.doc.firstChild?.attrs.type).toBe(type);
          expect(roundTrip.state.doc.firstChild?.textContent).toBe("说明正文");
        } finally {
          roundTrip.destroy();
        }
      } finally {
        editor.destroy();
      }
    }
  });

  test("preserves multiple callout paragraphs and soft line breaks when saving Markdown", () => {
    const source = "> [!TIP]\n> 第一段\n> 第二行\n>\n> 第二段";
    const editor = createMarkdownEditor(source);
    try {
      const callout = editor.state.doc.firstChild;
      expect(callout?.type.name).toBe("callout");
      expect(callout?.childCount).toBe(2);
      const markdown = (editor as Editor & { getMarkdown: () => string }).getMarkdown();
      expect(markdown).toBe(source);

      const roundTrip = createMarkdownEditor(markdown);
      try {
        expect(roundTrip.state.doc.firstChild?.childCount).toBe(2);
        expect(roundTrip.state.doc.firstChild?.textContent).toContain("第一段");
        expect(roundTrip.state.doc.firstChild?.textContent).toContain("第二行");
        expect(roundTrip.state.doc.firstChild?.textContent).toContain("第二段");
      } finally {
        roundTrip.destroy();
      }
    } finally {
      editor.destroy();
    }
  });

  test("a second Enter in the final empty callout paragraph lifts it outside the callout", () => {
    const editor = createMarkdownEditor("> [!NOTE]\n> 内容");
    try {
      editor.commands.setTextSelection(5);
      expect(editor.commands.splitBlock()).toBe(true);
      expect(shouldExitCalloutOnEnter(editor.state)).toBe(true);
      expect(editor.commands.liftEmptyBlock()).toBe(true);
      expect(editor.state.doc.childCount).toBe(2);
      expect(editor.state.doc.firstChild?.type.name).toBe("callout");
      expect(editor.state.doc.lastChild?.type.name).toBe("paragraph");
    } finally {
      editor.destroy();
    }
  });

  test("keeps unknown callout markers as ordinary blockquotes", () => {
    const editor = createMarkdownEditor("> [!CUSTOM]\n> 保留原文");
    try {
      expect(editor.state.doc.firstChild?.type.name).toBe("blockquote");
      expect(editor.state.doc.textContent).toContain("[!CUSTOM]");
      expect(editor.state.doc.textContent).toContain("保留原文");
    } finally {
      editor.destroy();
    }
  });
});

describe("slash command matching", () => {
  const positionAfter = (text: string) => ({ pos: text.length, nodeBefore: { isText: true, text } } as any);

  test("inserts a table and places the cursor in its first header cell", () => {
    const editor = createMarkdownEditor("/table");
    try {
      editor.commands.setTextSelection(7);
      insertSlashCommand(editor, { from: 1, to: 7 }, {
        id: "table",
        label: "表格",
        description: "插入表格",
        keywords: [],
        icon: Table2,
        action: "table",
        group: "lists",
      });

      expect(editor.state.doc.firstChild?.type.name).toBe("table");
      expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
      expect(editor.state.selection.$from.node(-1).type.name).toBe("tableHeader");
    } finally {
      editor.destroy();
    }
  });

  test("inserts a typed callout and places the cursor in its paragraph", () => {
    const editor = createMarkdownEditor("/warning");
    try {
      editor.commands.setTextSelection(9);
      insertSlashCommand(editor, { from: 1, to: 9 }, {
        id: "callout-warning",
        label: "提示块 · 警告",
        description: "插入 WARNING 提示块",
        keywords: [],
        icon: Info,
        action: "callout",
        group: "callouts",
        calloutType: "WARNING",
      });

      expect(editor.state.doc.firstChild?.type.name).toBe("callout");
      expect(editor.state.doc.firstChild?.attrs.type).toBe("WARNING");
      expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
      expect(editor.state.selection.$from.node(-1).type.name).toBe("callout");
    } finally {
      editor.destroy();
    }
  });

  test("matches a slash command at paragraph start and after whitespace", () => {
    expect(findSlashCommandMatch({ $position: positionAfter("/表格") })).toEqual({ range: { from: 0, to: 3 }, query: "表格", text: "/表格" });
    expect(findSlashCommandMatch({ $position: positionAfter("正文 /任务 清单") })).toEqual({ range: { from: 3, to: 9 }, query: "任务 清单", text: "/任务 清单" });
  });

  test("typing /一级 and pressing Enter applies the exact H1 suggestion directly", () => {
    const editor = createMarkdownEditor("/一级");
    try {
      const matches = filterSlashCommandItems("一级");
      expect(matches.map((item) => item.id)).toEqual(["heading-1"]);
      editor.commands.setTextSelection(4);
      insertSlashCommand(editor, { from: 1, to: 4 }, matches[0]);
      expect(editor.state.doc.firstChild?.type.name).toBe("heading");
      expect(editor.state.doc.firstChild?.attrs.level).toBe(1);
      expect(editor.state.selection.$from.parent.type.name).toBe("heading");
    } finally {
      editor.destroy();
    }
  });

  test("bare slash opens four command groups and uses two/four-column spatial navigation", () => {
    const groups = groupSlashCommandItems(filterSlashCommandItems(""));
    expect(groups.map((group) => group.id)).toEqual(["text", "lists", "callouts", "insert"]);
    expect(groups.map((group) => group.items.length)).toEqual([8, 4, 5, 2]);
    expect(groups.flatMap((group) => group.items).some((item) => item.id === "table")).toBe(true);

    const itemGroups = groups.map((group) => group.items);
    expect(getNextGroupedSlashCommandIndex(0, "ArrowDown", itemGroups, 4)).toBe(1);
    expect(getNextGroupedSlashCommandIndex(0, "ArrowRight", itemGroups, 4)).toBe(8);
    expect(getNextGroupedSlashCommandIndex(8, "ArrowRight", itemGroups, 4)).toBe(12);
    expect(getNextGroupedSlashCommandIndex(0, "ArrowRight", itemGroups, 2)).toBe(8);
    expect(getNextGroupedSlashCommandIndex(8, "ArrowDown", itemGroups, 2)).toBe(9);
    expect(getNextGroupedSlashCommandIndex(11, "ArrowDown", itemGroups, 2)).toBe(17);
  });

  test("suggestion mode keyboard movement is a compact single column", () => {
    expect(getNextSlashCommandIndex(0, "ArrowDown", 3, 1)).toBe(1);
    expect(getNextSlashCommandIndex(2, "ArrowDown", 3, 1)).toBe(0);
    expect(getNextSlashCommandIndex(1, "ArrowUp", 3, 1)).toBe(0);
  });

  test("does not match slash inside a word or an escaped slash", () => {
    expect(findSlashCommandMatch({ $position: positionAfter("path/to") })).toBeNull();
    expect(findSlashCommandMatch({ $position: positionAfter("正文 \\/表格") })).toBeNull();
    expect(findSlashCommandMatch({
      $position: {
        pos: 7,
        parentOffset: 7,
        parent: { textBetween: () => "正文/path" },
        nodeBefore: { isText: true, text: "/path" },
      },
    })).toBeNull();
  });

  test("does not intercept Chinese input method candidate keys", () => {
    expect(isSlashCommandImeEvent({ isComposing: true, keyCode: 27 })).toBe(true);
    expect(isSlashCommandImeEvent({ isComposing: false, keyCode: 229 })).toBe(true);
    expect(isSlashCommandImeEvent({ isComposing: false, keyCode: 13 })).toBe(false);
    expect(isSlashCommandImeEscape({ isComposing: true, key: "Escape" })).toBe(true);
    expect(isSlashCommandImeEscape({ isComposing: false, keyCode: 27, key: "Escape" })).toBe(false);
  });
});
