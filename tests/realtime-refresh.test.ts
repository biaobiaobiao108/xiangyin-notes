import { describe, expect, test } from "bun:test";
import {
  accumulateRealtimeRefresh,
  emptyRealtimeRefreshPlan,
} from "../app/workspace/realtime-refresh";

describe("workspace realtime refresh plan", () => {
  test("requeries search membership for note updates, including notes outside the loaded results", () => {
    for (const noteId of ["matching-result", "previously-unmatched-note"]) {
      const plan = accumulateRealtimeRefresh(
        emptyRealtimeRefreshPlan(),
        { type: "workspace.changed", revision: 1, resource: "notes", noteId },
        true,
      );
      expect(plan.notes).toBe(true);
      expect([...plan.noteIds]).toEqual([noteId]);
    }
  });

  test("a note event with an id only patches that row", () => {
    const plan = accumulateRealtimeRefresh(emptyRealtimeRefreshPlan(), {
      type: "workspace.changed",
      revision: 1,
      resource: "notes",
      noteId: "note-a",
    });
    expect(plan.notes).toBe(false);
    expect(plan.notebooks).toBe(false);
    expect(plan.selected).toBe(false);
    expect([...plan.noteIds]).toEqual(["note-a"]);
  });

  test("a note event without an id reloads the list because order may change", () => {
    const plan = accumulateRealtimeRefresh(emptyRealtimeRefreshPlan(), {
      type: "workspace.changed",
      revision: 2,
      resource: "notes",
    });
    expect(plan.notes).toBe(true);
    expect(plan.noteIds.size).toBe(0);
  });

  test("notebook changes still reload the list for renamed notebook labels", () => {
    const plan = accumulateRealtimeRefresh(emptyRealtimeRefreshPlan(), {
      type: "workspace.changed",
      revision: 3,
      resource: "notebooks",
    });
    expect(plan.notebooks).toBe(true);
    expect(plan.notes).toBe(true);
  });

  test("a lifecycle reconcile without a message refreshes everything", () => {
    const plan = accumulateRealtimeRefresh(emptyRealtimeRefreshPlan());
    expect(plan.notebooks).toBe(true);
    expect(plan.notes).toBe(true);
    expect(plan.selected).toBe(true);
  });

  test("events arriving inside one debounce window accumulate", () => {
    const plan = emptyRealtimeRefreshPlan();
    accumulateRealtimeRefresh(plan, {
      type: "workspace.changed",
      revision: 4,
      resource: "notes",
      noteId: "note-a",
    });
    accumulateRealtimeRefresh(plan, {
      type: "workspace.changed",
      revision: 5,
      resource: "notes",
      noteId: "note-b",
    });
    accumulateRealtimeRefresh(plan, {
      type: "workspace.changed",
      revision: 6,
      resource: "notes",
      noteId: "note-a",
    });
    expect([...plan.noteIds].sort()).toEqual(["note-a", "note-b"]);
    expect(plan.notes).toBe(false);
  });
});
