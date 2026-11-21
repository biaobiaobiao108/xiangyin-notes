import { describe, expect, test } from "bun:test";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { history, redo, redoDepth, undo, undoDepth } from "@tiptap/pm/history";
import { createMarkdownExtension } from "../app/editor/markdown-config";
import { replaceEditorMarkdown } from "../app/editor/document-content";
import { createCommonEditorExtensions } from "../app/editor/common-extensions";

describe("loading editor documents", () => {
  test("isolates Markdown tokenizers even when editors reuse their extensions", () => {
    const extensions = createCommonEditorExtensions();
    const content = [
      "## 示例",
      "",
      "- [ ] 待办",
      "  - [x] 子任务",
      "",
      "| 样例 | 值 |",
      "| --- | --- |",
      "| `a|b` | 1 |",
      "",
      "尾部正文",
    ].join("\n");
    const first = new Editor({ element: null, extensions, content, contentType: "markdown" });
    const second = new Editor({ element: null, extensions, content, contentType: "markdown" });
    try {
      expect(second.markdown!.instance).not.toBe(first.markdown!.instance);
      const doc = second.state.doc;
      expect(second.getJSON()).toEqual(first.getJSON());
      expect(doc.child(1).type.name).toBe("taskList");
      expect(doc.child(1).firstChild?.lastChild?.type.name).toBe("taskList");
      expect(doc.child(2).type.name).toBe("table");
      expect(doc.child(2).lastChild?.firstChild?.textContent).toBe("a|b");
      expect(doc.lastChild?.textContent).toBe("尾部正文");
    } finally {
      first.destroy();
      second.destroy();
    }
  });

  test("isolates undo and redo across note switches and remote reloads", () => {
    let updates = 0;
    const editor = new Editor({
      element: null,
      extensions: [StarterKit, createMarkdownExtension()],
      content: "Note A",
      contentType: "markdown",
      onUpdate: () => {
        updates += 1;
      },
    });
    // Headless editors do not mount extension plugins automatically.
    editor.registerPlugin(history());
    const dispatch = (transaction: Parameters<typeof editor.view.dispatch>[0]) =>
      editor.view.dispatch(transaction);
    try {
      dispatch(editor.state.tr.insertText("edited "));
      expect(undoDepth(editor.state)).toBe(1);
      const updatesBeforeLoad = updates;
      replaceEditorMarkdown(editor, "Note **B**");
      expect(editor.state.doc.textContent).toBe("Note B");
      expect(undoDepth(editor.state)).toBe(0);
      expect(redoDepth(editor.state)).toBe(0);
      expect(undo(editor.state, dispatch)).toBe(false);
      expect(updates).toBe(updatesBeforeLoad);

      dispatch(editor.state.tr.insertText("local "));
      expect(undo(editor.state, dispatch)).toBe(true);
      expect(editor.state.doc.textContent).toBe("Note B");
      expect(redoDepth(editor.state)).toBe(1);

      replaceEditorMarkdown(editor, "Remote B");
      expect(undo(editor.state, dispatch)).toBe(false);
      expect(redo(editor.state, dispatch)).toBe(false);
      expect(editor.state.doc.textContent).toBe("Remote B");
      dispatch(editor.state.tr.insertText("new "));
      expect(undo(editor.state, dispatch)).toBe(true);
      expect(editor.state.doc.textContent).toBe("Remote B");

      replaceEditorMarkdown(editor, "");
      expect(() => editor.state.doc.check()).not.toThrow();
      expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
      expect(undo(editor.state, dispatch)).toBe(false);
    } finally {
      editor.destroy();
    }
  });
});
