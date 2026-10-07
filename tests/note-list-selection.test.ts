import { describe, expect, test } from "bun:test";
import { applyNoteSelectionClick, noteSelectionAnchor, pruneNoteSelection, type NoteSelectionState } from "../app/workspace/note-list-selection";

const orderedIds = ["a", "b", "c", "d", "e"];

function state(ids: string[] = [], anchorId: string | null = null): NoteSelectionState {
  return { ids: new Set(ids), anchorId };
}

describe("note list selection", () => {
  test("plain click selects one note and establishes the range anchor", () => {
    const next = applyNoteSelectionClick(state(["a", "c"], "c"), orderedIds, { id: "d" });
    expect([...next.ids]).toEqual(["d"]);
    expect(next.anchorId).toBe("d");
  });

  test("opening a note keeps a range anchor without selecting it", () => {
    const anchor = noteSelectionAnchor("b");
    expect([...anchor.ids]).toEqual([]);
    expect(anchor.anchorId).toBe("b");
    const range = applyNoteSelectionClick(anchor, orderedIds, { id: "d", shiftKey: true });
    expect([...range.ids]).toEqual(["b", "c", "d"]);
  });

  test("Command or Ctrl clicks toggle non-contiguous notes", () => {
    const first = applyNoteSelectionClick(state(["a"], "a"), orderedIds, { id: "c", ctrlKey: true });
    expect([...first.ids]).toEqual(["a", "c"]);
    expect(first.anchorId).toBe("c");

    const second = applyNoteSelectionClick(first, orderedIds, { id: "a", metaKey: true });
    expect([...second.ids]).toEqual(["c"]);
    expect(second.anchorId).toBe("a");
  });

  test("plain clicks in active multi-select mode add or remove only the clicked note", () => {
    const added = applyNoteSelectionClick(state(["a", "c"], "a"), orderedIds, { id: "d", ctrlKey: true });
    expect([...added.ids]).toEqual(["a", "c", "d"]);

    const removed = applyNoteSelectionClick(added, orderedIds, { id: "c", ctrlKey: true });
    expect([...removed.ids]).toEqual(["a", "d"]);

    const empty = applyNoteSelectionClick(state(["c"], "c"), orderedIds, { id: "c", ctrlKey: true });
    expect([...empty.ids]).toEqual([]);
  });

  test("context menu selection toggles only its note and preserves the others", () => {
    const added = applyNoteSelectionClick(state(["a", "c"], "a"), orderedIds, { id: "d", ctrlKey: true });
    expect([...added.ids]).toEqual(["a", "c", "d"]);

    const removed = applyNoteSelectionClick(added, orderedIds, { id: "c", ctrlKey: true });
    expect([...removed.ids]).toEqual(["a", "d"]);
  });

  test("Shift click selects the inclusive range from the anchor", () => {
    const next = applyNoteSelectionClick(state(["b"], "b"), orderedIds, { id: "e", shiftKey: true });
    expect([...next.ids]).toEqual(["b", "c", "d", "e"]);
    expect(next.anchorId).toBe("b");
  });

  test("Shift click falls back to a single selection when the anchor is gone", () => {
    const next = applyNoteSelectionClick(state(["a"], "missing"), orderedIds, { id: "d", shiftKey: true });
    expect([...next.ids]).toEqual(["d"]);
    expect(next.anchorId).toBe("d");
  });

  test("pruning removes notes that left the current list", () => {
    const next = pruneNoteSelection(state(["a", "c", "e"], "c"), ["b", "c", "d"]);
    expect([...next.ids]).toEqual(["c"]);
    expect(next.anchorId).toBe("c");
  });
});
