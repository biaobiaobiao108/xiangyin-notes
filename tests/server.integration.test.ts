import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations, openDatabase, type SqliteDatabase } from "../server/db";
import { handleRequest } from "../server/index";

let database: SqliteDatabase;
let assetRoot: string;
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
});

afterEach(async () => {
  database.close();
  await rm(assetRoot, { recursive: true, force: true });
});

async function request(path: string, init: RequestInit = {}, cookie?: string, targetEnvironment = environment) {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("Cookie", cookie);
  const response = await handleRequest(new Request(`http://xiangying.test${path}`, { ...init, headers }), { database, environment: targetEnvironment, clientRoot: "dist/client", assetRoot });
  const body = await response.json().catch(() => null) as Record<string, any> | null;
  return { response, body, cookie: response.headers.get("Set-Cookie")?.split(";", 1)[0] };
}

describe("Bun Server API", () => {
  test("automatically initializes a fresh database but not later migrations", async () => {
    const fresh = await openDatabase(":memory:");
    const migrations = fresh.query("SELECT name FROM schema_migrations ORDER BY name").all() as Array<{ name: string }>;
    expect(migrations.map((item) => item.name)).toEqual(["0001_initial.sql", "0002_sqlite_share_snapshots.sql", "0003_pwa_sync.sql", "0004_sync_tombstones.sql", "0005_image_assets.sql"]);
    expect(fresh.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'").get()).toBeDefined();
    fresh.close();

    const databasePath = join(tmpdir(), `xiangying-notes-migration-${crypto.randomUUID()}.sqlite`);
    const initialized = await openDatabase(databasePath);
    initialized.query("DELETE FROM schema_migrations WHERE name = ?").run("0002_sqlite_share_snapshots.sql");
    initialized.close();

    const reopened = await openDatabase(databasePath);
    const laterMigration = reopened.query("SELECT name FROM schema_migrations WHERE name = ?").get("0002_sqlite_share_snapshots.sql") ?? null;
    expect(laterMigration).toBeNull();
    reopened.close();
    await Promise.all([rm(databasePath, { force: true }), rm(`${databasePath}-wal`, { force: true }), rm(`${databasePath}-shm`, { force: true })]);
  });

  test("applies SQLite migrations idempotently and reports health", async () => {
    await applyMigrations(database);
    const migrations = database.query("SELECT name FROM schema_migrations ORDER BY name").all() as Array<{ name: string }>;
    expect(migrations.map((item) => item.name)).toEqual(["0001_initial.sql", "0002_sqlite_share_snapshots.sql", "0003_pwa_sync.sql", "0004_sync_tombstones.sql", "0005_image_assets.sql"]);

    const health = await request("/api/health");
    expect(health.response.status).toBe(200);
    expect(health.body).toEqual({ status: "ok", database: "ok" });
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

    const created = await request("/api/notes", { method: "POST", body: JSON.stringify({ title: "Searchable note", contentMarkdown: "A quiet integration test", notebookId: notebook.id }) }, login.cookie);
    expect(created.response.status).toBe(201);
    const note = created.body?.note;

    const search = await request("/api/notes?view=all&query=quiet", {}, login.cookie);
    expect(search.response.status).toBe(200);
    expect(search.body?.notes.map((item: { id: string }) => item.id)).toContain(note.id);

    const conflict = await request(`/api/notes/${note.id}`, { method: "PATCH", body: JSON.stringify({ version: 99, title: "stale" }) }, login.cookie);
    expect(conflict.response.status).toBe(409);
    expect(conflict.body?.error.code).toBe("VERSION_CONFLICT");

    const updated = await request(`/api/notes/${note.id}`, { method: "PATCH", body: JSON.stringify({ version: note.version, title: "Updated", contentMarkdown: "Changed content", notebookId: notebook.id }) }, login.cookie);
    expect(updated.response.status).toBe(200);
    expect(updated.body?.note.title).toBe("Updated");

    const invalidBoolean = await request(`/api/notes/${note.id}`, { method: "PATCH", body: JSON.stringify({ version: updated.body?.note.version, isFavorite: "false" }) }, login.cookie);
    expect(invalidBoolean.response.status).toBe(400);
    expect(invalidBoolean.body?.error.code).toBe("INVALID_NOTE");

    const invalidCreate = await request("/api/notes", { method: "POST", body: "not-json" }, login.cookie);
    expect(invalidCreate.response.status).toBe(400);
    expect(invalidCreate.body?.error.code).toBe("INVALID_JSON");

    const notebooks = await request("/api/notebooks", {}, login.cookie);
    expect(notebooks.body?.notebooks.find((item: { id: string }) => item.id === notebook.id).count).toBe(1);
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

  test("rejects unsupported image bytes and cross-user note references, and protects shared images", async () => {
    const login = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "owner", password: environment.XIANGYING_PASSWORD }) });
    const unsupported = await request("/api/assets", { method: "POST", body: imageForm("vector.svg", new TextEncoder().encode("<svg></svg>"), "image/svg+xml") }, login.cookie);
    expect(unsupported.response.status).toBe(415);
    expect(unsupported.body?.error.code).toBe("UNSUPPORTED_IMAGE");
    const oversized = await request("/api/assets", { method: "POST", body: imageForm("large.png", new Uint8Array(10 * 1024 * 1024 + 1)) }, login.cookie);
    expect(oversized.response.status).toBe(413);
    expect(oversized.body?.error.code).toBe("IMAGE_TOO_LARGE");
    const remoteImage = await request("/api/notes", { method: "POST", body: JSON.stringify({ title: "远程图片", contentMarkdown: "![remote](https://example.com/image.png)" }) }, login.cookie);
    expect(remoteImage.response.status).toBe(400);
    expect(remoteImage.body?.error.code).toBe("INVALID_ASSET");

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
    const snapshot = await request(`/api/shares/${token}`);
    expect(snapshot.body?.snapshot.contentMarkdown).toContain(`/api/share-assets/${token}/${asset.id}`);
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

  test("supports incremental sync, idempotent mutations and explicit conflicts", async () => {
    const login = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "owner", password: environment.XIANGYING_PASSWORD }) });
    const initial = await request("/api/sync/pull?cursor=0&limit=100", {}, login.cookie);
    expect(initial.response.status).toBe(200);
    const note = initial.body?.notes[0];
    const operationId = crypto.randomUUID();
    const mutation = {
      operationId,
      entity: "note",
      action: "upsert",
      entityId: note.id,
      baseVersion: note.version,
      note: { title: "离线修改", contentMarkdown: "来自同步队列", notebookId: note.notebookId, isFavorite: note.isFavorite, deletedAt: note.deletedAt },
    };

    const pushed = await request("/api/sync/push", { method: "POST", body: JSON.stringify({ mutations: [mutation] }) }, login.cookie);
    expect(pushed.response.status).toBe(200);
    expect(pushed.body?.results[0].status).toBe("applied");
    const repeated = await request("/api/sync/push", { method: "POST", body: JSON.stringify({ mutations: [mutation] }) }, login.cookie);
    expect(repeated.body?.results[0]).toEqual(pushed.body?.results[0]);

    const conflict = await request("/api/sync/push", { method: "POST", body: JSON.stringify({ mutations: [{ ...mutation, operationId: crypto.randomUUID(), baseVersion: note.version, note: { ...mutation.note, title: "过期本地版本" } }] }) }, login.cookie);
    expect(conflict.body?.results[0].status).toBe("conflict");

    const changes = await request(`/api/sync/pull?cursor=${initial.body?.snapshotCursor}&limit=100`, {}, login.cookie);
    expect(changes.body?.changes.some((change: { entityId: string; payload?: { title?: string } }) => change.entityId === note.id && change.payload?.title === "离线修改")).toBe(true);

    const trashed = await request("/api/notes", { method: "POST", body: JSON.stringify({ id: crypto.randomUUID(), title: "待删除" }) }, login.cookie);
    const trashedNote = trashed.body?.note;
    await request(`/api/notes/${trashedNote.id}`, { method: "PATCH", body: JSON.stringify({ version: trashedNote.version, deleted: true }) }, login.cookie);
    const deleted = await request(`/api/notes/${trashedNote.id}`, { method: "DELETE" }, login.cookie);
    expect(deleted.response.status).toBe(200);
    const staleRecreate = await request("/api/sync/push", { method: "POST", body: JSON.stringify({ mutations: [{ operationId: crypto.randomUUID(), entity: "note", action: "upsert", entityId: trashedNote.id, baseVersion: trashedNote.version, note: { title: "旧客户端重建", contentMarkdown: "不应出现", notebookId: note.notebookId, isFavorite: false, deletedAt: null } }] }) }, login.cookie);
    expect(staleRecreate.body?.results[0].status).toBe("rejected");
  });

  test("serves installable PWA assets with update-safe cache headers", async () => {
    const manifest = await request("/manifest.webmanifest");
    expect(manifest.response.status).toBe(200);
    expect(manifest.response.headers.get("Content-Type")).toContain("application/manifest+json");
    expect(manifest.response.headers.get("Cache-Control")).toBe("no-cache");
    expect(manifest.response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(manifest.response.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
    expect(manifest.body?.display).toBe("standalone");

    const worker = await request("/sw.js");
    expect(worker.response.status).toBe(200);
    expect(worker.response.headers.get("Content-Type")).toContain("javascript");
    expect(worker.response.headers.get("Cache-Control")).toBe("no-cache");
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
    const insertFts = database.query("INSERT INTO notes_fts (note_id, title, content) VALUES (?, ?, '')");
    const createdAt = Math.floor(Date.now() / 1000);
    const seed = database.transaction(() => {
      for (let index = 0; index < 105; index += 1) {
        const noteId = crypto.randomUUID();
        insertNote.run(noteId, owner.id, inbox.id, `批量笔记 ${index}`, createdAt, createdAt + index);
        insertFts.run(noteId, `批量笔记 ${index}`);
      }
    });
    seed();

    const list = await request("/api/notes?view=all", {}, login.cookie);
    expect(list.response.status).toBe(200);
    expect(list.body?.notes).toHaveLength(100);
    expect(list.body?.total).toBe(106);
    expect(list.body?.notes[0]).not.toHaveProperty("contentMarkdown");
  });

  test("empties all owned trash beyond the list limit without deleting active or other users' notes", async () => {
    const login = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "owner", password: environment.XIANGYING_PASSWORD }) });
    const otherEnvironment: Record<string, string | undefined> = { ...environment, XIANGYING_USERNAME: "other" };
    const otherLogin = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "other", password: otherEnvironment.XIANGYING_PASSWORD }) }, undefined, otherEnvironment);
    const inbox = database.query("SELECT id FROM notebooks WHERE user_id = ? AND is_system = 1").get(login.body?.user.id) as { id: string };
    const deletedIds = Array.from({ length: 105 }, () => crypto.randomUUID());
    const insertNote = database.query("INSERT INTO notes (id, user_id, notebook_id, title, content_markdown, deleted_at, version, created_at, updated_at) VALUES (?, ?, ?, 'Trashed', 'trashneedle', 1, 1, 1, 1)");
    const insertFts = database.query("INSERT INTO notes_fts (note_id, title, content) VALUES (?, 'Trashed', 'trashneedle')");
    database.transaction(() => {
      for (const id of deletedIds) { insertNote.run(id, login.body?.user.id, inbox.id); insertFts.run(id); }
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
    expect(database.query("SELECT note_id FROM notes_fts WHERE notes_fts MATCH ?").all("trashneedle")).toHaveLength(0);
    expect((await request("/api/notebooks", {}, login.cookie)).body).toEqual(beforeCounts.body);
    expect((await request(`/api/notes/${active.body?.note.id}`, {}, login.cookie)).response.status).toBe(200);
    expect((await request("/api/notes?view=all&query=activeneedle", {}, login.cookie)).body?.total).toBe(1);
    expect((await request("/api/notes?view=trash&query=otherneedle", {}, otherLogin.cookie, otherEnvironment)).body?.total).toBe(1);
    for (const [share, expected] of [[trashedShare, 404], [activeShare, 200], [otherShare, 200]] as const) {
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
    expect((await request(`/api/shares/${token}`)).response.status).toBe(200);
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

  test("stores immutable SQLite snapshots and revokes or expires them", async () => {
    const login = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "owner", password: environment.XIANGYING_PASSWORD }) });
    const created = await request("/api/notes", { method: "POST", body: JSON.stringify({ title: "Snapshot", contentMarkdown: "Original content" }) }, login.cookie);
    const note = created.body?.note;

    const shared = await request(`/api/notes/${note.id}/shares`, { method: "POST", body: "{}" }, login.cookie);
    expect(shared.response.status).toBe(201);
    const token = String(shared.body?.share.url).split("/share/")[1];

    const original = await request(`/api/shares/${token}`);
    expect(original.response.status).toBe(200);
    expect(original.body?.snapshot.contentMarkdown).toBe("Original content");

    const updated = await request(`/api/notes/${note.id}`, { method: "PATCH", body: JSON.stringify({ version: note.version, contentMarkdown: "Changed later" }) }, login.cookie);
    expect(updated.response.status).toBe(200);
    const unchangedSnapshot = await request(`/api/shares/${token}`);
    expect(unchangedSnapshot.body?.snapshot.contentMarkdown).toBe("Original content");

    const shareId = shared.body?.share.id;
    const revoked = await request(`/api/shares/${shareId}`, { method: "DELETE" }, login.cookie);
    expect(revoked.response.status).toBe(200);
    const unavailable = await request(`/api/shares/${token}`);
    expect(unavailable.response.status).toBe(410);
    expect(unavailable.body?.error.code).toBe("SHARE_REVOKED");

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

  test("rate limits repeated login failures", async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const failed = await request("/api/auth/login", { method: "POST", headers: { "X-Forwarded-For": "198.51.100.23" }, body: JSON.stringify({ username: "owner", password: "wrong passphrase 1234" }) });
      expect(failed.response.status).toBe(401);
    }
    const blocked = await request("/api/auth/login", { method: "POST", headers: { "X-Forwarded-For": "198.51.100.23" }, body: JSON.stringify({ username: "owner", password: environment.XIANGYING_PASSWORD }) });
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
});
