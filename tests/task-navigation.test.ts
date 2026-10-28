import { describe, expect, test } from "bun:test";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import {
  createTaskNavigationPlugin,
  findTaskPosition,
  taskNavigationPluginKey,
} from "../app/editor/task-navigation";
import { createMarkdownExtension } from "../app/editor/markdown-config";
import { extractMarkdownTasks } from "../shared/tasks";

describe("task navigation", () => {
  test("highlighting and clearing a task do not change the document, selection or emit an update", () => {
    let updates = 0;
    const markdown = "- [ ] 任务\n  - [x] 子任务";
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
      onUpdate: () => updates++,
    });
    editor.registerPlugin(createTaskNavigationPlugin());
    try {
      const original = editor.state.doc;
      const originalSelection = editor.state.selection;
      const position = findTaskPosition(original, 1, "子任务")!;
      editor.view.dispatch(editor.state.tr.setMeta(taskNavigationPluginKey, position));
      expect(taskNavigationPluginKey.getState(editor.state)?.find()).toHaveLength(1);
      expect(editor.state.selection.eq(originalSelection)).toBe(true);
      expect(editor.state.doc.eq(original)).toBe(true);
      editor.view.dispatch(editor.state.tr.setMeta(taskNavigationPluginKey, { type: "fade" }));
      expect(taskNavigationPluginKey.getState(editor.state)?.find()).toHaveLength(1);
      editor.view.dispatch(editor.state.tr.setMeta(taskNavigationPluginKey, null));
      expect(taskNavigationPluginKey.getState(editor.state)?.find()).toHaveLength(0);
      expect(editor.state.selection.eq(originalSelection)).toBe(true);
      expect(editor.state.doc.eq(original)).toBe(true);
      expect(updates).toBe(0);
    } finally {
      editor.destroy();
    }
  });
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

  test("finds a unique task after earlier items change the ordinal", () => {
    const editor = new Editor({
      element: null,
      extensions: [
        StarterKit,
        TaskList,
        TaskItem.configure({ nested: true }),
        createMarkdownExtension(),
      ],
      content: "- [ ] 新任务\n- [ ] 目标任务",
      contentType: "markdown",
    });
    try {
      expect(findTaskPosition(editor.state.doc, 0, "目标任务")).toBe(
        findTaskPosition(editor.state.doc, 1, "目标任务"),
      );
    } finally {
      editor.destroy();
    }
  });
});
