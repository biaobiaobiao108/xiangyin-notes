import { describe, expect, test } from "bun:test";
import { scrollNoteNavigation } from "../app/editor/document-navigation";

function keyEvent(key: string, overrides: Partial<KeyboardEvent> = {}) {
  let prevented = false;
  return {
    event: {
      key,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      isComposing: false,
      keyCode: 0,
      defaultPrevented: false,
      preventDefault() {
        prevented = true;
      },
      ...overrides,
    },
    wasPrevented: () => prevented,
  };
}

describe("note document navigation", () => {
  test("Home and End scroll the full note rather than the window or current line", () => {
    const scrolls: Array<{ top: number; behavior: ScrollBehavior }> = [];
    const target = {
      scrollHeight: 2400,
      clientHeight: 800,
      scrollTop: 0,
      scrollTo(options: { top: number; behavior: ScrollBehavior }) {
        scrolls.push(options);
      },
    };
    const home = keyEvent("Home");
    expect(scrollNoteNavigation(home.event, target)).toBe(true);
    expect(scrolls[0]).toEqual({ top: 0, behavior: "smooth" });
    expect(home.wasPrevented()).toBe(true);
    const end = keyEvent("End");
    expect(scrollNoteNavigation(end.event, target)).toBe(true);
    expect(scrolls[1]).toEqual({ top: 1600, behavior: "smooth" });
    expect(end.wasPrevented()).toBe(true);
  });

  test("allows reduced-motion navigation to be immediate", () => {
    const scrolls: Array<{ top: number; behavior: ScrollBehavior }> = [];
    const target = {
      scrollHeight: 2400,
      clientHeight: 800,
      scrollTop: 0,
      scrollTo(options: { top: number; behavior: ScrollBehavior }) {
        scrolls.push(options);
      },
    };
    expect(scrollNoteNavigation(keyEvent("End").event, target, "auto")).toBe(true);
    expect(scrolls).toEqual([{ top: 1600, behavior: "auto" }]);
  });

  test.each([
    { isComposing: true },
    { keyCode: 229 },
    { defaultPrevented: true },
    { ctrlKey: true },
    { metaKey: true },
    { altKey: true },
    { shiftKey: true },
  ])("preserves IME and modified navigation: %j", (overrides) => {
    for (const key of ["Home", "End", "PageUp", "PageDown"]) {
      const target = {
        scrollHeight: 2400,
        clientHeight: 800,
        scrollTop: 400,
        scrollTo() {},
      };
      const input = keyEvent(key, overrides);
      expect(scrollNoteNavigation(input.event, target)).toBe(false);
      expect(input.wasPrevented()).toBe(false);
    }
  });

  test("PageUp and PageDown move by 85% of the editor viewport", () => {
    const scrolls: Array<{ top: number; behavior: ScrollBehavior }> = [];
    const target = {
      scrollHeight: 2400,
      clientHeight: 800,
      scrollTop: 800,
      scrollTo(options: { top: number; behavior: ScrollBehavior }) {
        scrolls.push(options);
      },
    };
    expect(scrollNoteNavigation(keyEvent("PageUp").event, target)).toBe(true);
    expect(scrollNoteNavigation(keyEvent("PageDown").event, target)).toBe(true);
    expect(scrolls).toEqual([
      { top: 120, behavior: "smooth" },
      { top: 1480, behavior: "smooth" },
    ]);
  });

  test("short notes and other navigation keys", () => {
    const target = { scrollHeight: 200, clientHeight: 800, scrollTop: 0, scrollTo() {} };
    expect(scrollNoteNavigation(keyEvent("End").event, target)).toBe(true);
    const down = keyEvent("ArrowDown");
    expect(scrollNoteNavigation(down.event, target)).toBe(false);
    expect(down.wasPrevented()).toBe(false);
  });
});
