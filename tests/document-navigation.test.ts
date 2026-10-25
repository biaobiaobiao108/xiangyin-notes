import { describe, expect, test } from "bun:test";
import { scrollNoteBoundary } from "../app/editor/document-navigation";

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

describe("note document boundary navigation", () => {
  test("Home and End scroll the full note rather than the window or current line", () => {
    const scrolls: Array<{ top: number; behavior: ScrollBehavior }> = [];
    const target = {
      scrollHeight: 2400,
      clientHeight: 800,
      scrollTo(options: { top: number; behavior: ScrollBehavior }) {
        scrolls.push(options);
      },
    };
    const home = keyEvent("Home");
    expect(scrollNoteBoundary(home.event, target)).toBe(true);
    expect(scrolls[0]).toEqual({ top: 0, behavior: "smooth" });
    expect(home.wasPrevented()).toBe(true);
    const end = keyEvent("End");
    expect(scrollNoteBoundary(end.event, target)).toBe(true);
    expect(scrolls[1]).toEqual({ top: 1600, behavior: "smooth" });
    expect(end.wasPrevented()).toBe(true);
  });

  test("allows reduced-motion navigation to be immediate", () => {
    const scrolls: Array<{ top: number; behavior: ScrollBehavior }> = [];
    const target = {
      scrollHeight: 2400,
      clientHeight: 800,
      scrollTo(options: { top: number; behavior: ScrollBehavior }) {
        scrolls.push(options);
      },
    };
    expect(scrollNoteBoundary(keyEvent("End").event, target, "auto")).toBe(true);
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
    for (const key of ["Home", "End"]) {
      const target = {
        scrollHeight: 2400,
        clientHeight: 800,
        scrollTo() {},
      };
      const input = keyEvent(key, overrides);
      expect(scrollNoteBoundary(input.event, target)).toBe(false);
      expect(input.wasPrevented()).toBe(false);
    }
  });

  test("short notes and other navigation keys", () => {
    const target = { scrollHeight: 200, clientHeight: 800, scrollTo() {} };
    expect(scrollNoteBoundary(keyEvent("End").event, target)).toBe(true);
    const down = keyEvent("ArrowDown");
    expect(scrollNoteBoundary(down.event, target)).toBe(false);
    expect(down.wasPrevented()).toBe(false);
  });
});
