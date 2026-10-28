import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyMigrations,
  CURRENT_SCHEMA_VERSION,
  initializeDatabase,
  openDatabase,
  type SchemaMigration,
} from "../server/db";

test("initializes a fresh database from the single baseline and records its version", async () => {
  const database = await openDatabase(":memory:");
  try {
    expect(database.query("PRAGMA user_version").get()).toEqual({
      user_version: CURRENT_SCHEMA_VERSION,
    });
    expect(
      database
        .query("SELECT name FROM sqlite_master WHERE type = ? AND name = ?")
        .get("table", "users"),
    ).toBeTruthy();
  } finally {
    database.close();
  }
});

test("backfills the task index when upgrading an existing version 1 database", async () => {
  const database = new Database(":memory:");
  database.exec(await Bun.file("database/schema.sql").text());
  database
    .query(
      "INSERT INTO users (id, username, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run("user", "owner", "hash", "salt", 1);
  database
    .query(
      "INSERT INTO notebooks (id, user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run("notebook", "user", "Notes", 1, 1);
  database
    .query(
      "INSERT INTO notes (id, user_id, notebook_id, title, content_markdown, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run("note", "user", "notebook", "Plan", "- [ ] Parent\n  - [x] Child", 1, 42);

  try {
    await initializeDatabase(database);
    expect(
      database
        .query(
          "SELECT ordinal, depth, text, done, sort_updated_at FROM note_tasks ORDER BY ordinal",
        )
        .all(),
    ).toEqual([
      { ordinal: 0, depth: 0, text: "Parent", done: 0, sort_updated_at: -42 },
      { ordinal: 1, depth: 1, text: "Child", done: 1, sort_updated_at: -42 },
    ]);
    expect(
      database.query("SELECT done, task_count FROM note_task_counts ORDER BY done").all(),
    ).toEqual([
      { done: 0, task_count: 1 },
      { done: 1, task_count: 1 },
    ]);
    expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 2 });
  } finally {
    database.close();
  }
});

test("automatically applies each known migration in order during database initialization", async () => {
  const database = new Database(":memory:");
  const migrations: readonly SchemaMigration[] = [
    {
      sourceVersion: 1,
      targetVersion: 2,
      migrate: (target) =>
        target.exec("CREATE TABLE migration_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)"),
    },
    {
      sourceVersion: 2,
      targetVersion: 3,
      migrate: (target) =>
        target.exec("CREATE INDEX idx_migration_probe_value ON migration_probe(value)"),
    },
  ];

  try {
    await initializeDatabase(database, { migrations, currentSchemaVersion: 3 });

    expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 3 });
    expect(
      database
        .query("SELECT name FROM sqlite_master WHERE type = ? AND name = ?")
        .get("table", "migration_probe"),
    ).toBeTruthy();
    expect(
      database
        .query("SELECT name FROM sqlite_master WHERE type = ? AND name = ?")
        .get("index", "idx_migration_probe_value"),
    ).toBeTruthy();
  } finally {
    database.close();
  }
});

test("rolls back a failed migration and leaves its schema version unchanged", async () => {
  const database = await openDatabase(":memory:");
  const failingMigration: SchemaMigration = {
    sourceVersion: 2,
    targetVersion: 3,
    migrate: (target) => {
      target.exec("CREATE TABLE should_rollback (id INTEGER PRIMARY KEY)");
      throw new Error("migration failure");
    },
  };

  try {
    expect(() => applyMigrations(database, [failingMigration], 3)).toThrow("migration failure");
    expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    expect(
      database
        .query("SELECT name FROM sqlite_master WHERE type = ? AND name = ?")
        .get("table", "should_rollback"),
    ).toBeNull();
  } finally {
    database.close();
  }
});

test("refuses an unversioned non-empty database and leaves it unchanged", async () => {
  const database = new Database(":memory:");
  database.exec("CREATE TABLE unknown_layout (value TEXT)");
  try {
    await expect(initializeDatabase(database)).rejects.toThrow("schema version 0 is unsupported");
    expect(
      database
        .query("SELECT name FROM sqlite_master WHERE type = ? AND name = ?")
        .get("table", "unknown_layout"),
    ).toBeTruthy();
    expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 0 });
  } finally {
    database.close();
  }
});

test("refuses an unversioned database containing only a view without changing it", async () => {
  const database = new Database(":memory:");
  database.exec("CREATE VIEW user_view AS SELECT 1 AS value");
  try {
    await expect(initializeDatabase(database)).rejects.toThrow("schema version 0 is unsupported");
    expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 0 });
    expect(
      database
        .query("SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'user_view'")
        .get(),
    ).toBeTruthy();
    expect(
      database
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'")
        .get(),
    ).toBeNull();
  } finally {
    database.close();
  }
});

test("refuses an unversioned database containing a sqlite-prefixed user view", async () => {
  const database = new Database(":memory:");
  database.exec("CREATE VIEW sqliteX_view AS SELECT 1 AS value");
  try {
    await expect(initializeDatabase(database)).rejects.toThrow("schema version 0 is unsupported");
    expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 0 });
    expect(
      database
        .query("SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'sqliteX_view'")
        .get(),
    ).toBeTruthy();
    expect(
      database
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'")
        .get(),
    ).toBeNull();
  } finally {
    database.close();
  }
});

test("db:check rejects a database with a matching schema and unsupported version", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xiangying-schema-check-"));
  const path = join(directory, "notes.sqlite");
  const database = await openDatabase(path);
  database.exec("PRAGMA user_version = 999");
  database.close();

  try {
    const child = Bun.spawn(["bun", "run", "scripts/check-schema-drift.ts", path], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("不支持的 schema 版本：999");
    expect(stderr).toBe("");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
