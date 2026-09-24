export type EntranceAnimationName = "page-content-in" | "note-fade-in";

const entranceKeyframes: Record<EntranceAnimationName, Keyframe[]> = {
  "page-content-in": [
    { opacity: 0, transform: "translateY(6px)" },
    { opacity: 1, transform: "translateY(0)" },
  ],
  "note-fade-in": [
    { opacity: 0.82, transform: "translateY(4px)" },
    { opacity: 1, transform: "translateY(0)" },
  ],
};

function parseCssTime(value: string, fallback: number) {
  const time = Number.parseFloat(value);
  if (!Number.isFinite(time)) return fallback;
  return value.trim().endsWith("s") && !value.trim().endsWith("ms") ? time * 1000 : time;
}

export function playEntranceAnimation(target: HTMLElement, animationName: EntranceAnimationName): Animation | null {
  const view = target.ownerDocument.defaultView;
  if (!view || view.matchMedia("(prefers-reduced-motion: reduce)").matches) return null;
  if (typeof target.animate !== "function") return null;

  const styles = view.getComputedStyle(target.ownerDocument.documentElement);
  const duration = parseCssTime(styles.getPropertyValue("--motion-content").trim(), 180);
  if (duration <= 0) return null;

  const easing = styles.getPropertyValue("--motion-ease-out").trim() || "cubic-bezier(0.16, 1, 0.3, 1)";
  const animation = target.animate(entranceKeyframes[animationName], { duration, easing, fill: "both" });
  animation.addEventListener("finish", () => animation.cancel(), { once: true });
  return animation;
}
