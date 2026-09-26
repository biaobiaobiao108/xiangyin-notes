import { describe, expect, test } from "bun:test";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { Info, Table2 } from "lucide-react";
import { CalloutNode, CALLOUT_TYPES } from "../app/editor/callout-node";
import { findSlashCommandMatch, insertSlashCommand, isSlashCommandImeEscape, isSlashCommandImeEvent } from "../app/editor/slash-command-menu";
import { createTableExtensions } from "../app/editor/table-extensions";

function createMarkdownEditor(content: string) {
  return new Editor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
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
        StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
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
