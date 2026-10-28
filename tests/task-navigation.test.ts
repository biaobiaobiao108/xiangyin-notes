import { describe, expect, test } from "bun:test";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { findTaskPosition } from "../app/editor/task-navigation";
import { createMarkdownExtension } from "../app/editor/markdown-config";
import { extractMarkdownTasks } from "../shared/tasks";

describe("task navigation", () => {
  test("matches extracted tasks against the editor document in order", () => {
    const markdown =
      "> - [ ] **父任务**\n>   - [x] 子任务\n\n- [ ] 重复\n- [ ] 重复\n\n```md\n- [ ] 示例\n```";
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
      const tasks = extractMarkdownTasks(markdown);
      expect(tasks).toHaveLength(4);
      for (const task of tasks) {
        expect(findTaskPosition(editor.state.doc, task.ordinal, task.text)).not.toBeNull();
      }
    } finally {
      editor.destroy();
    }
  });
  test("distinguishes duplicate tasks and refuses a stale position", () => {
    const editor = new Editor({
      element: null,
      extensions: [StarterKit, TaskList, TaskItem.configure({ nested: true })],
      content: {
        type: "doc",
        content: [
          {
            type: "taskList",
            content: [
              {
                type: "taskItem",
                attrs: { checked: false },
                content: [{ type: "paragraph", content: [{ type: "text", text: "重复任务" }] }],
              },
              {
                type: "taskItem",
                attrs: { checked: true },
                content: [{ type: "paragraph", content: [{ type: "text", text: "重复任务" }] }],
              },
            ],
          },
        ],
      },
    });
    try {
      const first = findTaskPosition(editor.state.doc, 0, "重复任务");
      const second = findTaskPosition(editor.state.doc, 1, "重复任务");
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(second).not.toBe(first);
      expect(findTaskPosition(editor.state.doc, 1, "已修改的任务")).toBeNull();
      expect(findTaskPosition(editor.state.doc, 2, "重复任务")).toBeNull();
    } finally {
      editor.destroy();
    }
  });
});
