import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations, openDatabase, reclaimDatabaseSpace, type SqliteDatabase } from "../server/db";
import { handleRequest } from "../server/index";
import { MAX_SHORT_TERM_CONTENT_CHARS, MAX_SHORT_TERMS_PER_NOTE } from "../server/note-search";
import { IMAGE_UPLOAD_MAX_BODY_BYTES } from "../server/routes/assets";
import { IMPORT_RATE_LIMIT_MAX_REQUESTS } from "../server/routes/import";
import { cleanupExpiredShares, EXPIRED_SHARE_PURGE_SECONDS } from "../server/routes/shares";

let database: SqliteDatabase;
let assetRoot: string;
let clientAddress: string;
const environment: Record<string, string | undefined> = { XIANGYING_USERNAME: "owner", XIANGYING_PASSWORD: "a long passphrase 1234" };
const ONE_PIXEL_PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="), (character) => character.charCodeAt(0));

function imageForm(name = "cat.png", bytes = ONE_PIXEL_PNG, mimeType = "image/png") {
  const formData = new FormData();
  formData.append("file", new File([bytes], name, { type: mimeType }));
  return formData;
}

beforeEach(async () => {
  database = await openDatabase(":memory:");
  await applyMigrations(database);
  assetRoot = join(tmpdir(), `xiangying-notes-assets-${crypto.randomUUID()}`);
  clientAddress = `test-${crypto.randomUUID()}`;
});

afterEach(async () => {
  database.close();
  await rm(assetRoot, { recursive: true, force: true });
});

async function request(path: string, init: RequestInit = {}, cookie?: string, targetEnvironment = environment, origin = "http://xiangying.test", targetClientRoot = "dist/client") {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("Cookie", cookie);
  const response = await handleRequest(new Request(`${origin}${path}`, { ...init, headers }), { database, environment: targetEnvironment, clientRoot: targetClientRoot, assetRoot, clientAddress });
  const body = await response.json().catch(() => null) as Record<string, any> | null;
  return { response, body, cookie: response.headers.get("Set-Cookie")?.split(";", 1)[0] };
}

describe("Bun Server API", () => {
  test("serves a cache-bypassing service worker in development", async () => {
    const devEnvironment = { ...environment, NODE_ENV: "development" };
    const response = await handleRequest(new Request("http://xiangying.test/sw.js"), { database, environment: devEnvironment, clientRoot: "dist/client", assetRoot });
    const source = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
    expect(source).toContain("await self.clients.claim()");
    expect(source).toContain("new URL(request.url).origin !== self.location.origin");
    expect(source).toContain("event.respondWith(fetch(request))");
  });

  test("automatically initializes a fresh database and does not rerun the baseline", async () => {
    const fresh = await openDatabase(":memory:");
    const migrations = fresh.query("SELECT name FROM schema_migrations ORDER BY name").all() as Array<{ name: string }>;
    expect(migrations.map((item) => item.name)).toEqual(["0001_baseline.sql"]);
    expect(fresh.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'").get()).toBeDefined();
    fresh.close();

    const databasePath = join(tmpdir(), `xiangying-notes-migration-${crypto.randomUUID()}.sqlite`);
    const initialized = await openDatabase(databasePath);
    initialized.close();

    const reopened = await openDatabase(databasePath);
    const appliedMigrations = reopened.query("SELECT name FROM schema_migrations ORDER BY name").all() as Array<{ name: string }>;
    expect(appliedMigrations.map((item) => item.name)).toEqual(["0001_baseline.sql"]);
    reopened.close();
    await Promise.all([rm(databasePath, { force: true }), rm(`${databasePath}-wal`, { force: true }), rm(`${databasePath}-shm`, { force: true })]);
  });

  test("applies SQLite migrations idempotently and reports health", async () => {
    await applyMigrations(database);
    const migrations = database.query("SELECT name FROM schema_migrations ORDER BY name").all() as Array<{ name: string }>;
    expect(migrations.map((item) => item.name)).toEqual(["0001_baseline.sql"]);
    expect((database.query("PRAGMA table_info(shares)").all() as Array<{ name: string }>).some((column) => column.name.startsWith("snapshot_"))).toBe(false);
    expect(database.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'sync_%'").all()).toEqual([]);

    const health = await request("/api/health");
    expect(health.response.status).toBe(200);
    expect(health.response.headers.get("Cache-Control")).toBe("no-store");
    expect(health.body).toEqual({ status: "ok", database: "ok" });
  });

  test("does not expose removed offline sync endpoints", async () => {
    const login = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "owner", password: environment.XIANGYING_PASSWORD }) });
    expect((await request("/api/sync/pull?cursor=0", {}, login.cookie)).response.status).toBe(404);
    expect((await request("/api/sync/push", { method: "POST", body: JSON.stringify({ mutations: [] }) }, login.cookie)).response.status).toBe(404);
  });

  test("imports JSON and raw Markdown through a Bearer token into the inbox", async () => {
    const apiToken = "shortcut-api-token-1234567890";
    const apiEnvironment = { ...environment, XIANGYING_API_TOKEN: apiToken };

    const unconfigured = await request("/api/import", { method: "POST", body: "内容" });
    expect(unconfigured.response.status).toBe(503);
    expect(unconfigured.body?.error.code).toBe("API_AUTH_NOT_CONFIGURED");

    const invalidToken = await request("/api/import", {
      method: "POST",
      headers: { Authorization: "Bearer wrong-token", "Content-Type": "text/markdown" },
      body: "内容",
    }, undefined, apiEnvironment);
    expect(invalidToken.response.status).toBe(401);
    expect(invalidToken.body?.error.code).toBe("INVALID_API_TOKEN");
    expect(invalidToken.response.headers.get("WWW-Authenticate")).toContain("Bearer");

    const login = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "owner", password: environment.XIANGYING_PASSWORD }) }, undefined, apiEnvironment);
    const cookieOnly = await request("/api/import", { method: "POST", body: "内容" }, login.cookie, apiEnvironment);
    expect(cookieOnly.response.status).toBe(401);

    const markdown = "# 今日记录\n\n正文 #快捷导入\n\n[链接](https://example.com)";
    const imported = await request("/api/import", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ contentMarkdown: markdown }),
    }, undefined, apiEnvironment, "https://notes.example.com");
    expect(imported.response.status).toBe(201);
    expect(imported.body?.ok).toBe(true);
    expect(imported.body?.note).not.toHaveProperty("contentMarkdown");
    expect(imported.body?.note.title).toMatch(/^快捷导入 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u);
    expect(imported.body?.note.notebookName).toBe("收件箱");

    const importedNote = database.query("SELECT id, title, content_markdown, notebook_id FROM notes WHERE id = ?").get(imported.body?.note.id) as { id: string; title: string; content_markdown: string; notebook_id: string };
    const inbox = database.query("SELECT id FROM notebooks WHERE user_id = ? AND is_system = 1").get(login.body?.user?.id ?? "") as { id: string } | null;
    expect(importedNote.content_markdown).toBe(markdown);
    expect(importedNote.notebook_id).toBe(inbox?.id ?? "");

    const rawMarkdown = "![远程图片](https://example.com/image.png)\n\n来自原始 Markdown";
    const raw = await request("/api/import", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "text/markdown", "Idempotency-Key": "shortcut-retry-1" },
      body: rawMarkdown,
    }, undefined, apiEnvironment, "https://notes.example.com");
    expect(raw.response.status).toBe(201);
    expect(database.query("SELECT content_markdown FROM notes WHERE id = ?").get(raw.body?.note.id)).toEqual({ content_markdown: rawMarkdown });

    const plain = await request("/api/import", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "text/plain" },
      body: "纯文本也按 Markdown 导入",
    }, undefined, apiEnvironment);
    expect(plain.response.status).toBe(201);

    const duplicate = await request("/api/import", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "text/markdown", "Idempotency-Key": "shortcut-retry-1" },
      body: rawMarkdown,
    }, undefined, apiEnvironment);
    expect(duplicate.response.status).toBe(200);
    expect(duplicate.response.headers.get("Idempotent-Replayed")).toBe("true");
    expect(duplicate.body?.note.id).toBe(raw.body?.note.id);

    const conflict = await request("/api/import", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "text/markdown", "Idempotency-Key": "shortcut-retry-1" },
      body: "同一个 Key 不允许写入另一篇笔记",
    }, undefined, apiEnvironment);
    expect(conflict.response.status).toBe(409);
    expect(conflict.body?.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  test("validates imported Markdown request bodies", async () => {
    const apiEnvironment = { ...environment, XIANGYING_API_TOKEN: "shortcut-api-token-1234567890" };
    const headers = { Authorization: `Bearer ${apiEnvironment.XIANGYING_API_TOKEN}` };

    const invalidJson = await request("/api/import", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "not-json" }, undefined, apiEnvironment);
    expect(invalidJson.response.status).toBe(400);
    expect(invalidJson.body?.error.code).toBe("INVALID_JSON");

    const invalidPayload = await request("/api/import", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ title: "没有正文" }) }, undefined, apiEnvironment);
    expect(invalidPayload.response.status).toBe(400);
    expect(invalidPayload.body?.error.code).toBe("INVALID_IMPORT_PAYLOAD");

    const unsupported = await request("/api/import", { method: "POST", headers: { ...headers, "Content-Type": "application/xml" }, body: "<note />" }, undefined, apiEnvironment);
    expect(unsupported.response.status).toBe(415);
    expect(unsupported.body?.error.code).toBe("UNSUPPORTED_MEDIA_TYPE");

    const empty = await request("/api/import", { method: "POST", headers: { ...headers, "Content-Type": "text/markdown" }, body: " \n\t" }, undefined, apiEnvironment);
    expect(empty.response.status).toBe(400);
    expect(empty.body?.error.code).toBe("EMPTY_NOTE");

    const oversized = await request("/api/import", { method: "POST", headers: { ...headers, "Content-Type": "text/markdown" }, body: "字".repeat(1_000_001) }, undefined, apiEnvironment);
    expect(oversized.response.status).toBe(413);
    expect(oversized.body?.error.code).toBe("NOTE_TOO_LARGE");
  });

  test("rate limits authenticated API imports by client address", async () => {
    const apiToken = "shortcut-api-token-1234567890";
    const apiEnvironment = { ...environment, XIANGYING_API_TOKEN: apiToken };
    const headers = { Authorization: `Bearer ${apiToken}`, "Content-Type": "text/markdown" };

    for (let index = 0; index < IMPORT_RATE_LIMIT_MAX_REQUESTS; index += 1) {
      const response = await request("/api/import", { method: "POST", headers, body: `限流测试 ${index}` }, undefined, apiEnvironment);
      expect(response.response.status).toBe(201);
    }
    const limited = await request("/api/import", { method: "POST", headers, body: "超过限流" }, undefined, apiEnvironment);
    expect(limited.response.status).toBe(429);
    expect(limited.response.headers.get("Retry-After")).toMatch(/^\d+$/u);
    expect(limited.body?.error.code).toBe("TOO_MANY_IMPORTS");
  });

  test("creates the owner, manages notes, search, notebooks and versions", async () => {
    const bootstrap = await request("/api/bootstrap");
    expect(bootstrap.body?.configured).toBe(true);

    const setup = await request("/api/setup", { method: "POST", body: JSON.stringify({}) });
    expect(setup.response.status).toBe(409);
    expect(setup.body?.error.code).toBe("AUTH_MANAGED_BY_ENV");

    const login = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "owner", password: environment.XIANGYING_PASSWORD }) });
    expect(login.response.status).toBe(200);
    expect(login.cookie).toMatch(/^xiangying_session=/);

    const unauthenticated = await request("/api/notes?view=all");
    expect(unauthenticated.response.status).toBe(401);

    const notebookResponse = await request("/api/notebooks", { method: "POST", body: JSON.stringify({ name: "测试笔记本", color: "#5b7899" }) }, login.cookie);
    expect(notebookResponse.response.status).toBe(201);
    const notebook = notebookResponse.body?.notebook;
    expect(notebook.color).toBe("#5b7899");
    expect(notebook.icon).toBe("folder");

    const customIconNb = await request("/api/notebooks", { method: "POST", body: JSON.stringify({ name: "灵感笔记", color: "#5b7899", icon: "lightbulb" }) }, login.cookie);
    expect(customIconNb.response.status).toBe(201);
    expect(customIconNb.body?.notebook.icon).toBe("lightbulb");

    const invalidIconNb = await request("/api/notebooks", { method: "POST", body: JSON.stringify({ name: "非法图标", color: "#5b7899", icon: "invalid-icon-name" }) }, login.cookie);
    expect(invalidIconNb.response.status).toBe(400);

    const created = await request("/api/notes", { method: "POST", body: JSON.stringify({ title: "Searchable note", contentMarkdown: "A quiet integration test", notebookId: notebook.id }) }, login.cookie);
    expect(created.response.status).toBe(201);
    const note = created.body?.note;

    const search = await request("/api/notes?view=all&query=quiet", {}, login.cookie);
    expect(search.response.status).toBe(200);
    expect(search.body?.notes.map((item: { id: string }) => item.id)).toContain(note.id);

    const wildcardNote = await request("/api/notes", { method: "POST", body: JSON.stringify({ title: "检索前缀命中", contentMarkdown: "仅用于验证搜索通配符" }) }, login.cookie);
    expect(wildcardNote.response.status).toBe(201);
    const wildcardSearch = await request(`/api/notes?view=all&query=${encodeURIComponent("检索前缀%")}`, {}, login.cookie);
    expect(wildcardSearch.response.status).toBe(200);
    expect(wildcardSearch.body).toEqual({ notes: [], total: 0 });

    const cjkFtsSearch = await request(`/api/notes?view=all&query=${encodeURIComponent("检索前缀")}`, {}, login.cookie);
    expect(cjkFtsSearch.response.status).toBe(200);
    expect(cjkFtsSearch.body?.notes.map((item: { id: string }) => item.id)).toContain(wildcardNote.body?.note.id);

    const cjkShortSearch = await request(`/api/notes?view=all&query=${encodeURIComponent("前缀")}`, {}, login.cookie);
    expect(cjkShortSearch.response.status).toBe(200);
    expect(cjkShortSearch.body?.notes.map((item: { id: string }) => item.id)).toContain(wildcardNote.body?.note.id);

    const cjkMixedSearch = await request(`/api/notes?view=all&query=${encodeURIComponent("验证 检索前缀")}`, {}, login.cookie);
    expect(cjkMixedSearch.response.status).toBe(200);
    expect(cjkMixedSearch.body?.notes.map((item: { id: string }) => item.id)).toContain(wildcardNote.body?.note.id);

    const conflict = await request(`/api/notes/${note.id}`, { method: "PATCH", body: JSON.stringify({ version: 99, title: "stale" }) }, login.cookie);
    expect(conflict.response.status).toBe(409);
    expect(conflict.body?.error.code).toBe("VERSION_CONFLICT");

    const updated = await request(`/api/notes/${note.id}`, { method: "PATCH", body: JSON.stringify({ version: note.version, title: "Updated", contentMarkdown: "Changed content", notebookId: notebook.id }) }, login.cookie);
    expect(updated.response.status).toBe(200);
    expect(updated.body?.note.title).toBe("Updated");

    const invalidBoolean = await request(`/api/notes/${note.id}`, { method: "PATCH", body: JSON.stringify({ version: updated.body?.note.version, isFavorite: "false" }) }, login.cookie);
    expect(invalidBoolean.response.status).toBe(400);
    expect(invalidBoolean.body?.error.code).toBe("INVALID_NOTE");

    const summaryUpdate = await request(`/api/notes/${note.id}?response=summary`, { method: "PATCH", body: JSON.stringify({ version: updated.body?.note.version, isFavorite: true }) }, login.cookie);
    expect(summaryUpdate.response.status).toBe(200);
    expect(summaryUpdate.body?.note).not.toHaveProperty("contentMarkdown");
    expect(summaryUpdate.body?.note.isFavorite).toBe(true);

    const invalidCreate = await request("/api/notes", { method: "POST", body: "not-json" }, login.cookie);
    expect(invalidCreate.response.status).toBe(400);
    expect(invalidCreate.body?.error.code).toBe("INVALID_JSON");

    const notebooks = await request("/api/notebooks", {}, login.cookie);
    expect(notebooks.body?.notebooks.find((item: { id: string }) => item.id === notebook.id).count).toBe(1);

    const unknownNoteSubresource = await request(`/api/notes/${note.id}/unknown-route`, {}, login.cookie);
    expect(unknownNoteSubresource.response.status).toBe(404);

    const unknownDeleteSubresource = await request(`/api/notes/${note.id}/unknown-route`, { method: "DELETE" }, login.cookie);
    expect(unknownDeleteSubresource.response.status).toBe(404);

    const noteStillExists = await request(`/api/notes/${note.id}`, {}, login.cookie);
    expect(noteStillExists.response.status).toBe(200);

    const unknownNotebookSubresource = await request(`/api/notebooks/${notebook.id}/unknown-route`, { method: "PATCH" }, login.cookie);
    expect(unknownNotebookSubresource.response.status).toBe(404);
  });

  test("returns and searches exact body tags without matching headings or code", async () => {
    const login = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "owner", password: environment.XIANGYING_PASSWORD }) });
    const tagged = await request("/api/notes", { method: "POST", body: JSON.stringify({
      title: "标签笔记",
      contentMarkdown: "正文#Project #项目-资料 #Project\n# 标题\n\n```md\n#hidden\n```",
    }) }, login.cookie);
    const similar = await request("/api/notes", { method: "POST", body: JSON.stringify({ title: "相似标签", contentMarkdown: "正文 #Projector" }) }, login.cookie);
    const titleOnly = await request("/api/notes", { method: "POST", body: JSON.stringify({ title: "#Project", contentMarkdown: "没有正文标签" }) }, login.cookie);

    expect(tagged.body?.note.tags).toEqual(["Project", "项目-资料"]);
    expect((await request(`/api/notes/${tagged.body?.note.id}`, {}, login.cookie)).body?.note.tags).toEqual(["Project", "项目-资料"]);

    const projectSearch = await request(`/api/notes?view=all&query=${encodeURIComponent("#project")}`, {}, login.cookie);
    expect(projectSearch.body?.total).toBe(1);
    expect(projectSearch.body?.notes.map((item: { id: string }) => item.id)).toEqual([tagged.body?.note.id]);
    expect(projectSearch.body?.notes[0].tags).toEqual(["Project", "项目-资料"]);

    const projectorSearch = await request(`/api/notes?view=all&query=${encodeURIComponent("#Projector")}`, {}, login.cookie);
    expect(projectorSearch.body?.total).toBe(1);
    expect(projectorSearch.body?.notes.map((item: { id: string }) => item.id)).toEqual([similar.body?.note.id]);

    const hiddenSearch = await request(`/api/notes?view=all&query=${encodeURIComponent("#hidden")}`, {}, login.cookie);
    expect(hiddenSearch.body).toEqual({ notes: [], total: 0 });

    const titleSearch = await request(`/api/notes?view=all&query=${encodeURIComponent("#Project")}`, {}, login.cookie);
    expect(titleSearch.body?.notes.map((item: { id: string }) => item.id)).not.toContain(titleOnly.body?.note.id);

    const filteredNotebookResponse = await request("/api/notebooks", { method: "POST", body: JSON.stringify({ name: "标签筛选", color: "#5b7899" }) }, login.cookie);
    const filteredNotebook = filteredNotebookResponse.body?.notebook;
    const favorite = await request("/api/notes", { method: "POST", body: JSON.stringify({ title: "收藏标签", contentMarkdown: "正文 #筛选", notebookId: filteredNotebook.id }) }, login.cookie);
    await request(`/api/notes/${favorite.body?.note.id}`, { method: "PATCH", body: JSON.stringify({ version: favorite.body?.note.version, isFavorite: true }) }, login.cookie);
    const trashed = await request("/api/notes", { method: "POST", body: JSON.stringify({ title: "回收站标签", contentMarkdown: "正文 #筛选" }) }, login.cookie);
    await request(`/api/notes/${trashed.body?.note.id}`, { method: "PATCH", body: JSON.stringify({ version: trashed.body?.note.version, deleted: true }) }, login.cookie);
    const notebookNote = await request("/api/notes", { method: "POST", body: JSON.stringify({ title: "笔记本标签", contentMarkdown: "正文 #筛选", notebookId: filteredNotebook.id }) }, login.cookie);

    const favoriteSearch = await request(`/api/notes?view=favorites&query=${encodeURIComponent("#筛选")}`, {}, login.cookie);
    expect(favoriteSearch.body?.total).toBe(1);
    expect(favoriteSearch.body?.notes.map((item: { id: string }) => item.id)).toEqual([favorite.body?.note.id]);
    const trashSearch = await request(`/api/notes?view=trash&query=${encodeURIComponent("#筛选")}`, {}, login.cookie);
    expect(trashSearch.body?.total).toBe(1);
    expect(trashSearch.body?.notes.map((item: { id: string }) => item.id)).toEqual([trashed.body?.note.id]);
    const notebookSearch = await request(`/api/notes?view=all&notebookId=${filteredNotebook.id}&query=${encodeURIComponent("#筛选")}`, {}, login.cookie);
    expect(notebookSearch.body?.total).toBe(2);
    expect(notebookSearch.body?.notes.map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining([favorite.body?.note.id, notebookNote.body?.note.id]));
  });

  test("uploads isolated image assets, returns thumbnails, and cleans files on permanent deletion", async () => {
    const unauthenticated = await request("/api/assets", { method: "POST", body: imageForm() });
    expect(unauthenticated.response.status).toBe(401);

    const login = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "owner", password: environment.XIANGYING_PASSWORD }) });
    const uploaded = await request("/api/assets", { method: "POST", body: imageForm("猫.png") }, login.cookie);
    expect(uploaded.response.status).toBe(201);
    const asset = uploaded.body?.asset;
    expect(asset).toMatchObject({ originalName: "猫.png", mimeType: "image/png", byteSize: ONE_PIXEL_PNG.byteLength, width: 1, height: 1 });

    const columns = database.query("PRAGMA table_info(image_assets)").all() as Array<{ name: string; type: string }>;
    expect(columns.some((column) => /blob|data|content/iu.test(column.name) || /blob/iu.test(column.type))).toBe(false);
    const stored = database.query("SELECT storage_path FROM image_assets WHERE id = ?").get(asset.id) as { storage_path: string };
    expect(stored.storage_path).toMatch(/^.+\/[0-9a-f-]+\.png$/u);
    expect(await Bun.file(join(assetRoot, stored.storage_path)).exists()).toBe(true);

    const noteContent = `![猫](${asset.url}?w=320&h=240)`;
    const created = await request("/api/notes", { method: "POST", body: JSON.stringify({ title: "带图片", contentMarkdown: noteContent }) }, login.cookie);
    expect(created.response.status).toBe(201);
    expect(created.body?.note.thumbnail).toMatchObject({ id: asset.id, url: asset.url, width: 1, height: 1 });
    const list = await request("/api/notes?view=all", {}, login.cookie);
    expect(list.body?.notes.find((item: { id: string }) => item.id === created.body?.note.id).thumbnail.id).toBe(asset.id);

    const imageResponse = await handleRequest(new Request(`http://xiangying.test${asset.url}`, { headers: { Cookie: login.cookie! } }), { database, environment, clientRoot: "dist/client", assetRoot });
    expect(imageResponse.status).toBe(200);
    expect(new Uint8Array(await imageResponse.arrayBuffer())).toEqual(ONE_PIXEL_PNG);

    const unsafe = database.query("UPDATE image_assets SET storage_path = ? WHERE id = ?").run("../outside.png", asset.id);
    expect(unsafe.changes).toBe(1);
    const isolated = await request(asset.url, {}, login.cookie);
    expect(isolated.response.status).toBe(404);
  });

  test("rejects oversized chunked image uploads before multipart parsing", async () => {
    const login = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "owner", password: environment.XIANGYING_PASSWORD }) });
    const oversizedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(IMAGE_UPLOAD_MAX_BODY_BYTES + 1));
        controller.close();
      },
    });
    const response = await request("/api/assets", {
      method: "POST",
      headers: { "Content-Type": "multipart/form-data; boundary=oversized" },
      body: oversizedBody,
    }, login.cookie);
    expect(response.response.status).toBe(413);
    expect(response.body?.error.code).toBe("IMAGE_TOO_LARGE");
  });

  test("rolls back note updates when asset references become invalid during the transaction", async () => {
    const login = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "owner", password: environment.XIANGYING_PASSWORD }) });
    const created = await request("/api/notes", { method: "POST", body: JSON.stringify({ title: "事务一致性", contentMarkdown: "原始内容" }) }, login.cookie);
    const note = created.body?.note;
    const uploaded = await request("/api/assets", { method: "POST", body: imageForm("race.png") }, login.cookie);
    const asset = uploaded.body?.asset;
    database.exec(`
      CREATE TRIGGER invalidate_asset_before_note_update
      AFTER UPDATE OF content_markdown ON notes
      WHEN NEW.id = '${note.id}'
      BEGIN
        DELETE FROM image_assets WHERE id = '${asset.id}';
      END;
    `);

    const response = await request(`/api/notes/${note.id}`, {
      method: "PATCH",
      body: JSON.stringify({ version: note.version, contentMarkdown: `![race](${asset.url})` }),
    }, login.cookie);
    expect(response.response.status).toBe(400);
    expect(response.body?.error.code).toBe("INVALID_ASSET");
    expect(database.query("SELECT version, content_markdown FROM notes WHERE id = ?").get(note.id)).toEqual({ version: note.version, content_markdown: "原始内容" });
    expect(database.query("SELECT id FROM image_assets WHERE id = ?").get(asset.id)).toBeDefined();
  });

  test("rejects unsupported image bytes and cross-user note references, and protects shared images", async () => {
    const login = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "owner", password: environment.XIANGYING_PASSWORD }) });
    const unsupported = await request("/api/assets", { method: "POST", body: imageForm("vector.svg", new TextEncoder().encode("<svg></svg>"), "image/svg+xml") }, login.cookie);
    expect(unsupported.response.status).toBe(415);
    expect(unsupported.body?.error.code).toBe("UNSUPPORTED_IMAGE");
    const oversized = await request("/api/assets", { method: "POST", body: imageForm("large.png", new Uint8Array(10 * 1024 * 1024 + 1)) }, login.cookie);
    expect(oversized.response.status).toBe(413);
    expect(oversized.body?.error.code).toBe("IMAGE_TOO_LARGE");
    const remoteImage = await request("/api/notes", { method: "POST", body: JSON.stringify({ title: "远程图片", contentMarkdown: "![remote](https://example.com/image.png)" }) }, login.cookie);
    expect(remoteImage.response.status).toBe(201);
    const insecureRemoteImage = await request("/api/notes", { method: "POST", body: JSON.stringify({ title: "不安全远程图片", contentMarkdown: "![remote](http://example.com/image.png)" }) }, login.cookie);
    expect(insecureRemoteImage.response.status).toBe(400);
    expect(insecureRemoteImage.body?.error.code).toBe("INVALID_ASSET");
    const dataImage = await request("/api/notes", { method: "POST", body: JSON.stringify({ title: "内联图片", contentMarkdown: "![remote](data:image/png;base64,AAAA)" }) }, login.cookie);
    expect(dataImage.response.status).toBe(400);
    expect(dataImage.body?.error.code).toBe("INVALID_ASSET");

    const uploaded = await request("/api/assets", { method: "POST", body: imageForm() }, login.cookie);
    const asset = uploaded.body?.asset;
    const otherEnvironment = { ...environment, XIANGYING_USERNAME: "other" };
    const otherLogin = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "other", password: environment.XIANGYING_PASSWORD }) }, undefined, otherEnvironment);
    const crossUser = await request("/api/notes", { method: "POST", body: JSON.stringify({ title: "越权图片", contentMarkdown: `![x](${asset.url})` }) }, otherLogin.cookie, otherEnvironment);
    expect(crossUser.response.status).toBe(400);
    expect(crossUser.body?.error.code).toBe("INVALID_ASSET");

    const created = await request("/api/notes", { method: "POST", body: JSON.stringify({ title: "分享图片", contentMarkdown: `![x](${asset.url}?w=400&h=300)` }) }, login.cookie);
    const share = await request(`/api/notes/${created.body?.note.id}/shares`, { method: "POST", body: "{}" }, login.cookie);
    const token = String(share.body?.share.url).split("/share/")[1];
    const sharedNote = await request(`/api/shares/${token}`);
    expect(sharedNote.body?.note.contentMarkdown).toContain(`/api/share-assets/${token}/${asset.id}`);
    const publicImage = await handleRequest(new Request(`http://xiangying.test/api/share-assets/${token}/${asset.id}`), { database, environment, clientRoot: "dist/client", assetRoot });
    expect(publicImage.status).toBe(200);
    expect(publicImage.headers.get("Cache-Control")).toBe("no-store");

    const revoked = await request(`/api/shares/${share.body?.share.id}`, { method: "DELETE" }, login.cookie);
    expect(revoked.response.status).toBe(200);
    const unavailable = await handleRequest(new Request(`http://xiangying.test/api/share-assets/${token}/${asset.id}`), { database, environment, clientRoot: "dist/client", assetRoot });
    expect(unavailable.status).toBe(410);
    expect((await unavailable.json()).error.code).toBe("SHARE_REVOKED");

    const expiring = await request(`/api/notes/${created.body?.note.id}/shares`, { method: "POST", body: "{}" }, login.cookie);
    const expiringToken = String(expiring.body?.share.url).split("/share/")[1];
    database.query("UPDATE shares SET expires_at = 0 WHERE id = ?").run(expiring.body?.share.id);
    const expiredImage = await handleRequest(new Request(`http://xiangying.test/api/share-assets/${expiringToken}/${asset.id}`), { database, environment, clientRoot: "dist/client", assetRoot });
    expect(expiredImage.status).toBe(410);
    expect((await expiredImage.json()).error.code).toBe("SHARE_EXPIRED");
  });

  test("deletes image assets and files with permanently deleted notes", async () => {
    const login = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "owner", password: environment.XIANGYING_PASSWORD }) });
    const uploaded = await request("/api/assets", { method: "POST", body: imageForm("delete-me.png") }, login.cookie);
    const asset = uploaded.body?.asset;
    const created = await request("/api/notes", { method: "POST", body: JSON.stringify({ title: "待清理图片", contentMarkdown: `![x](${asset.url})` }) }, login.cookie);
    const stored = database.query("SELECT storage_path FROM image_assets WHERE id = ?").get(asset.id) as { storage_path: string };
    expect(await Bun.file(join(assetRoot, stored.storage_path)).exists()).toBe(true);
    const trashed = await request(`/api/notes/${created.body?.note.id}`, { method: "PATCH", body: JSON.stringify({ version: created.body?.note.version, deleted: true }) }, login.cookie);
    expect(trashed.response.status).toBe(200);
    const deleted = await request(`/api/notes/${created.body?.note.id}`, { method: "DELETE" }, login.cookie);
    expect(deleted.response.status).toBe(200);
    expect(database.query("SELECT id FROM image_assets WHERE id = ?").get(asset.id)).toBeNull();
    expect(await Bun.file(join(assetRoot, stored.storage_path)).exists()).toBe(false);
  });

  test("only shares images still referenced by the current note", async () => {
    const login = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "owner", password: environment.XIANGYING_PASSWORD }) });
    const uploaded = await request("/api/assets", { method: "POST", body: imageForm("shared-remove.png") }, login.cookie);
    const asset = uploaded.body?.asset;
    const created = await request("/api/notes", { method: "POST", body: JSON.stringify({ title: "可解绑图片", contentMarkdown: `![x](${asset.url})` }) }, login.cookie);
    const share = await request(`/api/notes/${created.body?.note.id}/shares`, { method: "POST", body: "{}" }, login.cookie);
    const token = String(share.body?.share.url).split("/share/")[1];
    const laterUpload = await request("/api/assets", { method: "POST", body: imageForm("later.png") }, login.cookie);
    const laterAsset = laterUpload.body?.asset;
    expect((await handleRequest(new Request(`http://xiangying.test/api/share-assets/${token}/${laterAsset.id}`), { database, environment, clientRoot: "dist/client", assetRoot })).status).toBe(404);

    const withLaterImage = await request(`/api/notes/${created.body?.note.id}`, {
      method: "PATCH",
      body: JSON.stringify({ version: created.body?.note.version, contentMarkdown: `![x](${asset.url})\n![later](${laterAsset.url})` }),
    }, login.cookie);
    expect(withLaterImage.response.status).toBe(200);
    expect((await handleRequest(new Request(`http://xiangying.test/api/share-assets/${token}/${laterAsset.id}`), { database, environment, clientRoot: "dist/client", assetRoot })).status).toBe(200);

    const removed = await request(`/api/notes/${created.body?.note.id}`, {
      method: "PATCH",
      body: JSON.stringify({ version: withLaterImage.body?.note.version, contentMarkdown: "图片已移除" }),
    }, login.cookie);
    expect(removed.response.status).toBe(200);
    expect(database.query("SELECT note_id FROM image_assets WHERE id = ?").get(asset.id)).toEqual({ note_id: null });
    expect((await handleRequest(new Request(`http://xiangying.test/api/share-assets/${token}/${asset.id}`), { database, environment, clientRoot: "dist/client", assetRoot })).status).toBe(404);

    await request(`/api/shares/${share.body?.share.id}`, { method: "DELETE" }, login.cookie);
    const released = await request(`/api/notes/${created.body?.note.id}`, {
      method: "PATCH",
      body: JSON.stringify({ version: removed.body?.note.version, contentMarkdown: "图片仍已移除" }),
    }, login.cookie);
    expect(released.response.status).toBe(200);
    expect(database.query("SELECT note_id FROM image_assets WHERE id = ?").get(asset.id)).toEqual({ note_id: null });
  });

  test("moves a batch of notes to trash atomically with version checks", async () => {
    const login = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "owner", password: environment.XIANGYING_PASSWORD }) });
    const first = await request("/api/notes", { method: "POST", body: JSON.stringify({ title: "批量移入一" }) }, login.cookie);
    const second = await request("/api/notes", { method: "POST", body: JSON.stringify({ title: "批量移入二" }) }, login.cookie);
    const third = await request("/api/notes", { method: "POST", body: JSON.stringify({ title: "批量移入三" }) }, login.cookie);

    const moved = await request("/api/notes/batch", {
      method: "PATCH",
      body: JSON.stringify({ notes: [
        { id: first.body?.note.id, version: first.body?.note.version },
        { id: second.body?.note.id, version: second.body?.note.version },
      ] }),
    }, login.cookie);
    expect(moved.response.status).toBe(200);
    expect(new Set(moved.body?.deletedIds)).toEqual(new Set([first.body?.note.id, second.body?.note.id]));
    expect((await request(`/api/notes/${first.body?.note.id}`, {}, login.cookie)).body?.note.deletedAt).not.toBeNull();
    expect((await request(`/api/notes/${first.body?.note.id}`, {}, login.cookie)).body?.note.version).toBe(2);
    expect((await request(`/api/notes/${third.body?.note.id}`, {}, login.cookie)).body?.note.deletedAt).toBeNull();

    const changed = await request(`/api/notes/${second.body?.note.id}`, {
      method: "PATCH",
      body: JSON.stringify({ version: 2, title: "批量移入二（更新）" }),
    }, login.cookie);
    expect(changed.response.status).toBe(200);
    const conflict = await request("/api/notes/batch", {
      method: "PATCH",
      body: JSON.stringify({ notes: [
        { id: third.body?.note.id, version: third.body?.note.version },
        { id: second.body?.note.id, version: 2 },
      ] }),
    }, login.cookie);
    expect(conflict.response.status).toBe(409);
    expect(conflict.body?.error.code).toBe("BATCH_VERSION_CONFLICT");
    expect((await request(`/api/notes/${third.body?.note.id}`, {}, login.cookie)).body?.note.deletedAt).toBeNull();
    expect((await request(`/api/notes/${second.body?.note.id}`, {}, login.cookie)).body?.note.deletedAt).not.toBeNull();
  });

  test("permanently deletes a batch of trashed notes without touching other users", async () => {
    const login = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "owner", password: environment.XIANGYING_PASSWORD }) });
    const otherEnvironment = { ...environment, XIANGYING_USERNAME: "other" };
    const otherLogin = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "other", password: environment.XIANGYING_PASSWORD }) }, undefined, otherEnvironment);
    const first = await request("/api/notes", { method: "POST", body: JSON.stringify({ title: "批量彻底一" }) }, login.cookie);
    const second = await request("/api/notes", { method: "POST", body: JSON.stringify({ title: "批量彻底二" }) }, login.cookie);
    const other = await request("/api/notes", { method: "POST", body: JSON.stringify({ title: "其他用户笔记" }) }, otherLogin.cookie, otherEnvironment);

    const trashed = await request("/api/notes/batch", {
      method: "PATCH",
      body: JSON.stringify({ notes: [
        { id: first.body?.note.id, version: first.body?.note.version },
        { id: second.body?.note.id, version: second.body?.note.version },
      ] }),
    }, login.cookie);
    expect(trashed.response.status).toBe(200);
    const firstCurrent = await request(`/api/notes/${first.body?.note.id}`, {}, login.cookie);
    const secondCurrent = await request(`/api/notes/${second.body?.note.id}`, {}, login.cookie);

    const unauthorizedBatch = await request("/api/notes/batch", {
      method: "DELETE",
      body: JSON.stringify({ notes: [{ id: other.body?.note.id, version: other.body?.note.version }] }),
    }, login.cookie);
    expect(unauthorizedBatch.response.status).toBe(409);
    expect(unauthorizedBatch.body?.error.code).toBe("BATCH_VERSION_CONFLICT");

    const deleted = await request("/api/notes/batch", {
      method: "DELETE",
      body: JSON.stringify({ notes: [
        { id: first.body?.note.id, version: firstCurrent.body?.note.version },
        { id: second.body?.note.id, version: secondCurrent.body?.note.version },
      ] }),
    }, login.cookie);
    expect(deleted.response.status).toBe(200);
    expect(new Set(deleted.body?.deletedIds)).toEqual(new Set([first.body?.note.id, second.body?.note.id]));
    expect((await request(`/api/notes/${first.body?.note.id}`, {}, login.cookie)).response.status).toBe(404);
    expect((await request(`/api/notes/${second.body?.note.id}`, {}, login.cookie)).response.status).toBe(404);
    expect((await request(`/api/notes/${other.body?.note.id}`, {}, otherLogin.cookie, otherEnvironment)).response.status).toBe(200);
  });

  test("serves installable PWA assets with update-safe cache headers", async () => {
    const manifest = await request("/manifest.webmanifest", {}, undefined, environment, "http://xiangying.test", "app");
    expect(manifest.response.status).toBe(200);
    expect(manifest.response.headers.get("Content-Type")).toContain("application/manifest+json");
    expect(manifest.response.headers.get("Cache-Control")).toBe("no-cache");
    expect(manifest.response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const contentSecurityPolicy = manifest.response.headers.get("Content-Security-Policy");
    expect(contentSecurityPolicy).toContain("default-src 'self'");
    expect(contentSecurityPolicy).toContain("style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net");
    expect(contentSecurityPolicy).toContain("font-src 'self' https://cdn.jsdelivr.net");
    expect(contentSecurityPolicy).toContain("img-src 'self' data: blob: https:");
    expect(manifest.body?.display).toBe("standalone");

    const worker = await request("/sw.js");
    expect(worker.response.status).toBe(200);
    expect(worker.response.headers.get("Content-Type")).toContain("javascript");
    expect(worker.response.headers.get("Cache-Control")).toBe("no-cache");
  });

  test("serves source PWA asset aliases in development", async () => {
    const devEnvironment = { ...environment, NODE_ENV: "development" };
    const manifest = await request("/manifest.webmanifest", {}, undefined, devEnvironment, "http://xiangying.test", "dist/dev-client");
    expect(manifest.response.status).toBe(200);
    expect(manifest.body?.short_name).toBe("象映笔记");

    const icon = await request("/icon-192.png", {}, undefined, devEnvironment, "http://xiangying.test", "dist/dev-client");
    expect(icon.response.status).toBe(200);
    expect(icon.response.headers.get("Content-Type")).toContain("image/png");
  });

  test("returns no notes when a search query has no searchable terms", async () => {
    const login = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "owner", password: environment.XIANGYING_PASSWORD }) });
    await request("/api/notes", { method: "POST", body: JSON.stringify({ title: "第一篇", contentMarkdown: "alpha content" }) }, login.cookie);
    await request("/api/notes", { method: "POST", body: JSON.stringify({ title: "第二篇", contentMarkdown: "beta content" }) }, login.cookie);

    const all = await request("/api/notes?view=all", {}, login.cookie);
    expect(all.body?.notes.length).toBe(3);

    const punctuationOnly = await request(`/api/notes?view=all&query=${encodeURIComponent("!!!")}`, {}, login.cookie);
    expect(punctuationOnly.response.status).toBe(200);
    expect(punctuationOnly.body?.notes).toEqual([]);

    const underscores = await request(`/api/notes?view=all&query=${encodeURIComponent("(())")}`, {}, login.cookie);
    expect(underscores.body?.notes).toEqual([]);

    const real = await request("/api/notes?view=all&query=alpha", {}, login.cookie);
    expect(real.body?.notes).toHaveLength(1);
  });

  test("reports the full note count when the list is truncated", async () => {
    const login = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "owner", password: environment.XIANGYING_PASSWORD }) });
    const inbox = database.query("SELECT id FROM notebooks WHERE is_system = 1 LIMIT 1").get() as { id: string };
    const owner = database.query("SELECT id FROM users WHERE username = ?").get("owner") as { id: string };
    const insertNote = database.query("INSERT INTO notes (id, user_id, notebook_id, title, content_markdown, version, created_at, updated_at) VALUES (?, ?, ?, ?, '', 1, ?, ?)");
    const createdAt = Math.floor(Date.now() / 1000);
    const seed = database.transaction(() => {
      for (let index = 0; index < 105; index += 1) {
        const noteId = crypto.randomUUID();
        insertNote.run(noteId, owner.id, inbox.id, `批量笔记 ${index}`, createdAt, createdAt + index);
      }
    });
    seed();

    const list = await request("/api/notes?view=all", {}, login.cookie);
    expect(list.response.status).toBe(200);
    expect(list.body?.notes).toHaveLength(100);
    expect(list.body?.total).toBe(106);
    expect(list.body?.notes[0]).not.toHaveProperty("contentMarkdown");
    expect(list.body?.hasMore).toBe(true);
    expect(list.body?.nextCursor).toEqual(expect.any(String));

    const page2 = await request("/api/notes?view=all&offset=100", {}, login.cookie);
    expect(page2.response.status).toBe(200);
    expect(page2.body?.notes).toHaveLength(6);
    expect(page2.body?.total).toBe(106);

    const cursorPage2 = await request(`/api/notes?view=all&cursor=${encodeURIComponent(list.body?.nextCursor)}&includeTotal=0`, {}, login.cookie);
    expect(cursorPage2.response.status).toBe(200);
    expect(cursorPage2.body?.notes).toHaveLength(6);
    expect(cursorPage2.body).not.toHaveProperty("total");
    expect(cursorPage2.body?.hasMore).toBeUndefined();
    expect(cursorPage2.body?.notes.map((item: { id: string }) => item.id)).toEqual(page2.body?.notes.map((item: { id: string }) => item.id));
  });

  test("empties all owned trash beyond the list limit without deleting active or other users' notes", async () => {
    const login = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "owner", password: environment.XIANGYING_PASSWORD }) });
    const otherEnvironment: Record<string, string | undefined> = { ...environment, XIANGYING_USERNAME: "other" };
    const otherLogin = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "other", password: otherEnvironment.XIANGYING_PASSWORD }) }, undefined, otherEnvironment);
    const inbox = database.query("SELECT id FROM notebooks WHERE user_id = ? AND is_system = 1").get(login.body?.user.id) as { id: string };
    const deletedIds = Array.from({ length: 105 }, () => crypto.randomUUID());
    const insertNote = database.query("INSERT INTO notes (id, user_id, notebook_id, title, content_markdown, deleted_at, version, created_at, updated_at) VALUES (?, ?, ?, 'Trashed', 'trashneedle', 1, 1, 1, 1)");
    database.transaction(() => {
      for (const id of deletedIds) { insertNote.run(id, login.body?.user.id, inbox.id); }
    })();
    const active = await request("/api/notes", { method: "POST", body: JSON.stringify({ title: "Active", contentMarkdown: "activeneedle" }) }, login.cookie);
    const other = await request("/api/notes", { method: "POST", body: JSON.stringify({ title: "Other trash", contentMarkdown: "otherneedle" }) }, otherLogin.cookie, otherEnvironment);
    await request(`/api/notes/${other.body?.note.id}`, { method: "PATCH", body: JSON.stringify({ version: 1, deleted: true }) }, otherLogin.cookie, otherEnvironment);
    const trashedShare = await request(`/api/notes/${deletedIds[0]}/shares`, { method: "POST" }, login.cookie);
    const activeShare = await request(`/api/notes/${active.body?.note.id}/shares`, { method: "POST" }, login.cookie);
    const otherShare = await request(`/api/notes/${other.body?.note.id}/shares`, { method: "POST" }, otherLogin.cookie, otherEnvironment);
    const beforeCounts = await request("/api/notebooks", {}, login.cookie);
    const list = await request("/api/notes?view=trash", {}, login.cookie);
    expect(list.body?.notes).toHaveLength(100);
    expect(list.body?.total).toBe(105);

    const unauthorized = await request("/api/trash", { method: "DELETE" });
    expect(unauthorized.response.status).toBe(401);
    expect((await request("/api/notes?view=trash", {}, login.cookie)).body?.total).toBe(105);

    const emptied = await request("/api/trash", { method: "DELETE" }, login.cookie);
    expect(emptied.response.status).toBe(200);
    expect(emptied.body?.ok).toBe(true);
    expect(emptied.body?.deletedCount).toBe(105);
    expect(new Set(emptied.body?.deletedIds)).toEqual(new Set(deletedIds));
    expect((await request("/api/notes?view=trash", {}, login.cookie)).body).toEqual({ notes: [], total: 0 });
    expect(database.query("SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?").all("trashneedle")).toHaveLength(0);
    expect((await request("/api/notebooks", {}, login.cookie)).body).toEqual(beforeCounts.body);
    expect((await request(`/api/notes/${active.body?.note.id}`, {}, login.cookie)).response.status).toBe(200);
    expect((await request("/api/notes?view=all&query=activeneedle", {}, login.cookie)).body?.total).toBe(1);
    expect((await request("/api/notes?view=trash&query=otherneedle", {}, otherLogin.cookie, otherEnvironment)).body?.total).toBe(1);
    for (const [share, expected] of [[trashedShare, 404], [activeShare, 200], [otherShare, 404]] as const) {
      const token = new URL(share.body?.share.url).pathname.split("/").pop();
      expect((await request(`/api/shares/${token}`)).response.status).toBe(expected);
    }
    expect((await request("/api/trash", { method: "DELETE" }, login.cookie)).body).toEqual({ ok: true, deletedCount: 0, deletedIds: [] });
  });

  test("rolls back notes, full-text entries and shares together when emptying trash fails", async () => {
    const login = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "owner", password: environment.XIANGYING_PASSWORD }) });
    const created = await request("/api/notes", { method: "POST", body: JSON.stringify({ title: "Rollback", contentMarkdown: "rollbackneedle" }) }, login.cookie);
    const id = created.body?.note.id;
    await request(`/api/notes/${id}`, { method: "PATCH", body: JSON.stringify({ version: 1, deleted: true }) }, login.cookie);
    const share = await request(`/api/notes/${id}/shares`, { method: "POST" }, login.cookie);
    database.exec("CREATE TEMP TRIGGER fail_trash_delete BEFORE DELETE ON notes BEGIN SELECT RAISE(ABORT, 'simulated delete failure'); END");
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      const emptied = await request("/api/trash", { method: "DELETE" }, login.cookie);
      expect(emptied.response.status).toBe(500);
      expect(emptied.body?.error.code).toBe("INTERNAL_ERROR");
    } finally { log.mockRestore(); }
    expect((await request(`/api/notes/${id}`, {}, login.cookie)).body?.note.deletedAt).not.toBeNull();
    expect((await request("/api/notes?view=trash&query=rollbackneedle", {}, login.cookie)).body?.total).toBe(1);
    const token = new URL(share.body?.share.url).pathname.split("/").pop();
    expect((await request(`/api/shares/${token}`)).response.status).toBe(404);
    expect(database.query("SELECT id FROM shares WHERE id = ?").get(share.body?.share.id)).toEqual({ id: share.body?.share.id });
  });

  test("rejects unknown list views and stores blank titles as empty", async () => {
    const login = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "owner", password: environment.XIANGYING_PASSWORD }) });

    const invalidView = await request("/api/notes?view=bogus", {}, login.cookie);
    expect(invalidView.response.status).toBe(400);
    expect(invalidView.body?.error.code).toBe("INVALID_VIEW");

    const blank = await request("/api/notes", { method: "POST", body: JSON.stringify({ title: "   " }) }, login.cookie);
    expect(blank.response.status).toBe(201);
    expect(blank.body?.note.title).toBe("");

    const padded = await request("/api/notes", { method: "POST", body: JSON.stringify({ title: "  保留空格  " }) }, login.cookie);
    expect(padded.body?.note.title).toBe("  保留空格  ");

    const renamed = await request(`/api/notes/${padded.body?.note.id}`, { method: "PATCH", body: JSON.stringify({ version: padded.body?.note.version, title: " \t " }) }, login.cookie);
    expect(renamed.response.status).toBe(200);
    expect(renamed.body?.note.title).toBe("");
  });

  test("reads current note content through existing links and honors deletion, revocation and expiry", async () => {
    const login = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "owner", password: environment.XIANGYING_PASSWORD }) });
    const created = await request("/api/notes", { method: "POST", body: JSON.stringify({ title: "Live share", contentMarkdown: "Original content" }) }, login.cookie);
    const note = created.body?.note;

    const shared = await request(`/api/notes/${note.id}/shares`, { method: "POST", body: "{}" }, login.cookie);
    expect(shared.response.status).toBe(201);
    const token = String(shared.body?.share.url).split("/share/")[1];

    const original = await request(`/api/shares/${token}`);
    expect(original.response.status).toBe(200);
    expect(original.response.headers.get("Cache-Control")).toBe("no-store");
    expect(original.body?.note.contentMarkdown).toBe("Original content");

    const updated = await request(`/api/notes/${note.id}`, { method: "PATCH", body: JSON.stringify({ version: note.version, title: "Updated title", contentMarkdown: "Changed later" }) }, login.cookie);
    expect(updated.response.status).toBe(200);
    const currentNote = await request(`/api/shares/${token}`);
    expect(currentNote.body?.note.title).toBe("Updated title");
    expect(currentNote.body?.note.contentMarkdown).toBe("Changed later");

    const trashed = await request(`/api/notes/${note.id}`, { method: "PATCH", body: JSON.stringify({ version: updated.body?.note.version, deleted: true }) }, login.cookie);
    expect(trashed.response.status).toBe(200);
    expect((await request(`/api/shares/${token}`)).response.status).toBe(404);
    const restored = await request(`/api/notes/${note.id}`, { method: "PATCH", body: JSON.stringify({ version: trashed.body?.note.version, deleted: false }) }, login.cookie);
    expect(restored.response.status).toBe(200);
    expect((await request(`/api/shares/${token}`)).body?.note.contentMarkdown).toBe("Changed later");

    const shareId = shared.body?.share.id;
    const revoked = await request(`/api/shares/${shareId}`, { method: "DELETE" }, login.cookie);
    expect(revoked.response.status).toBe(200);
    const unavailable = await request(`/api/shares/${token}`);
    expect(unavailable.response.status).toBe(410);
    expect(unavailable.body?.error.code).toBe("SHARE_REVOKED");
    expect(database.query("SELECT revoked_at FROM shares WHERE id = ?").get(shareId)).toEqual({ revoked_at: expect.any(Number) });

    const second = await request(`/api/notes/${note.id}/shares`, { method: "POST", body: "{}" }, login.cookie);
    const secondToken = String(second.body?.share.url).split("/share/")[1];
    database.query("UPDATE shares SET expires_at = ? WHERE id = ?").run(0, second.body?.share.id);
    const expired = await request(`/api/shares/${secondToken}`);
    expect(expired.response.status).toBe(410);
    expect(expired.body?.error.code).toBe("SHARE_EXPIRED");
  });

  test("uses PUBLIC_URL for generated share links", async () => {
    const publicEnvironment = { ...environment, PUBLIC_URL: "https://notes.example.com/" };
    const login = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "owner", password: environment.XIANGYING_PASSWORD }) }, undefined, publicEnvironment);
    const created = await request("/api/notes", { method: "POST", body: JSON.stringify({ title: "Public URL", contentMarkdown: "Configured origin" }) }, login.cookie, publicEnvironment);
    const note = created.body?.note;

    const shared = await request(`/api/notes/${note.id}/shares`, { method: "POST", body: "{}" }, login.cookie, publicEnvironment);
    expect(shared.response.status).toBe(201);
    expect(shared.body?.share.url).toMatch(/^https:\/\/notes\.example\.com\/share\/[A-Za-z0-9_-]+$/);
  });

  test("validates PUBLIC_URL before persisting a share", async () => {
    const invalidEnvironment = { ...environment, PUBLIC_URL: "not a url" };
    const login = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "owner", password: environment.XIANGYING_PASSWORD }) }, undefined, invalidEnvironment);
    const created = await request("/api/notes", { method: "POST", body: JSON.stringify({ title: "Invalid public URL", contentMarkdown: "" }) }, login.cookie, invalidEnvironment);
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      const shared = await request(`/api/notes/${created.body?.note.id}/shares`, { method: "POST", body: "{}" }, login.cookie, invalidEnvironment);
      expect(shared.response.status).toBe(500);
      expect(shared.body?.error.code).toBe("INTERNAL_ERROR");
    } finally { log.mockRestore(); }
    expect(database.query("SELECT COUNT(*) AS count FROM shares").get()).toEqual({ count: 0 });
  });

  test("keeps active sessions alive while still expiring inactive sessions", async () => {
    const login = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "owner", password: environment.XIANGYING_PASSWORD }) });
    expect(login.response.status).toBe(200);
    expect(login.response.headers.get("Set-Cookie")).toContain("Max-Age=34560000");

    const nearExpiry = Math.floor(Date.now() / 1000) + 60;
    database.query("UPDATE sessions SET expires_at = ?").run(nearExpiry);
    const active = await request("/api/me", {}, login.cookie);
    const refreshed = database.query("SELECT expires_at FROM sessions").get() as { expires_at: number } | null;
    expect(active.response.status).toBe(200);
    expect(active.response.headers.get("Set-Cookie")).toContain("Max-Age=34560000");
    expect(refreshed?.expires_at ?? 0).toBeGreaterThan(nearExpiry + 60 * 60 * 24 * 20);

    database.query("UPDATE sessions SET expires_at = 0").run();
    const expired = await request("/api/me", {}, login.cookie);
    expect(expired.response.status).toBe(401);
  });

  test("rejects invalid credentials and missing environment configuration", async () => {
    const wrong = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "owner", password: "wrong passphrase 1234" }) });
    expect(wrong.response.status).toBe(401);
    expect(wrong.body?.error.code).toBe("INVALID_CREDENTIALS");

    const unconfigured = { XIANGYING_USERNAME: undefined, XIANGYING_PASSWORD: undefined };
    const bootstrap = await request("/api/bootstrap", {}, undefined, unconfigured);
    expect(bootstrap.body?.configured).toBe(false);
    const missing = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "owner", password: environment.XIANGYING_PASSWORD }) }, undefined, unconfigured);
    expect(missing.response.status).toBe(503);
    expect(missing.body?.error.code).toBe("AUTH_NOT_CONFIGURED");
  });

  test("accepts passwords longer than the legacy login limit", async () => {
    const longPassword = "long-password-".repeat(30);
    const longPasswordEnvironment = { ...environment, XIANGYING_PASSWORD: longPassword };
    const login = await request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "owner", password: longPassword }),
    }, undefined, longPasswordEnvironment);

    expect(login.response.status).toBe(200);
    expect(login.body?.user.username).toBe("owner");
  });

  test("rate limits repeated login failures without trusting spoofed proxy headers", async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const failed = await request("/api/auth/login", { method: "POST", headers: { "X-Forwarded-For": `198.51.100.${attempt + 1}` }, body: JSON.stringify({ username: "owner", password: "wrong passphrase 1234" }) });
      expect(failed.response.status).toBe(401);
    }
    const blocked = await request("/api/auth/login", { method: "POST", headers: { "X-Forwarded-For": "203.0.113.99" }, body: JSON.stringify({ username: "owner", password: environment.XIANGYING_PASSWORD }) });
    expect(blocked.response.status).toBe(429);
    expect(blocked.body?.error.code).toBe("TOO_MANY_LOGIN_ATTEMPTS");
    expect(blocked.response.headers.get("Retry-After")).toBeTruthy();
  });

  test("automatically signs in with the development test account", async () => {
    const devEnvironment = { ...environment, NODE_ENV: "development", XIANGYING_DEV_AUTO_LOGIN: "true" };
    const bootstrap = await request("/api/bootstrap", {}, undefined, devEnvironment);
    expect(bootstrap.response.status).toBe(200);
    expect(bootstrap.body?.configured).toBe(true);
    expect(bootstrap.cookie).toMatch(/^xiangying_session=/);

    const me = await request("/api/me", {}, bootstrap.cookie, devEnvironment);
    expect(me.response.status).toBe(200);
    expect(me.body?.user.username).toBe("owner");
  });

  test("exports all user notes and attachments as a standard zip archive", async () => {
    const login = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "owner", password: environment.XIANGYING_PASSWORD }) });
    const exportResponse = await handleRequest(new Request("http://xiangying.test/api/export", {
      headers: { Cookie: login.cookie! },
    }), { database, environment, clientRoot: "dist/client", assetRoot });

    expect(exportResponse.status).toBe(200);
    expect(exportResponse.headers.get("Content-Type")).toBe("application/zip");
    expect(exportResponse.headers.get("Content-Disposition")).toContain("attachment; filename=");
    const zipBytes = new Uint8Array(await exportResponse.arrayBuffer());
    expect(zipBytes.length).toBeGreaterThan(50);
    // Standard ZIP local file header signature: PK\x03\x04
    expect(zipBytes[0]).toBe(0x50);
    expect(zipBytes[1]).toBe(0x4b);
    expect(zipBytes[2]).toBe(0x03);
    expect(zipBytes[3]).toBe(0x04);
  });

  test("keeps ZIP entries inside the archive when a notebook is named dot dot", async () => {
    const login = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "owner", password: environment.XIANGYING_PASSWORD }) });
    const notebook = await request("/api/notebooks", { method: "POST", body: JSON.stringify({ name: ".." }) }, login.cookie);
    expect(notebook.response.status).toBe(201);
    const created = await request("/api/notes", { method: "POST", body: JSON.stringify({ title: "note", notebookId: notebook.body?.notebook.id, contentMarkdown: "content" }) }, login.cookie);
    expect(created.response.status).toBe(201);
    const response = await handleRequest(new Request("http://xiangying.test/api/export", { headers: { Cookie: login.cookie ?? "" } }), { database, environment, clientRoot: "dist/client", assetRoot });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const archive = new TextDecoder().decode(bytes);
    expect(archive).toContain("收件箱/note.md");
    expect(archive).not.toContain("../note.md");
  });

  test("purges old revoked and expired share links", async () => {
    const login = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "owner", password: environment.XIANGYING_PASSWORD }) });
    const created = await request("/api/notes", { method: "POST", body: JSON.stringify({ title: "Share Cleanup", contentMarkdown: "Some markdown text" }) }, login.cookie);
    const noteId = created.body?.note.id;

    // Active share
    const activeShare = await request(`/api/notes/${noteId}/shares`, { method: "POST", body: "{}" }, login.cookie);
    const activeId = activeShare.body?.share.id;

    // Expired share (expired 10 seconds ago)
    const expiredShare = await request(`/api/notes/${noteId}/shares`, { method: "POST", body: "{}" }, login.cookie);
    const expiredId = expiredShare.body?.share.id;
    const nowSec = Math.floor(Date.now() / 1000);
    database.query("UPDATE shares SET expires_at = ? WHERE id = ?").run(nowSec - 10, expiredId);

    // Old expired share (expired > 30 days ago)
    const ancientShare = await request(`/api/notes/${noteId}/shares`, { method: "POST", body: "{}" }, login.cookie);
    const ancientId = ancientShare.body?.share.id;
    database.query("UPDATE shares SET expires_at = ? WHERE id = ?").run(nowSec - EXPIRED_SHARE_PURGE_SECONDS - 100, ancientId);

    // Old revoked share (revoked > 30 days ago)
    const ancientRevoked = await request(`/api/notes/${noteId}/shares`, { method: "POST", body: "{}" }, login.cookie);
    const ancientRevokedId = ancientRevoked.body?.share.id;
    database.query("UPDATE shares SET revoked_at = ? WHERE id = ?").run(nowSec - EXPIRED_SHARE_PURGE_SECONDS - 100, ancientRevokedId);

    cleanupExpiredShares(database, true);

    expect(database.query("SELECT id FROM shares WHERE id = ?").get(activeId)).toEqual({ id: activeId });
    expect(database.query("SELECT id FROM shares WHERE id = ?").get(expiredId)).toEqual({ id: expiredId });

    // Ancient shares purged completely
    expect(database.query("SELECT id FROM shares WHERE id = ?").get(ancientId)).toBeNull();
    expect(database.query("SELECT id FROM shares WHERE id = ?").get(ancientRevokedId)).toBeNull();
  });

  test("limits note_short_terms per note and bounds scanned content length", async () => {
    const login = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "owner", password: environment.XIANGYING_PASSWORD }) });

    // Generate 600 distinct 2-char CJK phrases
    const phrases: string[] = [];
    for (let i = 0; i < 600; i++) {
      phrases.push(String.fromCharCode(0x4e00 + (i * 2)) + String.fromCharCode(0x4e00 + (i * 2 + 1)));
    }
    const longContent = phrases.join(" ");
    const created = await request("/api/notes", {
      method: "POST",
      body: JSON.stringify({ title: "大量索引测试", contentMarkdown: longContent }),
    }, login.cookie);

    expect(created.response.status).toBe(201);
    const noteId = created.body?.note.id;

    const termsCount = database.query("SELECT COUNT(*) AS count FROM note_short_terms WHERE note_id = ?").get(noteId) as { count: number };
    expect(termsCount.count).toBe(MAX_SHORT_TERMS_PER_NOTE);

    // Also test that characters beyond 4000 are not scanned for short terms
    const padding = "一".repeat(MAX_SHORT_TERM_CONTENT_CHARS + 50);
    const beyondTerm = "超限词汇";
    const noteBeyond = await request("/api/notes", {
      method: "POST",
      body: JSON.stringify({ title: "超长笔记", contentMarkdown: `${padding} ${beyondTerm}` }),
    }, login.cookie);
    expect(noteBeyond.response.status).toBe(201);

    const beyondTerms = database.query("SELECT term FROM note_short_terms WHERE note_id = ? AND term = ?").get(noteBeyond.body?.note.id, "超限") as { term: string } | null;
    expect(beyondTerms).toBeNull();
  });

  test("reclaims physical SQLite file size on disk after permanently deleting notes", async () => {
    const tempDbPath = join(tmpdir(), `xiangying-test-${crypto.randomUUID()}.sqlite`);
    const fileDb = await openDatabase(tempDbPath);
    await applyMigrations(fileDb);

    try {
      expect((fileDb.query("PRAGMA auto_vacuum;").get() as { auto_vacuum: number }).auto_vacuum).toBe(2);

      fileDb.query("INSERT INTO users (id, username, password_hash, password_salt, created_at) VALUES ('test-user', 'test', 'hash', 'salt', 1)").run();
      fileDb.query("INSERT INTO notebooks (id, user_id, name, is_system, created_at, updated_at) VALUES ('test-nb', 'test-user', 'Inbox', 1, 1, 1)").run();
      const insert = fileDb.query("INSERT INTO notes (id, user_id, notebook_id, title, content_markdown, version, created_at, updated_at) VALUES (?, 'test-user', 'test-nb', ?, ?, 1, 1, 1)");

      const bigContent = "磁盘回收测试内容数据，包含大量文本用于撑大物理文件。".repeat(200);
      const insertedIds: string[] = [];
      fileDb.transaction(() => {
        for (let i = 0; i < 50; i++) {
          const id = crypto.randomUUID();
          insertedIds.push(id);
          insert.run(id, `批量笔记 ${i}`, bigContent);
        }
      })();

      fileDb.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      const populatedSize = (await Bun.file(tempDbPath).stat()).size;
      expect(populatedSize).toBeGreaterThan(100 * 1024);

      // Soft delete: file size should NOT shrink
      fileDb.query("UPDATE notes SET deleted_at = 1 WHERE id IN (" + insertedIds.map(() => "?").join(",") + ")").run(...insertedIds);
      fileDb.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      const softDeletedSize = (await Bun.file(tempDbPath).stat()).size;
      expect(softDeletedSize).toBe(populatedSize);

      // Permanently delete and reclaim space
      fileDb.query("DELETE FROM notes WHERE deleted_at IS NOT NULL").run();
      reclaimDatabaseSpace(fileDb);

      const reclaimedSize = (await Bun.file(tempDbPath).stat()).size;
      expect(reclaimedSize).toBeLessThan(populatedSize);
      expect((fileDb.query("PRAGMA freelist_count;").get() as { freelist_count: number }).freelist_count).toBe(0);
    } finally {
      fileDb.close();
      await rm(tempDbPath, { force: true });
      await rm(`${tempDbPath}-wal`, { force: true });
      await rm(`${tempDbPath}-shm`, { force: true });
    }
  });
});
