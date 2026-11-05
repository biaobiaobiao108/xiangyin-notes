import { describe, expect, it } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import {
  AutoReadingHUD,
  BROADCAST_SPEED_PRESETS,
  updateFocalElement,
} from "../app/editor/auto-reading-hud";

describe("AutoReadingHUD component", () => {
  it("renders correctly with controls, dial wheel, focus button, and exit button", () => {
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
    expect(html).toContain("auto-reading-btn--focus");
    expect(html).toContain("auto-reading-dial");
    expect(html).toContain("1.0x");
    expect(html).toContain("标准口播");
    expect(html).toContain("退出");
    expect(html).toContain("Esc");
  });

  it("calculates subpixel scroll progression accurately for 32px/s standard broadcast speed", () => {
    const baseSpeed = 32; // px/sec
    let accumulator = 0;
    let totalScrolledPx = 0;
    let prevTime = 0;

    for (let frame = 1; frame <= 60; frame++) {
      const currentTime = Math.round((frame * 1000) / 60);
      const elapsed = currentTime - prevTime;
      prevTime = currentTime;

      const px = (baseSpeed * elapsed) / 1000;
      accumulator += px;
      if (accumulator >= 1) {
        const step = Math.floor(accumulator);
        accumulator -= step;
        totalScrolledPx += step;
      }
    }

    // Over 60 frames (1000ms), total moved pixels plus remainder should equal 32px
    expect(totalScrolledPx + Math.round(accumulator)).toBe(32);
  });

  it("configures broadcast speed presets with strictly increasing rates", () => {
    expect(BROADCAST_SPEED_PRESETS.length).toBe(6);
    for (let i = 1; i < BROADCAST_SPEED_PRESETS.length; i++) {
      expect(BROADCAST_SPEED_PRESETS[i].rate).toBeGreaterThan(BROADCAST_SPEED_PRESETS[i - 1].rate);
    }
    expect(BROADCAST_SPEED_PRESETS[2].rate).toBe(32);
    expect(BROADCAST_SPEED_PRESETS[2].multiplier).toBe("1.0x");
    expect(BROADCAST_SPEED_PRESETS[2].label).toBe("标准口播");
  });

  it("steps preset index within valid boundaries [0, 5]", () => {
    const maxIndex = BROADCAST_SPEED_PRESETS.length - 1;
    const stepDown = (idx: number) => Math.max(0, idx - 1);
    const stepUp = (idx: number) => Math.min(maxIndex, idx + 1);

    expect(stepDown(0)).toBe(0);
    expect(stepDown(2)).toBe(1);
    expect(stepUp(2)).toBe(3);
    expect(stepUp(5)).toBe(5);
  });

  it("detects and highlights the paragraph overlapping the 40% focal line", () => {
    // Mock DOM elements
    const p1Classes = new Set<string>();
    const p2Classes = new Set<string>();
    const containerClasses = new Set<string>();

    const p1 = {
      classList: {
        add: (c: string) => p1Classes.add(c),
        remove: (c: string) => p1Classes.delete(c),
      },
      getBoundingClientRect: () => ({ top: 0, bottom: 200 }),
    } as unknown as HTMLElement;

    const p2 = {
      classList: {
        add: (c: string) => p2Classes.add(c),
        remove: (c: string) => p2Classes.delete(c),
      },
      getBoundingClientRect: () => ({ top: 220, bottom: 500 }),
    } as unknown as HTMLElement;

    const container = {
      classList: {
        add: (c: string) => containerClasses.add(c),
        remove: (c: string) => containerClasses.delete(c),
      },
      getBoundingClientRect: () => ({ top: 0, height: 1000 }), // 40% line is at top=400
      querySelectorAll: () => [p1, p2],
      querySelector: (selector: string) => {
        if (selector === ".is-reading-focus") {
          if (p1Classes.has("is-reading-focus")) return p1;
          if (p2Classes.has("is-reading-focus")) return p2;
        }
        return null;
      },
    } as unknown as HTMLElement;

    // Run with focus enabled: focal line at 400 intersects p2 (top 220 to 500)
    updateFocalElement(container, true);
    expect(containerClasses.has("is-focus-reading")).toBe(true);
    expect(p2Classes.has("is-reading-focus")).toBe(true);
    expect(p1Classes.has("is-reading-focus")).toBe(false);

    // Move p1 to overlap focal line at 400
    (p1 as any).getBoundingClientRect = () => ({ top: 300, bottom: 600 });
    (p2 as any).getBoundingClientRect = () => ({ top: 620, bottom: 900 });
    updateFocalElement(container, true);
    expect(p1Classes.has("is-reading-focus")).toBe(true);
    expect(p2Classes.has("is-reading-focus")).toBe(false);

    // Disable focus reading
    updateFocalElement(container, false);
    expect(containerClasses.has("is-focus-reading")).toBe(false);
    expect(p1Classes.has("is-reading-focus")).toBe(false);
  });
});
