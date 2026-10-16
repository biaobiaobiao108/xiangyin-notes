import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

describe("scroll edge gradient styles and markup contract", () => {
  const cssPath = resolve(import.meta.dir, "../app/styles.css");
  const css = readFileSync(cssPath, "utf-8");

  test("defines scroll edge gradient classes for all three scroll shells", () => {
    expect(css).toContain(".notebook-list-scroll-shell.has-scroll-before::before");
    expect(css).toContain(".notebook-list-scroll-shell.has-scroll-after::after");

    expect(css).toContain(".note-list-scroll-shell.has-scroll-before::before");
    expect(css).toContain(".note-list-scroll-shell.has-scroll-after::after");

    expect(css).toContain(".card-grid-scroll-shell.has-scroll-before::before");
    expect(css).toContain(".card-grid-scroll-shell.has-scroll-after::after");
  });

  test("ensures pointer-events none and non-blocking z-index on overlays", () => {
    // Note list pseudo-elements
    expect(css).toMatch(/\.note-list-scroll-shell::before,\s*\.note-list-scroll-shell::after[\s\S]*?pointer-events:\s*none/);
    expect(css).toMatch(/\.note-list-scroll-shell::before,\s*\.note-list-scroll-shell::after[\s\S]*?z-index:\s*2/);

    // Card grid pseudo-elements
    expect(css).toMatch(/\.card-grid-scroll-shell::before,\s*\.card-grid-scroll-shell::after[\s\S]*?pointer-events:\s*none/);
    expect(css).toMatch(/\.card-grid-scroll-shell::before,\s*\.card-grid-scroll-shell::after[\s\S]*?z-index:\s*2/);
  });

  test("adapts card grid scroll edge gradients for mobile canvas background", () => {
    expect(css).toContain(".is-mobile-card-grid .card-grid-scroll-shell::before");
    expect(css).toContain(".is-mobile-card-grid .card-grid-scroll-shell::after");
    expect(css).toMatch(/\.is-mobile-card-grid \.card-grid-scroll-shell::before\s*\{\s*background:\s*linear-gradient\(to bottom,\s*var\(--canvas\)/);
  });
});
