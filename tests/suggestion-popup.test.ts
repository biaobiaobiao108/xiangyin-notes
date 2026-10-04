import { expect, test } from "bun:test";
import { suggestionPopupBounds } from "../app/editor/suggestion-popup.helpers";

test("keyboard viewport contains the full suggestion panel despite a taller layout viewport", () => {
  const bounds = suggestionPopupBounds({ left: 20, top: 160, bottom: 182 }, { left: 0, top: 0, width: 390, height: 400 }, 660, 500);
  expect(bounds).toEqual({ width: 366, maxHeight: 376, left: 12, top: 12 });
  expect(bounds.top + bounds.maxHeight).toBeLessThanOrEqual(388);
});

test("panned visual viewport retains its inset and clamps actual wiki menu width", () => {
  const bounds = suggestionPopupBounds({ left: 280, top: 250, bottom: 275 }, { left: 20, top: 100, width: 390, height: 400 }, 300, 280);
  expect(bounds).toEqual({ width: 300, maxHeight: 280, left: 98, top: 208 });
});

test("short landscape view shrinks the scroll region and flips a short panel above the caret", () => {
  expect(suggestionPopupBounds({ left: 12, top: 180, bottom: 200 }, { left: 0, top: 0, width: 240, height: 220 }, 300, 280, 100)).toEqual({ width: 216, maxHeight: 196, left: 12, top: 74 });
});

test("desktop suggestions retain below-caret placement when space permits", () => {
  expect(suggestionPopupBounds({ left: 420, top: 240, bottom: 260 }, { left: 0, top: 0, width: 1440, height: 900 }, 660, 500, 360)).toEqual({ width: 660, maxHeight: 500, left: 420, top: 266 });
});
