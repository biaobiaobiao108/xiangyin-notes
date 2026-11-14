import { describe, expect, test } from "bun:test";
import { Editor } from "@tiptap/core";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import StarterKit from "@tiptap/starter-kit";
import {
  executeBlockShortcutAtSelection,
  handleMarkdownBlockShortcutInput,
} from "../app/editor/markdown-shortcuts";

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
  test.each([["【】"], ["【 】"], ["【\u3000】"]])(
    "converts %s followed by a space into a task list",
    (marker) => {
      const editor = createEditor(marker);
      try {
        const cursor = marker.length + 1;
        editor.commands.setTextSelection(cursor);
        expect(handleMarkdownBlockShortcutInput(editor.view, cursor, cursor, " ")).toBe(true);
        expect(editor.state.doc.firstChild?.type.name).toBe("taskList");
        expect(editor.state.doc.firstChild?.firstChild?.type.name).toBe("taskItem");
      } finally {
        editor.destroy();
      }
    },
  );

  test("does not convert while an input method is composing", () => {
    const editor = createEditor("【】");
    try {
      const cursor = 4;
      editor.commands.setTextSelection(cursor);
      expect(handleMarkdownBlockShortcutInput(editor.view, cursor, cursor, " ", true)).toBe(false);
      expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
    } finally {
      editor.destroy();
    }
  });
});
