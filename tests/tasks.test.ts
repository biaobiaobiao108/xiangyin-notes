import { describe, expect, test } from "bun:test";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { extractMarkdownTasks } from "../shared/tasks";
import { createMarkdownExtension } from "../app/editor/markdown-config";

describe("Markdown task extraction", () => {
  test("keeps document order, completion state and plain task text", () => {
    const markdown = [
      "# Plan",
      "- [ ] **Draft** the [proposal](https://example.com)",
      "  - [x] Ask `Mina`",
      "- [ ] Repeat",
      "- [ ] Repeat",
    ].join("\n");

    expect(extractMarkdownTasks(markdown)).toEqual([
      {
        text: "Draft the proposal",
        completed: false,
        ordinal: 0,
      },
      {
        text: "Ask Mina",
        completed: true,
        ordinal: 1,
      },
      {
        text: "Repeat",
        completed: false,
        ordinal: 2,
      },
      {
        text: "Repeat",
        completed: false,
        ordinal: 3,
      },
    ]);
  });

  test("preserves nested task order inside blockquotes", () => {
    expect(
      extractMarkdownTasks("> - [ ] quoted parent\n>   - [x] quoted child\n- [ ] outside"),
    ).toEqual([
      { text: "quoted parent", completed: false, ordinal: 0 },
      { text: "quoted child", completed: true, ordinal: 1 },
      { text: "outside", completed: false, ordinal: 2 },
    ]);
  });

  test("plain task text matches the configured Tiptap Markdown parser", () => {
    const markdown = "- [ ] A &amp; B, &lt; C, &quot;D&quot;, &amp;lt;";
    const editor = new Editor({
      element: null,
      extensions: [
        StarterKit,
        TaskList,
        TaskItem.configure({ nested: true }),
        createMarkdownExtension(),
      ],
      content: markdown,
      contentType: "markdown",
    });
    try {
      const task = extractMarkdownTasks(markdown)[0];
      let editorTaskText = "";
      editor.state.doc.descendants((node) => {
        if (node.type.name === "taskItem") editorTaskText = node.firstChild?.textContent ?? "";
      });
      expect(task?.text).toBe(editorTaskText);
      expect(task?.text).toBe('A & B, < C, "D", &lt;');
    } finally {
      editor.destroy();
    }
  });

  test("does not treat fenced or indented code examples as tasks", () => {
    expect(
      extractMarkdownTasks("```md\n- [ ] fenced\n```\n\n    - [ ] indented\n\n- [ ] real"),
    ).toEqual([{ text: "real", completed: false, ordinal: 0 }]);
  });
});
