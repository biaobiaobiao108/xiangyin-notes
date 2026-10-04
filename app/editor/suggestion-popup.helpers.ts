export type SuggestionViewport = { left: number; top: number; width: number; height: number };

export function suggestionViewport(): SuggestionViewport {
  const viewport = window.visualViewport;
  return { left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0, width: viewport?.width ?? window.innerWidth, height: viewport?.height ?? window.innerHeight };
}

/** Fixed editor suggestions must fit the visible viewport, including the iOS keyboard. */
export function suggestionPopupBounds(anchor: { left: number; top: number; bottom: number }, viewport: SuggestionViewport, desiredWidth: number, desiredHeight: number, measuredHeight = desiredHeight) {
  const padding = 12;
  const width = Math.max(0, Math.min(desiredWidth, viewport.width - padding * 2));
  const maxHeight = Math.max(0, Math.min(desiredHeight, viewport.height - padding * 2));
  const height = Math.min(measuredHeight, maxHeight);
  const minLeft = viewport.left + padding;
  const minTop = viewport.top + padding;
  const maxTop = viewport.top + viewport.height - padding - height;
  const below = anchor.bottom + 6;
  const above = anchor.top - height - 6;
  const top = below <= maxTop ? below : above >= minTop ? above : Math.min(below, maxTop);
  return {
    width, maxHeight,
    left: Math.round(Math.max(minLeft, Math.min(anchor.left, viewport.left + viewport.width - padding - width))),
    top: Math.round(Math.max(minTop, top)),
  };
}
