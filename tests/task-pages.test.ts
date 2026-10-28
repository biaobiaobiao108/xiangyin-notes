import { describe, expect, test } from "bun:test";
import { reloadTaskPages } from "../app/workspace/task-pages";
import type { TaskSummary } from "../shared/types";

const task = (ordinal: number): TaskSummary => ({
  noteId: "note",
  noteTitle: "笔记",
  notebookId: "notebook",
  notebookName: "开发",
  version: 1,
  text: `任务 ${ordinal}`,
  done: false,
  ordinal,
  depth: 0,
});

describe("task list refresh", () => {
  test("reloads the previously loaded range and keeps the new cursor", async () => {
    const calls: Array<string | undefined> = [];
    const result = await reloadTaskPages(async (cursor, limit) => {
      calls.push(cursor);
      expect(limit).toBe(cursor ? 100 : 200);
      const start = cursor ? Number(cursor) : 0;
      return {
        tasks: Array.from({ length: limit }, (_, index) => task(start + index)),
        total: 600,
        nextCursor: String(start + limit),
      };
    }, 300);
    expect(calls).toEqual([undefined, "200"]);
    expect(result.tasks).toHaveLength(300);
    expect(result.total).toBe(600);
    expect(result.nextCursor).toBe("300");
  });

  test("stops at the last page when tasks were removed", async () => {
    const result = await reloadTaskPages(
      async () => ({
        tasks: [task(0)],
        total: 1,
        nextCursor: null,
      }),
      250,
    );
    expect(result.tasks).toHaveLength(1);
    expect(result.nextCursor).toBeNull();
    expect(result.total).toBe(1);
  });
});
