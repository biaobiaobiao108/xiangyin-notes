import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type SqliteDatabase } from "../server/db";
import { handleRequest } from "../server/index";

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
});
