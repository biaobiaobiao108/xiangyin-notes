import { describe, expect, it } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import {
  AutoReadingHUD,
  clampPresetIndex,
  handleReadingKeyDown,
  presetIndexForDrag,
  presetIndexForTap,
  READING_SPEED_PRESETS,
  stepPresetIndex,
  updateFocalElement,
} from "../app/editor/auto-reading-hud";

function readingActions() {
  const calls: string[] = [];
  return {
    calls,
    actions: {
      togglePlay: () => calls.push("play"),
      handleSpeedUp: () => calls.push("speed-up"),
      handleSpeedDown: () => calls.push("speed-down"),
      toggleFocusReading: () => calls.push("focus"),
      handleRewind: () => calls.push("rewind"),
    },
  };
}

function readingKeyEvent(target: EventTarget | null, overrides: Record<string, unknown> = {}) {
  let defaultPrevented = false;
  const event = {
    key: " ",
    code: "Space",
    isComposing: false,
    keyCode: 32,
    repeat: false,
    target,
    defaultPrevented: false,
    preventDefault() {
      defaultPrevented = true;
      event.defaultPrevented = true;
    },
    ...overrides,
  };
  return {
    event,
    wasPrevented: () => defaultPrevented,
  };
}

function mockTarget(matcher: (selector: string) => boolean) {
  return {
    closest: (selector: string) => (matcher(selector) ? ({} as Element) : null),
  } as unknown as EventTarget;
}

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
    expect(html).toContain("auto-reading-dial-needle");
    expect(html).toContain('role="slider"');
    expect(html).toContain('aria-valuenow="3"');
    expect(html).toContain("1.0x");
    // 确认已剔除口播、解说等特定场景命名
    expect(html).not.toContain("口播");
    expect(html).not.toContain("解说");
    expect(html).not.toContain("叙述");
    expect(html).toContain("退出");
    expect(html).toContain("Esc");
    expect(html).not.toContain('title="');
  });

  it("configures 10 speed presets with strictly increasing rates and 1.0x default", () => {
    expect(READING_SPEED_PRESETS.length).toBe(10);
    for (let i = 1; i < READING_SPEED_PRESETS.length; i++) {
      expect(READING_SPEED_PRESETS[i].rate).toBeGreaterThan(READING_SPEED_PRESETS[i - 1].rate);
    }
    expect(READING_SPEED_PRESETS[3].rate).toBe(32);
    expect(READING_SPEED_PRESETS[3].multiplier).toBe("1.0x");
  });

  it("steps and clamps preset indexes through the exported helpers", () => {
    expect(stepPresetIndex(0, -1)).toBe(0);
    expect(stepPresetIndex(3, -1)).toBe(2);
    expect(stepPresetIndex(3, 1)).toBe(4);
    expect(stepPresetIndex(9, 1)).toBe(9);
    expect(clampPresetIndex(-4)).toBe(0);
    expect(clampPresetIndex(14)).toBe(9);
  });

  it("maps drag distance and tap offset to the actual dial presets", () => {
    expect(presetIndexForDrag(3, -28)).toBe(4);
    expect(presetIndexForDrag(3, -56)).toBe(5);
    expect(presetIndexForDrag(3, 28)).toBe(2);
    expect(presetIndexForDrag(3, -300)).toBe(9);
    expect(presetIndexForDrag(3, 300)).toBe(0);
    expect(presetIndexForTap(3, 28)).toBe(4);
    expect(presetIndexForTap(3, -56)).toBe(1);
  });

  it("routes page-level shortcuts without stealing button activation", () => {
    const page = readingActions();
    const pageEvent = readingKeyEvent(null);
    expect(handleReadingKeyDown(pageEvent.event, page.actions)).toBe(true);
    expect(page.calls).toEqual(["play"]);
    expect(pageEvent.wasPrevented()).toBe(true);

    const button = readingActions();
    const buttonEvent = readingKeyEvent(mockTarget((selector) => selector.includes("button")));
    expect(handleReadingKeyDown(buttonEvent.event, button.actions)).toBe(false);
    expect(button.calls).toEqual([]);
    expect(buttonEvent.wasPrevented()).toBe(false);
  });

  it("keeps shortcuts available from a read-only title but not from editors or dialogs", () => {
    const title = readingKeyEvent(mockTarget(() => false));
    const titleActions = readingActions();
    expect(handleReadingKeyDown(title.event, titleActions.actions)).toBe(true);
    expect(titleActions.calls).toEqual(["play"]);

    const realInput = readingKeyEvent(mockTarget((selector) => selector.includes("input:not")));
    expect(handleReadingKeyDown(realInput.event, readingActions().actions)).toBe(false);

    const dialog = readingKeyEvent(mockTarget((selector) => selector.includes("dialog")));
    expect(handleReadingKeyDown(dialog.event, readingActions().actions)).toBe(false);
  });

  it("ignores repeated toggle keys but allows held arrow-key speed changes", () => {
    const repeatedSpace = readingKeyEvent(null, { repeat: true });
    const spaceActions = readingActions();
    expect(handleReadingKeyDown(repeatedSpace.event, spaceActions.actions)).toBe(false);
    expect(spaceActions.calls).toEqual([]);

    const repeatedArrow = readingKeyEvent(null, { key: "ArrowUp", code: "ArrowUp", repeat: true });
    const arrowActions = readingActions();
    expect(handleReadingKeyDown(repeatedArrow.event, arrowActions.actions)).toBe(true);
    expect(arrowActions.calls).toEqual(["speed-up"]);
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

  it("finds a distant reading block without measuring every preceding block", () => {
    let measurements = 0;
    const selected = new Set<number>();
    const blocks = Array.from({ length: 1000 }, (_, index) => ({
      classList: { add: () => selected.add(index), remove: () => selected.delete(index) },
      getBoundingClientRect: () => {
        measurements++;
        return { top: index * 20, bottom: index * 20 + 15 };
      },
    }));
    const container = {
      classList: { add() {}, remove() {} },
      getBoundingClientRect: () => ({ top: 17600, height: 1000 }),
      querySelectorAll: () => blocks,
      querySelector: () => null,
    } as unknown as HTMLElement;
    updateFocalElement(container, true);
    expect([...selected]).toEqual([900]);
    expect(measurements).toBeLessThan(20);
  });
});
