import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type SqliteDatabase } from "../server/db";
import { handleRequest } from "../server/index";
import type { RealtimeHub } from "../server/realtime";

const environment: Record<string, string | undefined> = {
  XIANGYING_USERNAME: "owner",
  XIANGYING_PASSWORD: "a long passphrase 1234",
  XIANGYING_API_TOKEN: "memo-shortcut-token-1234567890",
};

let database: SqliteDatabase;
let clientAddress: string;

beforeEach(async () => {
  database = await openDatabase(":memory:");
  clientAddress = `memo-test-${crypto.randomUUID()}`;
});

afterEach(() => {
  database.close();
});

async function request(
  path: string,
  init: RequestInit = {},
  cookie?: string,
  targetEnvironment = environment,
  realtime?: RealtimeHub,
) {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("Cookie", cookie);
  const response = await handleRequest(
    new Request(`http://xiangying.test${path}`, { ...init, headers }),
    {
      database,
      environment: targetEnvironment,
      assetRoot: join(tmpdir(), "xiangying-memos-test-assets"),
      clientAddress,
      realtime,
    },
  );
  const body = (await response.json().catch(() => null)) as Record<string, any> | null;
  return { response, body, cookie: response.headers.get("Set-Cookie")?.split(";", 1)[0] };
}

async function login(targetEnvironment = environment) {
  const result = await request(
    "/api/auth/login",
    {
      method: "POST",
      body: JSON.stringify({
        username: targetEnvironment.XIANGYING_USERNAME,
        password: targetEnvironment.XIANGYING_PASSWORD,
      }),
    },
    undefined,
    targetEnvironment,
  );
  if (!result.cookie) throw new Error("login did not return a session cookie");
  return result.cookie;
}

async function createMemo(cookie: string, contentMarkdown: string, createdAt?: number) {
  return request(
    "/api/memos",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contentMarkdown, ...(createdAt === undefined ? {} : { createdAt }) }),
    },
    cookie,
  );
}

describe("Memo API", () => {
  test("creates, searches, filters, updates, facets, paginates, and deletes memos", async () => {
    const cookie = await login();
    const firstTime = Date.UTC(2026, 0, 1, 10, 0);
    const secondTime = Date.UTC(2026, 0, 1, 23, 30);
    const thirdTime = Date.UTC(2026, 0, 2, 2, 0);
    const first = await createMemo(cookie, "alpha 第一条 #工作 #项目", firstTime);
    const second = await createMemo(cookie, "beta 第二条 #工作", secondTime);
    const third = await createMemo(cookie, "gamma 第三条 #生活", thirdTime);
    expect(first.response.status).toBe(201);
    expect(second.response.status).toBe(201);
    expect(third.response.status).toBe(201);
    const firstMemo = first.body?.memo as { id: string; version: number } | undefined;
    const secondMemo = second.body?.memo as { id: string; version: number } | undefined;
    if (!firstMemo || !secondMemo) throw new Error("memo creation did not return memos");
    expect(first.body?.memo).toMatchObject({
      contentMarkdown: "alpha 第一条 #工作 #项目",
      tags: ["工作", "项目"],
      version: 1,
      createdAt: firstTime,
      updatedAt: firstTime,
    });

    const list = await request("/api/memos?limit=2", {}, cookie);
    expect(list.response.status).toBe(200);
    expect(
      list.body?.memos.map((memo: { contentMarkdown: string }) => memo.contentMarkdown),
    ).toEqual(["gamma 第三条 #生活", "beta 第二条 #工作"]);
    const nextCursor = list.body?.nextCursor as string | undefined;
    expect(typeof nextCursor).toBe("string");
    const next = await request(
      `/api/memos?limit=2&cursor=${encodeURIComponent(nextCursor!)}`,
      {},
      cookie,
    );
    expect(next.body?.memos).toHaveLength(1);
    expect(next.body?.memos[0].id).toBe(firstMemo.id);

    const search = await request("/api/memos?query=alpha", {}, cookie);
    expect(search.body?.memos).toHaveLength(1);
    expect(search.body?.memos[0].id).toBe(firstMemo.id);
    const shortSearch = await request(`/api/memos?query=${encodeURIComponent("第二")}`, {}, cookie);
    expect(shortSearch.body?.memos).toHaveLength(1);

    const tagged = await request(`/api/memos?tag=${encodeURIComponent("工作")}`, {}, cookie);
    expect(tagged.body?.memos.map((memo: { id: string }) => memo.id)).toEqual([
      secondMemo.id,
      firstMemo.id,
    ]);

    const facets = await request(
      `/api/memos/facets?from=${Date.UTC(2026, 0, 1)}&to=${Date.UTC(2026, 0, 3)}&timeZone=Asia%2FShanghai&tag=${encodeURIComponent("工作")}`,
      {},
      cookie,
    );
    expect(facets.response.status).toBe(200);
    expect(facets.body).toMatchObject({
      days: [
        { date: "2026-01-01", count: 1 },
        { date: "2026-01-02", count: 1 },
      ],
      tags: [
        { tag: "工作", count: 2 },
        { tag: "生活", count: 1 },
        { tag: "项目", count: 1 },
      ],
    });

    const updated = await request(
      `/api/memos/${firstMemo.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: firstMemo.version, contentMarkdown: "已更新 #生活" }),
      },
      cookie,
    );
    expect(updated.response.status).toBe(200);
    expect(updated.body?.memo).toMatchObject({ version: 2, tags: ["生活"] });
    expect((await request("/api/memos?query=alpha", {}, cookie)).body?.memos).toHaveLength(0);
    expect(
      (await request(`/api/memos?query=${encodeURIComponent("已更新")}`, {}, cookie)).body?.memos,
    ).toHaveLength(1);
    const stale = await request(
      `/api/memos/${firstMemo.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: 1, contentMarkdown: "过期写入" }),
      },
      cookie,
    );
    expect(stale.response.status).toBe(409);
    expect(stale.body?.error.code).toBe("VERSION_CONFLICT");

    const deleted = await request(
      `/api/memos/${secondMemo.id}`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: secondMemo.version }),
      },
      cookie,
    );
    expect(deleted.response.status).toBe(200);
    expect((await request("/api/memos", {}, cookie)).body?.memos).toHaveLength(2);
    expect((await request("/api/memos?query=beta", {}, cookie)).body?.memos).toHaveLength(0);
  });

  test("keeps memos private to their user", async () => {
    const ownerCookie = await login();
    const created = await createMemo(ownerCookie, "owner only #private");
    const createdMemo = created.body?.memo as { id: string } | undefined;
    if (!createdMemo) throw new Error("memo creation did not return a memo");
    const otherEnvironment = { ...environment, XIANGYING_USERNAME: "other" };
    const otherCookie = await login(otherEnvironment);
    expect(
      (await request("/api/memos", {}, otherCookie, otherEnvironment)).body?.memos,
    ).toHaveLength(0);
    const forbidden = await request(
      `/api/memos/${createdMemo.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: 1, contentMarkdown: "hijack" }),
      },
      otherCookie,
      otherEnvironment,
    );
    expect(forbidden.response.status).toBe(404);
  });

  test("imports shortcut payloads with the existing bearer token and replays idempotently", async () => {
    const raw = await request("/api/memos/import", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${environment.XIANGYING_API_TOKEN}`,
        "Content-Type": "text/markdown",
        "Idempotency-Key": "shortcut-1",
      },
      body: "快捷输入 alpha #快捷",
    });
    expect(raw.response.status).toBe(201);
    expect(raw.body?.memo).toMatchObject({
      contentMarkdown: "快捷输入 alpha #快捷",
      tags: ["快捷"],
    });

    const replay = await request("/api/memos/import", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${environment.XIANGYING_API_TOKEN}`,
        "Content-Type": "text/markdown",
        "Idempotency-Key": "shortcut-1",
      },
      body: "快捷输入 alpha #快捷",
    });
    expect(replay.response.status).toBe(200);
    expect(replay.response.headers.get("Idempotent-Replayed")).toBe("true");
    expect(replay.body?.memo.id).toBe(raw.body?.memo.id);

    const conflict = await request("/api/memos/import", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${environment.XIANGYING_API_TOKEN}`,
        "Content-Type": "text/plain",
        "Idempotency-Key": "shortcut-1",
      },
      body: "different body",
    });
    expect(conflict.response.status).toBe(409);
    expect(conflict.body?.error.code).toBe("IDEMPOTENCY_CONFLICT");

    const createdAt = Date.UTC(2025, 11, 31, 12, 0);
    const jsonImport = await request("/api/memos/import", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${environment.XIANGYING_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ contentMarkdown: "json import #快捷", createdAt }),
    });
    expect(jsonImport.response.status).toBe(201);
    expect(jsonImport.body?.memo.createdAt).toBe(createdAt);

    const unauthorized = await request("/api/memos/import", {
      method: "POST",
      headers: { Authorization: "Bearer wrong", "Content-Type": "text/plain" },
      body: "nope",
    });
    expect(unauthorized.response.status).toBe(401);
  });

  test("publishes memo changes on the workspace realtime channel", async () => {
    const changes: Array<{ userId: string; resource: string }> = [];
    const realtime = {
      publish(userId: string, change: { resource: string }) {
        changes.push({ userId, resource: change.resource });
      },
    } as unknown as RealtimeHub;
    const cookie = await login();
    const created = await request(
      "/api/memos",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentMarkdown: "realtime #测试" }),
      },
      cookie,
      environment,
      realtime,
    );
    expect(created.response.status).toBe(201);
    expect(changes.at(-1)).toMatchObject({ resource: "memos" });
  });
});
