import { describe, expect, test } from "bun:test";
import { scrollNoteBoundary } from "../app/editor/document-navigation";

function keyEvent(key: string, overrides: Partial<KeyboardEvent> = {}) {
  let prevented = false;
  return {
    event: { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, keyCode: 0, defaultPrevented: false,
      preventDefault() { prevented = true; }, ...overrides },
    wasPrevented: () => prevented,
  };
}

describe("note document boundary navigation", () => {
  test("Home and End scroll the full note rather than the window or current line", () => {
    const target = { scrollTop: 600, scrollHeight: 2400, clientHeight: 800 };
    const home = keyEvent("Home");
    expect(scrollNoteBoundary(home.event, target)).toBe(true);
    expect(target.scrollTop).toBe(0);
    expect(home.wasPrevented()).toBe(true);
    const end = keyEvent("End");
    expect(scrollNoteBoundary(end.event, target)).toBe(true);
    expect(target.scrollTop).toBe(1600);
    expect(end.wasPrevented()).toBe(true);
  });

  test.each([{ isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }])("preserves IME and modified navigation: %j", (overrides) => {
    for (const key of ["Home", "End"]) {
      const target = { scrollTop: 100, scrollHeight: 2400, clientHeight: 800 };
      const input = keyEvent(key, overrides);
      expect(scrollNoteBoundary(input.event, target)).toBe(false);
      expect(target.scrollTop).toBe(100);
      expect(input.wasPrevented()).toBe(false);
    }
  });

  test("short notes and other navigation keys", () => {
    const target = { scrollTop: 0, scrollHeight: 200, clientHeight: 800 };
    expect(scrollNoteBoundary(keyEvent("End").event, target)).toBe(true);
    expect(target.scrollTop).toBe(0);
    const down = keyEvent("ArrowDown");
    expect(scrollNoteBoundary(down.event, target)).toBe(false);
    expect(down.wasPrevented()).toBe(false);
  });
});
