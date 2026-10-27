import { describe, expect, test } from "bun:test";
import { moveSelectedNotes } from "../app/workspace/move-selected-notes";

describe("move selected notes", () => {
  test("flushes and saves drafts before moving with the saved versions", async () => {
    const calls: string[] = [];
    const versions = new Map([
      ["note-1", 1],
      ["note-2", 3],
    ]);

    const result = await moveSelectedNotes(["note-1", "note-2"], {
      flushEditorDraft: () => calls.push("flush"),
      saveNote: async (id) => {
        calls.push(`save:${id}`);
        versions.set(id, versions.get(id)! + 1);
      },
      getVersion: (id) => versions.get(id),
      moveNote: async (id, version) => calls.push(`move:${id}:v${version}`),
      refresh: () => calls.push("refresh"),
    });

    expect(result).toEqual({});
    expect(calls).toEqual([
      "flush",
      "save:note-1",
      "save:note-2",
      "move:note-1:v2",
      "move:note-2:v4",
      "refresh",
    ]);
  });

  test("refreshes after partial move failures and reports the failure", async () => {
    const failure = new Error("version conflict");
    const calls: string[] = [];
    const result = await moveSelectedNotes(["note-1", "note-2"], {
      flushEditorDraft: () => calls.push("flush"),
      saveNote: async (id) => calls.push(`save:${id}`),
      getVersion: () => 2,
      moveNote: async (id) => {
        calls.push(`move:${id}`);
        if (id === "note-2") throw failure;
      },
      refresh: () => calls.push("refresh"),
    });

    expect(result).toEqual({ error: failure, failed: true });
    expect(calls).toEqual([
      "flush",
      "save:note-1",
      "save:note-2",
      "move:note-1",
      "move:note-2",
      "refresh",
    ]);
  });

  test("does not move notes after a save fails and refreshes successful saves", async () => {
    const failure = new Error("save conflict");
    const calls: string[] = [];
    const result = await moveSelectedNotes(["note-1", "note-2"], {
      flushEditorDraft: () => calls.push("flush"),
      saveNote: async (id) => {
        calls.push(`save:${id}`);
        if (id === "note-2") throw failure;
      },
      getVersion: () => 2,
      moveNote: async (id) => calls.push(`move:${id}`),
      refresh: () => calls.push("refresh"),
    });

    expect(result).toEqual({ error: failure, failed: true });
    expect(calls).toEqual(["flush", "save:note-1", "save:note-2", "refresh"]);
  });
});
