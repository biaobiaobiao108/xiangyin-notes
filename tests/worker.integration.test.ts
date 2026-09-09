import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import worker from "../worker/index";

class MockStatement {
  private values: any[] = [];

  constructor(private readonly database: Database, private readonly sql: string) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async first<T>() {
    return (this.database.query(this.sql).get(...this.values) as T | null) ?? null;
  }

  async all<T>() {
    return { results: this.database.query(this.sql).all(...this.values) as T[] };
  }

  async run() {
    const result = this.database.query(this.sql).run(...this.values);
    return { success: true, meta: { changes: result.changes } };
  }
}

class MockD1 {
  constructor(private readonly database: Database) {}

  prepare(sql: string) {
    return new MockStatement(this.database, sql) as never;
  }

  async batch(statements: MockStatement[]) {
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

class MockKV {
  readonly values = new Map<string, string>();
  readonly ttls = new Map<string, number>();

  async put(key: string, value: string, options?: { expirationTtl?: number }) {
    this.values.set(key, value);
    if (options?.expirationTtl) this.ttls.set(key, options.expirationTtl);
  }

  async get<T extends "json" | "text">(key: string, type: T) {
    const value = this.values.get(key);
    if (!value) return null;
    return (type === "json" ? JSON.parse(value) : value) as T extends "json" ? unknown : string;
  }
}

let database: Database;
let kv: MockKV;
let env: any;

beforeEach(async () => {
  database = new Database(":memory:");
  database.exec(await Bun.file(new URL("../migrations/0001_initial.sql", import.meta.url)).text());
  kv = new MockKV();
  env = { DB: new MockD1(database) as unknown as D1Database, SHARE_KV: kv as unknown as KVNamespace, ASSETS: {} as Fetcher, LUMEN_USERNAME: "owner", LUMEN_PASSWORD: "a long passphrase 1234" };
});

afterEach(() => database.close());

async function request(path: string, init: RequestInit = {}, cookie?: string, targetEnv = env) {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("Cookie", cookie);
  const response = await worker.fetch(new Request(`https://lumen.test${path}`, { ...init, headers }), targetEnv, {} as ExecutionContext);
  const body = await response.json() as Record<string, any>;
  return { response, body, cookie: response.headers.get("Set-Cookie")?.split(";", 1)[0] };
}

describe("Worker API integration", () => {
  test("isolates private data, indexes search and rejects stale versions", async () => {
    const bootstrap = await request("/api/bootstrap");
    expect(bootstrap.body.configured).toBe(true);
    const setup = await request("/api/setup", { method: "POST", body: JSON.stringify({ username: "manual", password: "a long passphrase 1234" }) });
    expect(setup.response.status).toBe(409);
    expect(setup.body.error.code).toBe("AUTH_MANAGED_BY_ENV");

    const login = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "owner", password: "a long passphrase 1234" }) });
    expect(login.response.status).toBe(200);
    expect(login.cookie).toMatch(/^lumen_session=/);

    const unauthenticated = await request("/api/notes?view=all");
    expect(unauthenticated.response.status).toBe(401);

    const created = await request("/api/notes", { method: "POST", body: JSON.stringify({ title: "Searchable note", contentMarkdown: "A quiet integration test" }) }, login.cookie);
    expect(created.response.status).toBe(201);
    const note = created.body.note;

    const search = await request("/api/notes?view=all&query=quiet", {}, login.cookie);
    expect(search.response.status).toBe(200);
    expect(search.body.notes.map((item: { id: string }) => item.id)).toContain(note.id);

    const conflict = await request(`/api/notes/${note.id}`, { method: "PATCH", body: JSON.stringify({ version: 99, title: "stale" }) }, login.cookie);
    expect(conflict.response.status).toBe(409);
    expect(conflict.body.error.code).toBe("VERSION_CONFLICT");

    const otherCookie = (await request("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "owner", password: "a long passphrase 1234" }) })).cookie;
    const privateRead = await request(`/api/notes/${note.id}`, {}, otherCookie);
    expect(privateRead.response.status).toBe(200);
  });

  test("stores seven-day immutable snapshots and revokes immediately", async () => {
    const login = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "owner", password: "a long passphrase 1234" }) });
    const created = await request("/api/notes", { method: "POST", body: JSON.stringify({ title: "Snapshot", contentMarkdown: "Original content" }) }, login.cookie);
    const note = created.body.note;
    const shared = await request(`/api/notes/${note.id}/shares`, { method: "POST", body: "{}" }, login.cookie);
    expect(shared.response.status).toBe(201);
    const token = String(shared.body.share.url).split("/share/")[1];
    expect(kv.ttls.get(`share:${token}`)).toBe(604800);

    const original = await request(`/api/shares/${token}`);
    expect(original.response.status).toBe(200);
    expect(original.body.snapshot.contentMarkdown).toBe("Original content");

    const updated = await request(`/api/notes/${note.id}`, { method: "PATCH", body: JSON.stringify({ version: note.version, contentMarkdown: "Changed later" }) }, login.cookie);
    expect(updated.response.status).toBe(200);
    const unchangedSnapshot = await request(`/api/shares/${token}`);
    expect(unchangedSnapshot.body.snapshot.contentMarkdown).toBe("Original content");

    const shareId = shared.body.share.id;
    const revoked = await request(`/api/shares/${shareId}`, { method: "DELETE" }, login.cookie);
    expect(revoked.response.status).toBe(200);
    const unavailable = await request(`/api/shares/${token}`);
    expect(unavailable.response.status).toBe(410);
    expect(unavailable.body.error.code).toBe("SHARE_REVOKED");
  });

  test("uses Worker environment credentials and rejects missing or invalid configuration", async () => {
    const wrong = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "owner", password: "wrong passphrase 1234" }) });
    expect(wrong.response.status).toBe(401);

    const unconfiguredEnv = { ...env, LUMEN_USERNAME: undefined, LUMEN_PASSWORD: undefined };
    const bootstrap = await request("/api/bootstrap", {}, undefined, unconfiguredEnv);
    expect(bootstrap.body.configured).toBe(false);
    const missing = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "owner", password: "a long passphrase 1234" }) }, undefined, unconfiguredEnv);
    expect(missing.response.status).toBe(503);
    expect(missing.body.error.code).toBe("AUTH_NOT_CONFIGURED");
  });
});
