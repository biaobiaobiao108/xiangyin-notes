import { describe, expect, test } from "bun:test";
import { orderSyncMutations } from "../app/offline-sync";
import type { SyncMutation } from "../shared/sync";

function mutation(operationId: string, entity: SyncMutation["entity"], action: SyncMutation["action"]): SyncMutation {
  return { operationId, entity, action, entityId: `${entity}-${operationId}` };
}

describe("offline sync mutation ordering", () => {
  test("creates notebooks before note writes and deletes notebooks last", () => {
    const ordered = orderSyncMutations([
      mutation("delete-notebook", "notebook", "delete"),
      mutation("move-note", "note", "upsert"),
      mutation("create-notebook", "notebook", "upsert"),
      mutation("delete-note", "note", "delete"),
    ]);

    expect(ordered.map((item) => item.operationId)).toEqual([
      "create-notebook",
      "move-note",
      "delete-note",
      "delete-notebook",
    ]);
  });
});
