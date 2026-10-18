import { describe, expect, test } from "bun:test";
import { computeScrollEdges } from "../app/workspace/use-scroll-edges";

describe("computeScrollEdges", () => {
  test("returns false for both edges when content fits without scrolling", () => {
    expect(computeScrollEdges(0, 500, 500)).toEqual({ before: false, after: false });
    expect(computeScrollEdges(0, 300, 600)).toEqual({ before: false, after: false });
    expect(computeScrollEdges(50, 400, 500)).toEqual({ before: false, after: false });
  });

  test("detects when scrolled at the very top", () => {
    expect(computeScrollEdges(0, 1000, 400)).toEqual({ before: false, after: true });
    // Within threshold (default 1px)
    expect(computeScrollEdges(1, 1000, 400)).toEqual({ before: false, after: true });
  });

  test("detects intermediate scroll state with both edges active", () => {
    expect(computeScrollEdges(20, 1000, 400)).toEqual({ before: true, after: true });
    expect(computeScrollEdges(300, 1000, 400)).toEqual({ before: true, after: true });
  });

  test("detects when scrolled to the very bottom", () => {
    const maxScroll = 600; // 1000 - 400
    expect(computeScrollEdges(maxScroll, 1000, 400)).toEqual({ before: true, after: false });
    // Within bottom threshold
    expect(computeScrollEdges(maxScroll - 1, 1000, 400)).toEqual({ before: true, after: false });
  });

  test("safely clamps negative overscroll (Safari rubber-band top)", () => {
    expect(computeScrollEdges(-50, 1000, 400)).toEqual({ before: false, after: true });
    expect(computeScrollEdges(-10, 500, 500)).toEqual({ before: false, after: false });
  });

  test("safely clamps excessive overscroll (Safari rubber-band bottom)", () => {
    expect(computeScrollEdges(750, 1000, 400)).toEqual({ before: true, after: false });
    expect(computeScrollEdges(100, 500, 500)).toEqual({ before: false, after: false });
  });

  test("supports custom threshold values", () => {
    // threshold = 10
    expect(computeScrollEdges(5, 1000, 400, 10)).toEqual({ before: false, after: true });
    expect(computeScrollEdges(12, 1000, 400, 10)).toEqual({ before: true, after: true });
    expect(computeScrollEdges(595, 1000, 400, 10)).toEqual({ before: true, after: false });
  });
});
