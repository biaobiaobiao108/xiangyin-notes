export const isApplePlatform = typeof navigator !== "undefined" && /(Mac|iPhone|iPod|iPad)/i.test(navigator.platform || navigator.userAgent);

/** Primary modifier label for the current platform, used in shortcut hints. */
export const modKey = isApplePlatform ? "⌘" : "Ctrl";
export const altKey = isApplePlatform ? "⌥" : "Alt";

export function getCommandMenuShortcutLabel(isApplePlatform: boolean): string {
  return isApplePlatform ? "⌘/" : "Alt+/";
}

export const commandMenuShortcutLabel = getCommandMenuShortcutLabel(isApplePlatform);

export function matchesCommandMenuShortcut(
  event: Pick<KeyboardEvent, "key" | "code" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey">,
  isApplePlatformOverride: boolean = isApplePlatform,
): boolean {
  const isSlash = event.key === "/" || (event.code === "Slash" && !event.shiftKey);
  if (!isSlash) return false;

  return isApplePlatformOverride
    ? event.metaKey && !event.ctrlKey && !event.altKey
    : event.altKey && !event.ctrlKey && !event.metaKey;
}
