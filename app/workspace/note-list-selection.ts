export type NoteSelectionState = {
  ids: Set<string>;
  anchorId: string | null;
};

export type NoteSelectionClick = {
  id: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
};

export function isNoteSelectionModifierClick(click: Pick<NoteSelectionClick, "metaKey" | "ctrlKey" | "shiftKey">) {
  return Boolean(click.metaKey || click.ctrlKey || click.shiftKey);
}

export function applyNoteSelectionClick(
  state: NoteSelectionState,
  orderedIds: readonly string[],
  click: NoteSelectionClick,
): NoteSelectionState {
  if (!orderedIds.includes(click.id)) return state;

  if (click.shiftKey) {
    const anchorIndex = state.anchorId ? orderedIds.indexOf(state.anchorId) : -1;
    if (anchorIndex < 0) return { ids: new Set([click.id]), anchorId: click.id };

    const clickedIndex = orderedIds.indexOf(click.id);
    const start = Math.min(anchorIndex, clickedIndex);
    const end = Math.max(anchorIndex, clickedIndex);
    return { ids: new Set(orderedIds.slice(start, end + 1)), anchorId: state.anchorId };
  }

  if (click.metaKey || click.ctrlKey) {
    const ids = new Set(state.ids);
    if (ids.has(click.id)) ids.delete(click.id);
    else ids.add(click.id);
    return { ids, anchorId: click.id };
  }

  return { ids: new Set([click.id]), anchorId: click.id };
}

export function pruneNoteSelection(state: NoteSelectionState, orderedIds: readonly string[]): NoteSelectionState {
  const visibleIds = new Set(orderedIds);
  const ids = new Set([...state.ids].filter((id) => visibleIds.has(id)));
  const fallbackAnchor = ids.values().next().value;
  const anchorId = state.anchorId && visibleIds.has(state.anchorId)
    ? state.anchorId
    : typeof fallbackAnchor === "string" ? fallbackAnchor : null;
  return { ids, anchorId };
}
