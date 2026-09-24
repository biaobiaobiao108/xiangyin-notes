import { describe, expect, test } from "bun:test";
import { playEntranceAnimation } from "../app/animation";

function makeAnimationTarget(reducedMotion = false) {
  let capturedKeyframes: unknown;
  let capturedOptions: unknown;
  let finishListener: EventListener | null = null;
  let animationCalls = 0;
  let cancelCalls = 0;
  const animation = {
    addEventListener: (_type: string, listener: EventListener) => { finishListener = listener; },
    cancel: () => { cancelCalls += 1; },
  } as unknown as Animation;
  const view = {
    matchMedia: () => ({ matches: reducedMotion }),
    getComputedStyle: () => ({
      getPropertyValue: (property: string) => property === "--motion-content" ? "180ms" : "cubic-bezier(0.16, 1, 0.3, 1)",
    }),
  } as unknown as Window;
  const target = {
    ownerDocument: { defaultView: view, documentElement: {} },
    animate: (keyframes: unknown, options: unknown) => {
      animationCalls += 1;
      capturedKeyframes = keyframes;
      capturedOptions = options;
      return animation;
    },
    get offsetWidth() { throw new Error("animation must not force layout"); },
  } as unknown as HTMLElement;

  return {
    animation,
    target,
    get capturedKeyframes() { return capturedKeyframes; },
    get capturedOptions() { return capturedOptions; },
    get animationCalls() { return animationCalls; },
    get cancelCalls() { return cancelCalls; },
    get finishListener() { return finishListener; },
  };
}

describe("page transition animations", () => {
  test("plays the shared content entrance and releases it on finish", () => {
    const fixture = makeAnimationTarget();

    expect(playEntranceAnimation(fixture.target, "page-content-in")).toBe(fixture.animation);
    expect(fixture.capturedKeyframes).toEqual([
      { opacity: 0, transform: "translateY(6px)" },
      { opacity: 1, transform: "translateY(0)" },
    ]);
    expect(fixture.capturedOptions).toEqual({
      duration: 180,
      easing: "cubic-bezier(0.16, 1, 0.3, 1)",
      fill: "both",
    });

    fixture.finishListener?.({} as Event);
    expect(fixture.cancelCalls).toBe(1);
  });

  test("respects reduced motion without creating an animation", () => {
    const fixture = makeAnimationTarget(true);

    expect(playEntranceAnimation(fixture.target, "note-fade-in")).toBeNull();
    expect(fixture.animationCalls).toBe(0);
  });

  test("page layout changes do not animate dimensions or grid tracks", async () => {
    const css = await Bun.file("app/styles.css").text();
    const shellRule = css.match(/\.app-shell\s*\{([^}]*)\}/)?.[1] ?? "";
    const editorDocumentRule = css.match(/\.editor-document\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(shellRule).not.toMatch(/transition\s*:[^;]*grid-template-columns/);
    expect(editorDocumentRule).not.toMatch(/transition\s*:[^;]*(?:width|padding)/);
  });
});
