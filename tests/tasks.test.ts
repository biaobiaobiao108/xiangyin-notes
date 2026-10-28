import { describe, expect, test } from "bun:test";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { extractMarkdownTasks, findMarkdownTaskMarker } from "../shared/tasks";
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

  test("locates the parsed task when fake and real marker counts can cancel out", () => {
    const markdown = [
      "```md",
      "- [ ] target",
      "```",
      "> ```md",
      "> - [ ] target",
      "> ```",
      "- [ ] parent",
      "    - [ ] target",
      "- [ ] tail",
    ].join("\n");
    const tasks = extractMarkdownTasks(markdown);
    expect(tasks.map(({ text, ordinal }) => ({ text, ordinal }))).toEqual([
      { text: "parent", ordinal: 0 },
      { text: "target", ordinal: 1 },
      { text: "tail", ordinal: 2 },
    ]);
    const marker = findMarkdownTaskMarker(markdown, 1);
    expect(marker).not.toBeNull();
    const updated = markdown.slice(0, marker!.start) + "[x]" + markdown.slice(marker!.end);
    expect(extractMarkdownTasks(updated).map((task) => task.completed)).toEqual([
      false,
      true,
      false,
    ]);
    expect(updated).toContain("> - [ ] target");
    expect(updated).toContain("    - [x] target");
  });

  test("locates tasks inside blockquotes while ignoring quoted fences", () => {
    const markdown = "> ```md\n> - [ ] fake\n> ```\n> - [x] real";
    const marker = findMarkdownTaskMarker(markdown, 0);
    expect(marker).not.toBeNull();
    expect(marker?.checked).toBe(true);
    const updated = markdown.slice(0, marker!.start) + "[ ]" + markdown.slice(marker!.end);
    expect(extractMarkdownTasks(updated)).toEqual([{ text: "real", completed: false, ordinal: 0 }]);
    expect(updated).toContain("> - [ ] fake");
  });
});
