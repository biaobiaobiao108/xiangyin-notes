import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations, openDatabase, type SqliteDatabase } from "../server/db";
import { handleRequest } from "../server/index";

let database: SqliteDatabase;
const environment: Record<string, string | undefined> = { XIANGYING_USERNAME: "owner", XIANGYING_PASSWORD: "a long passphrase 1234" };

beforeEach(async () => {
  database = await openDatabase(":memory:");
  await applyMigrations(database);
});

afterEach(() => database.close());

async function request(path: string, init: RequestInit = {}, cookie?: string, targetEnvironment = environment) {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("Cookie", cookie);
  const response = await handleRequest(new Request(`http://xiangying.test${path}`, { ...init, headers }), { database, environment: targetEnvironment, clientRoot: "dist/client" });
  const body = await response.json().catch(() => null) as Record<string, any> | null;
  return { response, body, cookie: response.headers.get("Set-Cookie")?.split(";", 1)[0] };
}

describe("Bun Server API", () => {
  test("automatically initializes a fresh database but not later migrations", async () => {
    const fresh = await openDatabase(":memory:");
    const migrations = fresh.query("SELECT name FROM schema_migrations ORDER BY name").all() as Array<{ name: string }>;
    expect(migrations.map((item) => item.name)).toEqual(["0001_initial.sql", "0002_sqlite_share_snapshots.sql"]);
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
    expect(migrations.map((item) => item.name)).toEqual(["0001_initial.sql", "0002_sqlite_share_snapshots.sql"]);

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

    const notebooks = await request("/api/notebooks", {}, login.cookie);
    expect(notebooks.body?.notebooks.find((item: { id: string }) => item.id === notebook.id).count).toBe(1);
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
