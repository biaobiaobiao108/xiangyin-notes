import { describe, expect, test } from "bun:test";
import { moveSelectedNotes } from "../app/workspace/move-selected-notes";

describe("move selected notes", () => {
  test("flushes and saves drafts before moving", async () => {
    const calls: string[] = [];
    const result = await moveSelectedNotes(["note-1", "note-2"], {
      flushEditorDraft: () => calls.push("flush"),
      saveNote: async (id) => calls.push(`save:${id}`),
      moveNote: async (id) => {
        calls.push(`move:${id}`);
        return true;
      },
    });

    expect(result).toEqual({ movedIds: ["note-1", "note-2"], failures: [] });
    expect(calls).toEqual(["flush", "save:note-1", "save:note-2", "move:note-1", "move:note-2"]);
  });

  test("reports confirmed moves alongside any failures and skips unchanged notes", async () => {
    const failure = new Error("version conflict");
    const result = await moveSelectedNotes(["note-1", "note-2", "note-3"], {
      flushEditorDraft: () => {},
      saveNote: async () => {},
      moveNote: async (id) => {
        if (id === "note-2") throw failure;
        return id === "note-1";
      },
    });

    expect(result).toEqual({ movedIds: ["note-1"], failures: [failure] });
  });

  test("does not move notes after a save fails", async () => {
    const failure = new Error("save conflict");
    const calls: string[] = [];
    const result = await moveSelectedNotes(["note-1", "note-2"], {
      flushEditorDraft: () => calls.push("flush"),
      saveNote: async (id) => {
        calls.push(`save:${id}`);
        if (id === "note-2") throw failure;
      },
      moveNote: async (id) => {
        calls.push(`move:${id}`);
        return true;
      },
    });

    expect(result).toEqual({ movedIds: [], failures: [failure] });
    expect(calls).toEqual(["flush", "save:note-1", "save:note-2"]);
  });
});
