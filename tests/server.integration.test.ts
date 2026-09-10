import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { applyMigrations, openDatabase, type SqliteDatabase } from "../server/db";
import { handleRequest } from "../server/index";

let database: SqliteDatabase;
const environment: Record<string, string | undefined> = { LUMEN_USERNAME: "owner", LUMEN_PASSWORD: "a long passphrase 1234" };

beforeEach(async () => {
  database = await openDatabase(":memory:");
  await applyMigrations(database);
});

afterEach(() => database.close());

async function request(path: string, init: RequestInit = {}, cookie?: string, targetEnvironment = environment) {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("Cookie", cookie);
  const response = await handleRequest(new Request(`http://lumen.test${path}`, { ...init, headers }), { database, environment: targetEnvironment, clientRoot: "dist/client" });
  const body = await response.json().catch(() => null) as Record<string, any> | null;
  return { response, body, cookie: response.headers.get("Set-Cookie")?.split(";", 1)[0] };
}

describe("Bun Server API", () => {
  test("does not run migrations while opening a database", async () => {
    const uninitialized = await openDatabase(":memory:");
    const migrationTable = uninitialized.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get() ?? null;
    expect(migrationTable).toBeNull();
    uninitialized.close();
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

    const login = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "owner", password: environment.LUMEN_PASSWORD }) });
    expect(login.response.status).toBe(200);
    expect(login.cookie).toMatch(/^lumen_session=/);

    const unauthenticated = await request("/api/notes?view=all");
    expect(unauthenticated.response.status).toBe(401);

    const notebookResponse = await request("/api/notebooks", { method: "POST", body: JSON.stringify({ name: "测试笔记本" }) }, login.cookie);
    expect(notebookResponse.response.status).toBe(201);
    const notebook = notebookResponse.body?.notebook;

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

  test("stores immutable SQLite snapshots and revokes or expires them", async () => {
    const login = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "owner", password: environment.LUMEN_PASSWORD }) });
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

  test("rejects invalid credentials and missing environment configuration", async () => {
    const wrong = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "owner", password: "wrong passphrase 1234" }) });
    expect(wrong.response.status).toBe(401);
    expect(wrong.body?.error.code).toBe("INVALID_CREDENTIALS");

    const unconfigured = { LUMEN_USERNAME: undefined, LUMEN_PASSWORD: undefined };
    const bootstrap = await request("/api/bootstrap", {}, undefined, unconfigured);
    expect(bootstrap.body?.configured).toBe(false);
    const missing = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "owner", password: environment.LUMEN_PASSWORD }) }, undefined, unconfigured);
    expect(missing.response.status).toBe(503);
    expect(missing.body?.error.code).toBe("AUTH_NOT_CONFIGURED");
  });
});
