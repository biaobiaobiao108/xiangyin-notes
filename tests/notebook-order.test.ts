import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type SqliteDatabase } from "../server/db";
import { handleRequest } from "../server/index";
import { calculateNotebookTargetIndex } from "../app/workspace/use-notebook-reorder";

let database: SqliteDatabase;
let assetRoot: string;
const environment = { XIANGYING_USERNAME: "owner", XIANGYING_PASSWORD: "a long passphrase 1234" };

beforeEach(async () => {
  database = await openDatabase(":memory:");
  assetRoot = join(tmpdir(), `xiangying-notebook-order-${crypto.randomUUID()}`);
});
afterEach(async () => {
  database.close();
  await rm(assetRoot, { recursive: true, force: true });
});

async function api(path: string, init: RequestInit = {}, cookie?: string) {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("Cookie", cookie);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return handleRequest(new Request(`http://localhost${path}`, { ...init, headers }), {
    database,
    environment,
    assetRoot,
    clientAddress: "127.0.0.1",
  });
}
async function login() {
  const response = await api("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "owner", password: environment.XIANGYING_PASSWORD }),
  });
  return response.headers.get("Set-Cookie")!;
}
async function createNotebook(cookie: string, name: string) {
  const response = await api(
    "/api/notebooks",
    { method: "POST", body: JSON.stringify({ name }) },
    cookie,
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { notebook: { id: string } }).notebook.id;
}
async function list(cookie: string) {
  return (
    (await (await api("/api/notebooks", {}, cookie)).json()) as {
      notebooks: Array<{ id: string; isSystem: boolean }>;
    }
  ).notebooks;
}

describe("notebook ordering", () => {
  test("persists a complete custom order and appends later notebooks", async () => {
    const cookie = await login();
    const a = await createNotebook(cookie, "甲");
    const b = await createNotebook(cookie, "乙");
    const expectedIds = [a, b];
    const response = await api(
      "/api/notebooks/reorder",
      {
        method: "PATCH",
        body: JSON.stringify({ ids: [b, a], expectedIds }),
      },
      cookie,
    );
    expect(response.status).toBe(200);
    const ordered = await list(cookie);
    expect(ordered.filter((item) => !item.isSystem).map((item) => item.id)).toEqual([b, a]);
    expect(ordered[0].isSystem).toBe(true);
    const c = await createNotebook(cookie, "丙");
    expect((await list(cookie)).filter((item) => !item.isSystem).map((item) => item.id)).toEqual([
      b,
      a,
      c,
    ]);
  });

  test("rejects stale snapshots without partially changing the order", async () => {
    const cookie = await login();
    const a = await createNotebook(cookie, "甲");
    const b = await createNotebook(cookie, "乙");
    await createNotebook(cookie, "丙");
    const response = await api(
      "/api/notebooks/reorder",
      {
        method: "PATCH",
        body: JSON.stringify({ ids: [b, a], expectedIds: [a, b] }),
      },
      cookie,
    );
    expect(response.status).toBe(409);
    expect((await list(cookie)).filter((item) => !item.isSystem).map((item) => item.id)).toEqual([
      a,
      b,
      expect.any(String),
    ]);
  });

  test("rejects duplicates, omissions, system and foreign IDs", async () => {
    const cookie = await login();
    const a = await createNotebook(cookie, "甲");
    const b = await createNotebook(cookie, "乙");
    const snapshot = [a, b];
    const inbox = (await list(cookie)).find((item) => item.isSystem)!.id;
    for (const ids of [[a, a], [a], [a, b, inbox], [a, "foreign"]]) {
      const response = await api(
        "/api/notebooks/reorder",
        {
          method: "PATCH",
          body: JSON.stringify({ ids, expectedIds: snapshot }),
        },
        cookie,
      );
      expect(response.status).toBe(400);
      expect((await list(cookie)).filter((item) => !item.isSystem).map((item) => item.id)).toEqual(
        snapshot,
      );
    }
  });

  test("rejects stale notebook metadata updates", async () => {
    const cookie = await login();
    const notebookId = await createNotebook(cookie, "并发测试");
    database
      .query("UPDATE notebooks SET updated_at = ? WHERE id = ?")
      .run(1_700_000_000, notebookId);

    const missingVersion = await api(
      `/api/notebooks/${notebookId}`,
      { method: "PATCH", body: JSON.stringify({ name: "缺少版本" }) },
      cookie,
    );
    expect(missingVersion.status).toBe(400);
    expect(((await missingVersion.json()) as { error: { code: string } }).error.code).toBe(
      "INVALID_NOTEBOOK_VERSION",
    );

    const first = await api(
      `/api/notebooks/${notebookId}`,
      {
        method: "PATCH",
        body: JSON.stringify({ name: "并发测试（新）", expectedUpdatedAt: 1_700_000_000 }),
      },
      cookie,
    );
    expect(first.status).toBe(200);
    const updated = ((await first.json()) as { notebook: { updatedAt: number } }).notebook;

    const stale = await api(
      `/api/notebooks/${notebookId}`,
      {
        method: "PATCH",
        body: JSON.stringify({ name: "过期修改", expectedUpdatedAt: 1_700_000_000 }),
      },
      cookie,
    );
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe(
      "NOTEBOOK_CHANGED",
    );

    const current = await api(
      `/api/notebooks/${notebookId}`,
      {
        method: "PATCH",
        body: JSON.stringify({ name: "最终名称", expectedUpdatedAt: updated.updatedAt }),
      },
      cookie,
    );
    expect(current.status).toBe(200);
  });
});

describe("notebook drag target calculation", () => {
  const sampleSlots = [
    { top: 100, height: 40 }, // mid 120
    { top: 140, height: 40 }, // mid 160
    { top: 180, height: 40 }, // mid 200
    { top: 220, height: 40 }, // mid 240
  ];

  test("maintains destination in vacant slot when moving slightly up and does not prematurely avoid item above", () => {
    // Drag item 0 downwards. Crossing threshold (midpoint 140 + hysteresis 8 = 148) targets slot 1.
    const movedDown = calculateNotebookTargetIndex(sampleSlots, 0, 0, 150);
    expect(movedDown).toBe(1);

    // Now pointer is in slot 1 (range 140..180). Moving slightly UP inside slot 1 (e.g. center = 142)
    // must stay in slot 1 and NOT jump back to slot 0!
    const moveUpInHole = calculateNotebookTargetIndex(sampleSlots, 0, 1, 142);
    expect(moveUpInHole).toBe(1);

    // Only moving distinctly into slot 0 past upper threshold (140 - 8 = 132) switches back to 0.
    const backToZero = calculateNotebookTargetIndex(sampleSlots, 0, 1, 130);
    expect(backToZero).toBe(0);
  });

  test("maintains destination when dragging upwards with hysteresis", () => {
    // Drag item 3 upwards towards slot 2 (midpoint 220 - hysteresis 8 = 212).
    const movedUp = calculateNotebookTargetIndex(sampleSlots, 3, 3, 210);
    expect(movedUp).toBe(2);

    // Moving slightly down inside slot 2 (e.g. center = 218) must stay in slot 2.
    const moveDownInHole = calculateNotebookTargetIndex(sampleSlots, 3, 2, 218);
    expect(moveDownInHole).toBe(2);

    // Moving past lower threshold (220 + 8 = 228) switches back to 3.
    const backToThree = calculateNotebookTargetIndex(sampleSlots, 3, 2, 230);
    expect(backToThree).toBe(3);
  });

  test("clamps safely when dragging beyond top and bottom boundaries", () => {
    expect(calculateNotebookTargetIndex(sampleSlots, 1, 1, -50)).toBe(0);
    expect(calculateNotebookTargetIndex(sampleSlots, 1, 1, 500)).toBe(3);
  });

  test("handles fast flick directly across multiple slots", () => {
    // Fast flick from slot 0 to near slot 3 (center = 242)
    expect(calculateNotebookTargetIndex(sampleSlots, 0, 0, 242)).toBe(3);
  });
});
