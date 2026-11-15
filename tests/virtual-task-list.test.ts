import { describe, expect, test } from "bun:test";
import type { TaskSummary } from "../shared/types";
import {
  flattenTaskGroups,
  taskGroupRowId,
  taskGroupRowIds,
  taskRowId,
} from "../app/workspace/use-virtual-task-list";

function task(noteId: string, ordinal: number): TaskSummary {
  return {
    noteId,
    noteTitle: `笔记 ${noteId}`,
    notebookId: "notebook-1",
    notebookName: "笔记本",
    version: 1,
    text: `任务 ${ordinal}`,
    done: false,
    ordinal,
    depth: 0,
  };
}

describe("task list virtualization rows", () => {
  test("keeps all tasks after their group markers", () => {
    const first = [task("note-1", 0), task("note-1", 1)];
    const second = [task("note-2", 0)];
    const rows = flattenTaskGroups([first, second]);
    expect(rows.map((row) => row.id)).toEqual([
      taskGroupRowId("note-1"),
      taskRowId(first[0]!),
      taskRowId(first[1]!),
      taskGroupRowId("note-2"),
      taskRowId(second[0]!),
    ]);
    expect(rows[0]?.firstGroup).toBe(true);
    expect(rows[3]?.firstGroup).toBe(false);
  });

  test("retains row ids for tasks and uses stable task keys", () => {
    const group = [task("note-1", 0), task("note-1", 1)];
    const retainedIds = taskGroupRowIds([group]);

    expect(retainedIds.has(taskGroupRowId("note-1"))).toBe(true);
    expect(retainedIds.has(taskRowId(group[1]!))).toBe(true);
    expect(taskRowId(task("note-1", 1))).toBe(taskRowId(group[1]!));
  });
});
