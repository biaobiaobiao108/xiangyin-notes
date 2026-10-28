import { describe, expect, test } from "bun:test";
import { collapsedGroupScrollTop, stickyGroupOffset } from "../app/workspace/group-layout";

describe("virtual sticky group transition", () => {
  test("pushes the current header out as the next group reaches it", () => {
    expect(stickyGroupOffset(undefined, 100, 34)).toBe(0);
    expect(stickyGroupOffset(200, 166, 34)).toBe(0);
    expect(stickyGroupOffset(200, 183, 34)).toBe(-17);
    expect(stickyGroupOffset(200, 200, 34)).toBe(-34);
    expect(stickyGroupOffset(200, 210, 34)).toBe(-34);
  });
});

describe("collapsible group scroll position", () => {
  test("keeps the active sticky group at the top after its tasks are removed", () => {
    expect(
      collapsedGroupScrollTop({
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
    expect(collapsedGroupScrollTop({ ...layout, closing: true })).toBeNull();
    expect(
      collapsedGroupScrollTop({ ...layout, sectionTop: -180, headerTop: 120, closing: false }),
    ).toBeNull();
  });
});
