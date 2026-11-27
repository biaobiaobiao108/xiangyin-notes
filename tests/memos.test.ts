import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NOTE_CONTENT_MAX_LENGTH } from "../server/core";
import { openDatabase, type SqliteDatabase } from "../server/db";
import { handleRequest } from "../server/index";
import { validateMemoCreatedAtPayload } from "../server/routes/memos";
import { localDateKey } from "../app/memos/memo-date";
import type { RealtimeHub } from "../server/realtime";

const environment: Record<string, string | undefined> = {
  XIANGYING_USERNAME: "owner",
  XIANGYING_PASSWORD: "a long passphrase 1234",
  XIANGYING_API_TOKEN: "memo-shortcut-token-1234567890",
};

let database: SqliteDatabase;
let clientAddress: string;
let assetRoot: string;

beforeEach(async () => {
  database = await openDatabase(":memory:");
  clientAddress = `memo-test-${crypto.randomUUID()}`;
  assetRoot = await mkdtemp(join(tmpdir(), "xiangying-memos-test-assets-"));
});

afterEach(async () => {
  database.close();
  await rm(assetRoot, { recursive: true, force: true });
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
      assetRoot,
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
  test("accepts valid historical creation times and rejects invalid dates", () => {
    const now = Date.UTC(2026, 0, 10, 12, 0);
    expect(validateMemoCreatedAtPayload(undefined, now)).toBe(now);
    expect(validateMemoCreatedAtPayload(now - 60_000, now)).toBe(now - 60_000);
    expect(validateMemoCreatedAtPayload(now + 60_000, now)).toBe(now + 60_000);
    expect(validateMemoCreatedAtPayload(now - 7 * 24 * 60 * 60 * 1000, now)).toBe(
      now - 7 * 24 * 60 * 60 * 1000,
    );
    expect(validateMemoCreatedAtPayload(-1, now)).toBeNull();
    expect(validateMemoCreatedAtPayload(8.64e15 + 1, now)).toBeNull();
    expect(validateMemoCreatedAtPayload("2026-01-10", now)).toBeNull();
  });

  test("replays a matching creation ID and rejects a different payload", async () => {
    const cookie = await login();
    const id = crypto.randomUUID();
    const createdAt = Date.now() - 7 * 86400000;
    const create = (contentMarkdown: string, time = createdAt) =>
      request(
        "/api/memos",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, contentMarkdown, createdAt: time }),
        },
        cookie,
      );
    const first = await create("历史随记");
    expect(first.response.status).toBe(201);
    const replay = await create("历史随记");
    expect(replay.response.status).toBe(200);
    expect(replay.body?.memo).toEqual(first.body?.memo);
    expect((await create("其他内容")).response.status).toBe(409);
    expect((await create("历史随记", createdAt + 1)).response.status).toBe(409);
    expect((await request("/api/memos", {}, cookie)).body?.memos).toHaveLength(1);
  });

  test("serializes concurrent same-ID memo creation without a server error", async () => {
    const cookie = await login();
    const id = crypto.randomUUID();
    const create = () =>
      request(
        "/api/memos",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, contentMarkdown: "并发随记" }),
        },
        cookie,
      );
    const results = await Promise.all([create(), create()]);
    expect(results.map(({ response }) => response.status).sort()).toEqual([200, 201]);
    expect((await request("/api/memos", {}, cookie)).body?.memos).toHaveLength(1);
  });

  test("converts a memo atomically into an inbox note with indexed content", async () => {
    const cookie = await login();
    const markdown = "转换正文 #项目\n\n- [ ] 待办";
    const created = await createMemo(cookie, markdown);
    const memo = created.body!.memo;
    const convert = (version: number) =>
      request(
        `/api/memos/${memo.id}/convert`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ version }),
        },
        cookie,
      );
    const stale = await convert(2);
    expect(stale.response.status).toBe(409);
    expect((await request("/api/memos", {}, cookie)).body?.memos).toHaveLength(1);
    const result = await convert(1);
    expect(result.response.status).toBe(201);
    expect(result.body?.note).toMatchObject({ title: "", contentMarkdown: markdown, version: 1 });
    const notebook = database
      .query("SELECT is_system FROM notebooks WHERE id = ?")
      .get(result.body!.note.notebookId) as { is_system: number };
    expect(notebook.is_system).toBe(1);
    expect((await request("/api/memos", {}, cookie)).body?.memos).toHaveLength(0);
    expect(
      (await request(`/api/notes?view=all&query=${encodeURIComponent("转换正文")}`, {}, cookie))
        .body?.notes,
    ).toHaveLength(1);
    const replay = await convert(1);
    expect(replay.response.status).toBe(200);
    expect(replay.body?.note?.id).toBe(result.body?.note?.id);
    expect((await convert(2)).response.status).toBe(404);
    expect(
      (await request(`/api/notes?view=all&query=${encodeURIComponent("转换正文")}`, {}, cookie))
        .body?.notes,
    ).toHaveLength(1);
  });

  test("rejects new missing attachment references on create, edit and import", async () => {
    const cookie = await login();
    const contentMarkdown = `![图片](/api/assets/${crypto.randomUUID()})`;
    const rejected = await createMemo(cookie, contentMarkdown);
    expect(rejected.response.status).toBe(400);
    expect(rejected.body?.error.code).toBe("INVALID_ASSET");

    const memo = (await createMemo(cookie, "原正文")).body!.memo;
    const edit = (markdown: string) =>
      request(
        `/api/memos/${memo.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({ version: memo.version, contentMarkdown: markdown }),
        },
        cookie,
      );
    const patched = await edit(contentMarkdown);
    expect(patched.response.status).toBe(400);
    expect(patched.body?.error.code).toBe("INVALID_ASSET");
    const imported = await request("/api/memos/import", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${environment.XIANGYING_API_TOKEN}`,
        "Content-Type": "text/markdown",
      },
      body: contentMarkdown,
    });
    expect(imported.response.status).toBe(400);
    expect(imported.body?.error.code).toBe("INVALID_ASSET");
    expect((await request("/api/memos", {}, cookie)).body?.memos).toEqual([memo]);

    database
      .query("UPDATE memos SET content_markdown = ? WHERE id = ?")
      .run(contentMarkdown, memo.id);
    expect((await edit(`补充正文\n\n${contentMarkdown}`)).response.status).toBe(200);
  });

  test("rejects conversion of a legacy memo with missing attachments without removing it", async () => {
    const cookie = await login();
    const memo = (await createMemo(cookie, "旧随记")).body!.memo;
    database
      .query("UPDATE memos SET content_markdown = ? WHERE id = ?")
      .run(`![图片](/api/assets/${crypto.randomUUID()})`, memo.id);
    const result = await request(
      `/api/memos/${memo.id}/convert`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: memo.version }),
      },
      cookie,
    );
    expect(result.response.status).toBe(400);
    expect(result.body?.error.code).toBe("INVALID_ASSET");
    expect((await request("/api/memos", {}, cookie)).body?.memos).toHaveLength(1);
  });

  test("copies an attachment already owned by another note when converting a memo", async () => {
    const cookie = await login();
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
      "base64",
    );
    const form = new FormData();
    form.append("file", new File([new Uint8Array(png)], "sample.png", { type: "image/png" }));
    const upload = await request("/api/assets", { method: "POST", body: form }, cookie);
    expect(upload.response.status).toBe(201);
    const originalUrl = upload.body!.asset.url;
    const create = await request(
      "/api/notes",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "原笔记", contentMarkdown: `![样本](${originalUrl})` }),
      },
      cookie,
    );
    expect(create.response.status).toBe(201);
    const original = create.body!.note;
    const memo = (await createMemo(cookie, `![样本](${originalUrl})\n\n原路径 ${originalUrl}`))
      .body!.memo;
    const convert = () =>
      request(
        `/api/memos/${memo.id}/convert`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ version: memo.version }),
        },
        cookie,
      );

    const directory = join(assetRoot, (await readdir(assetRoot))[0]!);
    const originalFiles = await readdir(directory);
    database.exec(
      "CREATE TRIGGER reject_conversion BEFORE DELETE ON memos BEGIN SELECT RAISE(ABORT, 'test failure'); END",
    );
    expect((await convert()).response.status).toBe(500);
    expect(await readdir(directory)).toEqual(originalFiles);
    expect((await request("/api/memos", {}, cookie)).body?.memos).toHaveLength(1);
    database.exec("DROP TRIGGER reject_conversion");

    const conversion = await convert();
    expect(conversion.response.status).toBe(201);
    const note = conversion.body!.note;
    const copy = database
      .query<{ id: string; storage_path: string }, [string]>(
        "SELECT id, storage_path FROM image_assets WHERE note_id = ?",
      )
      .get(note.id)!;
    expect(note.contentMarkdown).toBe(`![样本](/api/assets/${copy.id})\n\n原路径 ${originalUrl}`);
    expect(`/api/assets/${copy.id}`).not.toBe(originalUrl);
    expect(Buffer.from(await Bun.file(join(assetRoot, copy.storage_path)).arrayBuffer())).toEqual(
      png,
    );
    expect((await request(`/api/notes/${original.id}`, {}, cookie)).body?.note).toEqual(original);
    expect((await request(originalUrl, {}, cookie)).response.status).toBe(200);
    expect((await request("/api/memos", {}, cookie)).body?.memos).toHaveLength(0);
  });

  test("rolls back the new note if removing the memo fails", async () => {
    const cookie = await login();
    const memo = (await createMemo(cookie, "保留原文")).body!.memo;
    database.exec(
      "CREATE TRIGGER reject_conversion BEFORE DELETE ON memos BEGIN SELECT RAISE(ABORT, 'test failure'); END",
    );
    const result = await request(
      `/api/memos/${memo.id}/convert`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: memo.version }),
      },
      cookie,
    );
    expect(result.response.status).toBe(500);
    expect((await request("/api/memos", {}, cookie)).body?.memos).toHaveLength(1);
    expect(
      (await request(`/api/notes?view=all&query=${encodeURIComponent("保留原文")}`, {}, cookie))
        .body?.notes,
    ).toHaveLength(0);
  });

  test("creates, searches, filters, updates, facets, paginates, and deletes memos", async () => {
    const cookie = await login();
    const now = Date.now();
    const midnight = new Date(now).setHours(0, 0, 0, 0);
    const firstTime = midnight - 24 * 60 * 60 * 1000 + 10 * 60 * 60 * 1000;
    const secondTime = midnight + 23 * 60 * 60 * 1000;
    const thirdTime = midnight + 24 * 60 * 60 * 1000 + 2 * 60 * 60 * 1000;
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
      `/api/memos/facets?from=${firstTime - 60_000}&to=${thirdTime + 60_000}&timeZone=Asia%2FShanghai&tag=${encodeURIComponent("工作")}`,
      {},
      cookie,
    );
    expect(facets.response.status).toBe(200);
    expect(facets.body).toMatchObject({
      days: [
        { date: localDateKey(firstTime), count: 1 },
        { date: localDateKey(thirdTime), count: 1 },
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

  test("finds short terms past the short-index content limit", async () => {
    const cookie = await login();
    const contentMarkdown = `${"a".repeat(40_100)}猫猫`;
    const created = await createMemo(cookie, contentMarkdown);
    expect(created.response.status).toBe(201);
    const search = await request(`/api/memos?query=${encodeURIComponent("猫猫")}`, {}, cookie);
    expect(search.response.status).toBe(200);
    expect(search.body?.memos.map((memo: { id: string }) => memo.id)).toEqual([
      created.body?.memo.id,
    ]);
  });

  test("counts facet days across daylight saving changes", async () => {
    const cookie = await login();
    for (const createdAt of [
      Date.parse("2026-03-07T04:30:00Z"),
      Date.parse("2026-03-07T05:30:00Z"),
      Date.parse("2026-03-08T04:30:00Z"),
      Date.parse("2026-03-08T07:30:00Z"),
      Date.parse("2026-03-09T04:30:00Z"),
    ])
      expect((await createMemo(cookie, "dst", createdAt)).response.status).toBe(201);
    const facets = await request(
      `/api/memos/facets?from=${Date.parse("2026-03-06T05:00:00Z")}&to=${Date.parse("2026-03-10T04:00:00Z")}&timeZone=America%2FNew_York`,
      {},
      cookie,
    );
    expect(facets.response.status).toBe(200);
    expect(facets.body?.days).toEqual([
      { date: "2026-03-06", count: 1 },
      { date: "2026-03-07", count: 2 },
      { date: "2026-03-08", count: 1 },
      { date: "2026-03-09", count: 1 },
    ]);
  });

  test("does not count the previous day when a time zone skips midnight", async () => {
    const cookie = await login();
    for (const instant of ["2024-03-30T21:30:00Z", "2024-03-30T22:30:00Z"])
      expect((await createMemo(cookie, "dst", Date.parse(instant))).response.status).toBe(201);
    const params = new URLSearchParams({
      from: String(Date.parse("2024-03-30T00:00:00Z")),
      to: String(Date.parse("2024-04-01T00:00:00Z")),
      timeZone: "Asia/Beirut",
    });
    const facets = await request(`/api/memos/facets?${params}`, {}, cookie);
    expect(facets.response.status).toBe(200);
    expect(facets.body?.days).toEqual([
      { date: "2024-03-30", count: 1 },
      { date: "2024-03-31", count: 1 },
    ]);
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

    const createdAt = Date.now();
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

  test("distinguishes empty memo content from oversized memo content", async () => {
    const cookie = await login();
    const emptyCreate = await request(
      "/api/memos",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentMarkdown: "   " }),
      },
      cookie,
    );
    expect(emptyCreate.response.status).toBe(400);
    expect(emptyCreate.body).toMatchObject({ error: { code: "EMPTY_MEMO" } });

    const oversizedCreate = await request(
      "/api/memos",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentMarkdown: "a".repeat(NOTE_CONTENT_MAX_LENGTH + 1) }),
      },
      cookie,
    );
    expect(oversizedCreate.response.status).toBe(413);
    expect(oversizedCreate.body).toMatchObject({ error: { code: "MEMO_TOO_LARGE" } });

    const created = await createMemo(cookie, "待更新内容");
    expect(created.response.status).toBe(201);
    const memoId = created.body?.memo.id as string;
    const memoVersion = created.body?.memo.version as number;
    const emptyPatch = await request(
      `/api/memos/${memoId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contentMarkdown: "",
          version: memoVersion,
        }),
      },
      cookie,
    );
    expect(emptyPatch.response.status).toBe(400);
    expect(emptyPatch.body).toMatchObject({ error: { code: "EMPTY_MEMO" } });

    const oversizedPatch = await request(
      `/api/memos/${memoId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contentMarkdown: "a".repeat(NOTE_CONTENT_MAX_LENGTH + 1),
          version: memoVersion,
        }),
      },
      cookie,
    );
    expect(oversizedPatch.response.status).toBe(413);
    expect(oversizedPatch.body).toMatchObject({ error: { code: "MEMO_TOO_LARGE" } });
  });
});
