import { describe, expect, test } from "bun:test";
import { Editor } from "@tiptap/core";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import StarterKit from "@tiptap/starter-kit";
import { executeBlockShortcutAtSelection } from "../app/editor/markdown-shortcuts";

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
