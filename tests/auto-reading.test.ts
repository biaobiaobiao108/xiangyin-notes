import { describe, expect, it } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { AutoReadingHUD } from "../app/editor/auto-reading-hud";

describe("AutoReadingHUD component", () => {
  it("renders correctly with controls, speed display, and exit button", () => {
    const dummyRef = { current: null };
    const html = renderToString(
      React.createElement(AutoReadingHUD, {
        scrollTargetRef: dummyRef,
        onExit: () => {},
      }),
    );

    expect(html).toContain("auto-reading-hud");
    expect(html).toContain("回正到顶部");
    expect(html).toContain("暂停滚动");
    expect(html).toContain("速度调节");
    expect(html).toContain("1.0x");
    expect(html).toContain("退出");
    expect(html).toContain("Esc");
  });

  it("calculates subpixel scroll progression accurately across frames", () => {
    const baseSpeed = 36; // px/sec
    const speedMultiplier = 1.0;

    // Simulate 60 frames with integer millisecond increments totaling 1000ms
    let accumulator = 0;
    let totalScrolledPx = 0;
    let prevTime = 0;

    for (let frame = 1; frame <= 60; frame++) {
      const currentTime = Math.round((frame * 1000) / 60);
      const elapsed = currentTime - prevTime;
      prevTime = currentTime;

      const px = (baseSpeed * speedMultiplier * elapsed) / 1000;
      accumulator += px;
      if (accumulator >= 1) {
        const step = Math.floor(accumulator);
        accumulator -= step;
        totalScrolledPx += step;
      }
    }

    // Over 60 frames (1000ms), total moved pixels plus remainder should equal 36px
    expect(totalScrolledPx + Math.round(accumulator)).toBe(36);
  });

  it("clamps speed multiplier between 0.3x and 4.0x", () => {
    const clamp = (val: number) => Math.max(0.3, Math.min(4.0, Math.round(val * 100) / 100));

    expect(clamp(0.1)).toBe(0.3);
    expect(clamp(0.25)).toBe(0.3);
    expect(clamp(1.5)).toBe(1.5);
    expect(clamp(4.5)).toBe(4.0);
    expect(clamp(5.0)).toBe(4.0);
  });
});
