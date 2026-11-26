import { describe, expect, test } from "bun:test";
import { Editor } from "@tiptap/core";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import StarterKit from "@tiptap/starter-kit";
import {
  executeBlockShortcutAtSelection,
  handleMarkdownBlockShortcutInput,
} from "../app/editor/markdown-shortcuts";
import { normalizeChineseMarkdownBlockMarkers } from "../app/editor-metrics";
import { createMemoEditorExtensions } from "../app/memos/memo-composer";

function createEditor(text: string) {
  return new Editor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] } }),
      TaskList,
      TaskItem.configure({ nested: true }),
    ],
    content: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    },
  });
}

function createMemoEditor(text: string) {
  return new Editor({
    extensions: createMemoEditorExtensions(),
    content: {
      type: "doc",
      content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : [] }],
    },
  });
}

function expectNoTrailingNode(editor: Editor) {
  expect(
    editor.extensionManager.extensions.some((extension) => extension.name === "trailingNode"),
  ).toBe(false);
}

describe("Markdown shortcuts committed by an input method", () => {
  test("converts a full-width task marker from the selection after composition", () => {
    const marker = "【\u3000】\u3000";
    const editor = createEditor(marker);
    try {
      editor.commands.setTextSelection(marker.length + 1);
      expect(executeBlockShortcutAtSelection(editor.view)).toBe(true);
      expect(editor.state.doc.firstChild?.type.name).toBe("taskList");
      expect(editor.state.doc.firstChild?.firstChild?.type.name).toBe("taskItem");
    } finally {
      editor.destroy();
    }
  });
});

describe("Markdown block shortcuts typed in the editor", () => {
  test.each([
    ["＃", " ", "heading", 1],
    ["＃＃＃", " ", "heading", 3],
    ["－", " ", "bulletList", null],
    ["１．", " ", "orderedList", null],
    ["＞", " ", "blockquote", null],
    ["》", "\u3000", "blockquote", null],
    ["〉", " ", "blockquote", null],
    ["｀｀｀", " ", "codeBlock", null],
    ["【】", " ", "taskList", null],
    ["【 】", "\u3000", "taskList", null],
    ["【\u3000】", " ", "taskList", null],
  ])("converts the Chinese block marker %s", (marker, separator, expectedType, headingLevel) => {
    const editor = createMemoEditor(marker);
    try {
      expectNoTrailingNode(editor);
      const cursor = marker.length + 1;
      editor.commands.setTextSelection(cursor);
      expect(handleMarkdownBlockShortcutInput(editor.view, cursor, cursor, separator)).toBe(true);
      expect(editor.state.doc.firstChild?.type.name).toBe(expectedType);
      if (headingLevel !== null)
        expect(editor.state.doc.firstChild?.attrs.level).toBe(headingLevel);
    } finally {
      editor.destroy();
    }
  });

  test("parses and serializes UUID wiki links through the memo editor extensions", () => {
    const editor = new Editor({
      extensions: createMemoEditorExtensions(),
      content:
        "参考 [[11111111-1111-4111-8111-111111111111|目标笔记]] 与 [[22222222-2222-4222-8222-222222222222|其他笔记|显示别名]]",
      contentType: "markdown",
    });
    try {
      const wikiLinks: Array<{ target: string; alias: string | null }> = [];
      editor.state.doc.descendants((node) => {
        if (node.type.name === "wikiLink")
          wikiLinks.push({
            target: node.attrs.target as string,
            alias: node.attrs.alias as string | null,
          });
      });
      expect(wikiLinks).toEqual([
        { target: "11111111-1111-4111-8111-111111111111", alias: null },
        { target: "22222222-2222-4222-8222-222222222222", alias: "显示别名" },
      ]);
      expect((editor as Editor & { getMarkdown: () => string }).getMarkdown()).toBe(
        "参考 [[11111111-1111-4111-8111-111111111111|目标笔记]] 与 [[22222222-2222-4222-8222-222222222222|其他笔记|显示别名]]",
      );
    } finally {
      editor.destroy();
    }
  });

  test("parses Chinese block markers pasted into the memo editor", () => {
    const source =
      "＃ 标题\n\n－ 列表\n\n１． 有序列表\n\n＞ 引用\n\n【】 待办\n\n｀｀｀\n代码\n｀｀｀";
    const editor = new Editor({
      extensions: createMemoEditorExtensions(),
      content: normalizeChineseMarkdownBlockMarkers(source),
      contentType: "markdown",
    });
    try {
      expect(
        Array.from(
          { length: editor.state.doc.childCount },
          (_, index) => editor.state.doc.child(index).type.name,
        ),
      ).toEqual(["heading", "bulletList", "orderedList", "blockquote", "taskList", "codeBlock"]);
    } finally {
      editor.destroy();
    }
  });

  test("keeps CJK bold and italic parsing on the memo editor path", () => {
    const editor = new Editor({
      extensions: createMemoEditorExtensions(),
      content: "**判断：**已知人物，前文_斜体_，后续",
      contentType: "markdown",
    });
    try {
      const marks: string[] = [];
      editor.state.doc.descendants((node) => {
        for (const mark of node.marks) marks.push(`${mark.type.name}:${node.text ?? ""}`);
      });
      expect(marks).toContain("bold:判断：");
      expect(marks).toContain("italic:斜体");
      expect((editor as Editor & { getMarkdown: () => string }).getMarkdown()).toBe(
        "**判断：**已知人物，前文*斜体*，后续",
      );
    } finally {
      editor.destroy();
    }
  });

  test("does not convert while an input method is composing", () => {
    const editor = createMemoEditor("【】");
    try {
      expectNoTrailingNode(editor);
      const cursor = 4;
      editor.commands.setTextSelection(cursor);
      expect(handleMarkdownBlockShortcutInput(editor.view, cursor, cursor, " ", true)).toBe(false);
      expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
    } finally {
      editor.destroy();
    }
  });
});
