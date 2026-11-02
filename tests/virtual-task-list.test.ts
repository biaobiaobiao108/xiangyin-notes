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
  test("keeps a group marker while a collapsed group's tasks are omitted", () => {
    const first = [task("note-1", 0), task("note-1", 1)];
    const second = [task("note-2", 0)];

    const rows = flattenTaskGroups([first, second], new Set(["note-1"]));

    expect(rows.map((row) => row.id)).toEqual([
      taskGroupRowId("note-1"),
      taskGroupRowId("note-2"),
      taskRowId(second[0]!),
    ]);
    expect(rows[0]?.kind).toBe("group");
    expect(rows[0]?.firstGroup).toBe(true);
    expect(rows[1]?.firstGroup).toBe(false);
  });

  test("keeps task rows mounted during their collapse exit animation", () => {
    const group = [task("note-1", 0), task("note-1", 1)];

    const rows = flattenTaskGroups([group], new Set(["note-1"]), "note-1");

    expect(rows.map((row) => row.id)).toEqual([
      taskGroupRowId("note-1"),
      taskRowId(group[0]!),
      taskRowId(group[1]!),
    ]);
  });

  test("retains measured row ids for collapsed tasks and uses stable task keys", () => {
    const group = [task("note-1", 0), task("note-1", 1)];
    const retainedIds = taskGroupRowIds([group]);

    expect(retainedIds.has(taskGroupRowId("note-1"))).toBe(true);
    expect(retainedIds.has(taskRowId(group[1]!))).toBe(true);
    expect(taskRowId(task("note-1", 1))).toBe(taskRowId(group[1]!));
  });
});
