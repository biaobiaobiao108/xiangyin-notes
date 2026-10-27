import { describe, expect, test } from "bun:test";
import {
  clampSplitRatio,
  DEFAULT_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  MAX_SPLIT_RATIO,
} from "../app/workspace/split-resizer";

describe("split resizer logic", () => {
  test("clamps split ratio within allowed bounds", () => {
    expect(clampSplitRatio(0.1)).toBe(MIN_SPLIT_RATIO);
    expect(clampSplitRatio(0.25)).toBe(0.25);
    expect(clampSplitRatio(0.5)).toBe(0.5);
    expect(clampSplitRatio(0.75)).toBe(0.75);
    expect(clampSplitRatio(0.95)).toBe(MAX_SPLIT_RATIO);
  });

  test("rounds precision cleanly to 3 decimals", () => {
    expect(clampSplitRatio(0.3333333)).toBe(0.333);
    expect(clampSplitRatio(0.6666666)).toBe(0.667);
  });

  test("default split ratio is 50%", () => {
    expect(DEFAULT_SPLIT_RATIO).toBe(0.5);
  });
});
