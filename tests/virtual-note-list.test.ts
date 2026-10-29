import { describe, expect, test } from "bun:test";
import type { NoteSummary } from "../shared/types";
import type { NoteGroup } from "../app/workspace/helpers";
import {
  flattenNoteGroups,
  noteGroupRowId,
  offsetsForRows,
} from "../app/workspace/use-virtual-note-list";

function note(id: string): NoteSummary {
  return {
    id,
    title: `笔记 ${id}`,
    preview: "",
    tags: [],
    thumbnail: null,
    notebookId: "notebook-1",
    notebookName: "笔记本",
    isFavorite: false,
    deletedAt: null,
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

function group(id: string, ...notes: NoteSummary[]): NoteGroup {
  return { id, title: id, count: notes.length, notes };
}

describe("virtual note list groups", () => {
  test("omits empty groups so they do not leave virtual headers", () => {
    const empty = group("empty");
    const populated = group("populated", note("note-a"));

    expect(flattenNoteGroups([empty, populated], new Set()).map((row) => row.id)).toEqual([
      noteGroupRowId("populated"),
      "note-a",
    ]);
  });

  test("keeps visible group header rows before expanded notes", () => {
    const first = group("group-a", note("note-a1"), note("note-a2"));
    const second = group("group-b", note("note-b1"));

    const rows = flattenNoteGroups([first, second], new Set());

    expect(rows.map((row) => row.id)).toEqual([
      noteGroupRowId("group-a"),
      "note-a1",
      "note-a2",
      noteGroupRowId("group-b"),
      "note-b1",
    ]);
    expect(rows[0]).toMatchObject({ kind: "group", firstGroup: true });
    expect(rows[3]).toMatchObject({ kind: "group", firstGroup: false });
  });

  test("keeps collapsed group buttons and omits their notes", () => {
    const first = group("group-a", note("note-a1"));
    const second = group("group-b", note("note-b1"));

    const rows = flattenNoteGroups([first, second], new Set(["group-a"]));

    expect(rows.map((row) => row.id)).toEqual([
      noteGroupRowId("group-a"),
      noteGroupRowId("group-b"),
      "note-b1",
    ]);
  });

  test("retains notes while a group is playing its collapse animation", () => {
    const groupToCollapse = group("group-a", note("note-a1"), note("note-a2"));

    const rows = flattenNoteGroups([groupToCollapse], new Set(["group-a"]), "group-a");

    expect(rows.map((row) => row.id)).toEqual([noteGroupRowId("group-a"), "note-a1", "note-a2"]);
  });
});

test("group animation height matches measured notes without extra spacing", () => {
  const rows = flattenNoteGroups(
    [group("a", note("a1"), note("a2")), group("b", note("b1"))],
    new Set(),
  );
  const offsets = offsetsForRows(
    rows,
    new Map([
      ["a1", 100],
      ["a2", 120],
      ["b1", 80],
    ]),
  );
  expect(offsets).toEqual([0, 0, 100, 220, 250, 330]);
  expect(offsets[3]! - offsets[1]!).toBe(220);
});
