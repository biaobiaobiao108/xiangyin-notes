import { useEffect } from "react";

export type MobileViewportState = { width: number; height: number; keyboard: boolean };

export function resolveMobileViewport(
  previous: MobileViewportState | undefined,
  viewport: {
    width: number;
    height: number;
    layoutHeight: number;
    offsetTop: number;
    editable: boolean;
    standalone?: boolean;
  },
) {
  const rotated = previous && Math.abs(previous.width - viewport.width) > 80;
  const baseline = Math.max(
    viewport.height,
    viewport.layoutHeight,
    rotated ? 0 : (previous?.height ?? 0),
  );
  const keyboard =
    baseline - viewport.height > 100 &&
    (viewport.editable || (!rotated && previous?.keyboard === true));
  const height = keyboard
    ? baseline
    : viewport.standalone
      ? Math.max(viewport.height, viewport.layoutHeight)
      : viewport.height;
  return {
    width: viewport.width,
    height,
    keyboard,
    inset: keyboard ? height - viewport.height : 0,
    top: Math.max(0, viewport.offsetTop),
  };
}

/** Safari can pan its visual viewport as well as shrink it when the keyboard opens. */
export function useMobileViewport(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const viewport = window.visualViewport;
    const style = document.documentElement.style;
    let previous: MobileViewportState | undefined;
    let frame = 0;
    const update = () => {
      frame = 0;
      // Leave pinch zoom to the browser rather than following its pan with the app.
      if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
      const active = document.activeElement;
      const geometry = resolveMobileViewport(previous, {
        width: viewport?.width ?? window.innerWidth,
        height: viewport?.height ?? window.innerHeight,
        layoutHeight: document.documentElement.clientHeight,
        offsetTop: viewport?.offsetTop ?? 0,
        standalone:
          window.matchMedia("(display-mode: standalone)").matches ||
          Boolean((navigator as Navigator & { standalone?: boolean }).standalone),
        editable:
          active instanceof HTMLElement &&
          Boolean(active.closest("input, textarea, [contenteditable=true]")),
      });
      previous = geometry;
      style.setProperty(
        "--mobile-viewport-height",
        `${geometry.keyboard ? (viewport?.height ?? window.innerHeight) : geometry.height}px`,
      );
      style.setProperty("--mobile-editor-height", `${geometry.height}px`);
      style.setProperty("--mobile-viewport-top", `${geometry.top}px`);
      style.setProperty("--mobile-keyboard-inset", `${geometry.inset}px`);
      style.setProperty(
        "--mobile-bottom-safe-area",
        geometry.keyboard ? "0px" : "env(safe-area-inset-bottom)",
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    document.addEventListener("focusin", schedule);
    document.addEventListener("focusout", schedule);
    return () => {
      cancelAnimationFrame(frame);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("focusin", schedule);
      document.removeEventListener("focusout", schedule);
      for (const name of [
        "viewport-height",
        "editor-height",
        "viewport-top",
        "keyboard-inset",
        "bottom-safe-area",
      ])
        style.removeProperty(`--mobile-${name}`);
    };
  }, [enabled]);
}
