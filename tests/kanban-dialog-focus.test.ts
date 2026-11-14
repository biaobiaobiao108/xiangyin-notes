import { describe, expect, test } from "bun:test";
import { getDialogTabTarget } from "../app/workspace/kanban-panel";

describe("kanban dialog keyboard focus", () => {
  const first = {} as HTMLElement;
  const middle = {} as HTMLElement;
  const last = {} as HTMLElement;
  const focusableElements = [first, middle, last];

  test("moves Tab focus through modal controls and wraps at both boundaries", () => {
    expect(getDialogTabTarget(focusableElements, last, false)).toBe(first);
    expect(getDialogTabTarget(focusableElements, first, true)).toBe(last);
    expect(getDialogTabTarget(focusableElements, middle, false)).toBe(last);
    expect(getDialogTabTarget(focusableElements, middle, true)).toBe(first);
  });

  test("recovers focus when it has moved outside the modal", () => {
    const outside = {} as HTMLElement;
    expect(getDialogTabTarget(focusableElements, outside, false)).toBe(first);
    expect(getDialogTabTarget(focusableElements, outside, true)).toBe(last);
    expect(getDialogTabTarget([], outside, false)).toBeNull();
  });
});
