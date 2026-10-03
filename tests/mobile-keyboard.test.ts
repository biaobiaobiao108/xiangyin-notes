import { describe, expect, test } from "bun:test";
import { resolveMobileViewport } from "../app/workspace/use-mobile-viewport";
import { caretScrollTop } from "../app/editor/use-mobile-caret";

const resting = { width: 390, height: 844, keyboard: false };
describe("mobile keyboard viewport", () => {
  test("keeps the document height while following Safari's keyboard pan", () => {
    expect(resolveMobileViewport(resting, { width: 390, height: 470, layoutHeight: 844, offsetTop: 120, editable: true }))
      .toEqual({ width: 390, height: 844, keyboard: true, inset: 374, top: 120 });
  });
  test("retains the keyboard inset during focus transfer and clears it on dismissal", () => {
    const open = { ...resting, keyboard: true };
    expect(resolveMobileViewport(open, { width: 390, height: 470, layoutHeight: 844, offsetTop: 0, editable: false }).inset).toBe(374);
    expect(resolveMobileViewport(open, { width: 390, height: 844, layoutHeight: 844, offsetTop: 0, editable: true }).inset).toBe(0);
  });
  test("browser chrome and rotation do not preserve an obsolete portrait height", () => {
    expect(resolveMobileViewport(resting, { width: 390, height: 770, layoutHeight: 844, offsetTop: 0, editable: true }).keyboard).toBe(false);
    expect(resolveMobileViewport(resting, { width: 844, height: 390, layoutHeight: 390, offsetTop: 0, editable: true }).height).toBe(390);
  });
  test("also handles browsers that resize the layout viewport for the keyboard", () => {
    expect(resolveMobileViewport(resting, { width: 390, height: 470, layoutHeight: 470, offsetTop: 0, editable: true }).inset).toBe(374);
  });
});

describe("mobile caret visibility", () => {
  const bounds = { top: 80, bottom: 400 };
  test("leaves a visible caret in place", () => {
    expect(caretScrollTop({ top: 200, bottom: 230 }, bounds, 120, 1000)).toBe(120);
  });
  test("scrolls only enough to reveal the caret above or below the controls", () => {
    expect(caretScrollTop({ top: 420, bottom: 450 }, bounds, 120, 1000)).toBe(170);
    expect(caretScrollTop({ top: 40, bottom: 70 }, bounds, 120, 1000)).toBe(80);
  });
  test("respects document limits and an unusably small visible area", () => {
    expect(caretScrollTop({ top: 500, bottom: 530 }, bounds, 120, 150)).toBe(150);
    expect(caretScrollTop({ top: 0, bottom: 30 }, bounds, 20, 1000)).toBe(0);
    expect(caretScrollTop({ top: 500, bottom: 530 }, { top: 80, bottom: 60 }, 120, 1000)).toBe(120);
  });
});
