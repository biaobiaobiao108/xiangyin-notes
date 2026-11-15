import { describe, expect, test } from "bun:test";
import { stickyGroupOffset } from "../app/workspace/group-layout";

describe("virtual sticky group transition", () => {
  test("pushes the current header out as the next group reaches it", () => {
    expect(stickyGroupOffset(undefined, 100, 34)).toBe(0);
    expect(stickyGroupOffset(200, 166, 34)).toBe(0);
    expect(stickyGroupOffset(200, 183, 34)).toBe(-17);
    expect(stickyGroupOffset(200, 200, 34)).toBe(-34);
    expect(stickyGroupOffset(200, 210, 34)).toBe(-34);
  });
});
