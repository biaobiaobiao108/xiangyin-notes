import { describe, expect, test } from "bun:test";
import { collapsedTaskGroupScrollTop } from "../app/workspace/tasks-panel";

describe("task group collapse scroll position", () => {
  test("keeps the active sticky group at the top after its tasks are removed", () => {
    expect(
      collapsedTaskGroupScrollTop({
        closing: true,
        scrollTop: 620,
        scrollEdge: 120,
        sectionTop: -180,
        headerTop: 120,
      }),
    ).toBe(320);
  });

  test("does not move the scroll position for a visible non-sticky group or expansion", () => {
    const layout = { scrollTop: 620, scrollEdge: 120, sectionTop: 200, headerTop: 200 };
    expect(collapsedTaskGroupScrollTop({ ...layout, closing: true })).toBeNull();
    expect(
      collapsedTaskGroupScrollTop({ ...layout, sectionTop: -180, headerTop: 120, closing: false }),
    ).toBeNull();
  });
});
