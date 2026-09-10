const applePlatform = typeof navigator !== "undefined" && /(Mac|iPhone|iPod|iPad)/i.test(navigator.platform || navigator.userAgent);

/** Primary modifier label for the current platform, used in shortcut hints. */
export const modKey = applePlatform ? "⌘" : "Ctrl";
