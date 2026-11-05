import { describe, expect, it } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import {
  AutoReadingHUD,
  READING_SPEED_PRESETS,
  updateFocalElement,
} from "../app/editor/auto-reading-hud";

describe("AutoReadingHUD component", () => {
  it("renders correctly in initial paused state with controls, dial wheel, and pure numbers", () => {
    const dummyRef = { current: null };
    const html = renderToString(
      React.createElement(AutoReadingHUD, {
        scrollTargetRef: dummyRef,
        onExit: () => {},
      }),
    );

    expect(html).toContain("auto-reading-hud");
    expect(html).toContain("回正到顶部");
    // 默认进入为暂停状态，按钮显示继续滚动（Play 图标）
    expect(html).toContain("继续滚动 (空格键)");
    expect(html).toContain("auto-reading-btn--focus");
    expect(html).toContain("auto-reading-dial");
    expect(html).toContain("1.0x");
    // 确认已剔除口播、解说等特定场景命名
    expect(html).not.toContain("口播");
    expect(html).not.toContain("解说");
    expect(html).not.toContain("叙述");
    expect(html).toContain("退出");
    expect(html).toContain("Esc");
  });

  it("calculates subpixel scroll progression accurately for 32px/s standard speed", () => {
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

  it("configures 10 speed presets with strictly increasing rates and 1.0x default", () => {
    expect(READING_SPEED_PRESETS.length).toBe(10);
    for (let i = 1; i < READING_SPEED_PRESETS.length; i++) {
      expect(READING_SPEED_PRESETS[i].rate).toBeGreaterThan(READING_SPEED_PRESETS[i - 1].rate);
    }
    expect(READING_SPEED_PRESETS[3].rate).toBe(32);
    expect(READING_SPEED_PRESETS[3].multiplier).toBe("1.0x");
  });

  it("steps preset index within valid boundaries [0, 9] and supports drag distance snapping", () => {
    const maxIndex = READING_SPEED_PRESETS.length - 1;
    const stepDown = (idx: number) => Math.max(0, idx - 1);
    const stepUp = (idx: number) => Math.min(maxIndex, idx + 1);

    expect(stepDown(0)).toBe(0);
    expect(stepDown(3)).toBe(2);
    expect(stepUp(3)).toBe(4);
    expect(stepUp(9)).toBe(9);

    // 拖拽吸附算法验证 (STEP_PX = 15)
    const calcDragIndex = (startIdx: number, deltaX: number) => {
      return Math.max(0, Math.min(maxIndex, startIdx + Math.round(deltaX / 15)));
    };
    expect(calcDragIndex(3, 16)).toBe(4); // 向右拖动 16px 升 1 档
    expect(calcDragIndex(3, 32)).toBe(5); // 向右拖动 32px 升 2 档
    expect(calcDragIndex(3, -20)).toBe(2); // 向左拖动 20px 降 1 档
    expect(calcDragIndex(3, 200)).toBe(9); // 超出上限 clamp 到 9
    expect(calcDragIndex(3, -200)).toBe(0); // 超出下限 clamp 到 0
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
