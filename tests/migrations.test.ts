import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations, CURRENT_SCHEMA_VERSION, initializeDatabase, openDatabase, type SchemaMigration } from "../server/db";

test("initializes a fresh database from the single baseline and records its version", async () => {
  const database = await openDatabase(":memory:");
  try {
    expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: CURRENT_SCHEMA_VERSION });
    expect(database.query("SELECT name FROM sqlite_master WHERE type = ? AND name = ?").get("table", "users")).toBeTruthy();
    expect(database.query("SELECT name FROM sqlite_master WHERE type = ? AND name = ?").get("table", "schema_migrations")).toBeNull();
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
      migrate: (target) => target.exec("CREATE TABLE migration_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)"),
    },
    {
      sourceVersion: 2,
      targetVersion: 3,
      migrate: (target) => target.exec("CREATE INDEX idx_migration_probe_value ON migration_probe(value)"),
    },
  ];

  try {
    await initializeDatabase(database, { migrations, currentSchemaVersion: 3 });

    expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 3 });
    expect(database.query("SELECT name FROM sqlite_master WHERE type = ? AND name = ?").get("table", "migration_probe")).toBeTruthy();
    expect(database.query("SELECT name FROM sqlite_master WHERE type = ? AND name = ?").get("index", "idx_migration_probe_value")).toBeTruthy();
  } finally {
    database.close();
  }
});

test("rolls back a failed migration and leaves its schema version unchanged", async () => {
  const database = await openDatabase(":memory:");
  const failingMigration: SchemaMigration = {
    sourceVersion: 1,
    targetVersion: 2,
    migrate: (target) => {
      target.exec("CREATE TABLE should_rollback (id INTEGER PRIMARY KEY)");
      throw new Error("migration failure");
    },
  };

  try {
    expect(() => applyMigrations(database, [failingMigration], 2)).toThrow("migration failure");
    expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    expect(database.query("SELECT name FROM sqlite_master WHERE type = ? AND name = ?").get("table", "should_rollback")).toBeNull();
  } finally {
    database.close();
  }
});

test("adopts the current pre-release migration ledger without changing user data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xiangying-notes-schema-adoption-"));
  const databasePath = join(directory, "notes.sqlite");
  const baseline = await Bun.file("database/schema.sql").text();
  const seed = new Database(databasePath);
  seed.exec(baseline);
  seed.exec(`
    CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
    INSERT INTO schema_migrations (name, applied_at) VALUES ('0001_baseline.sql', 1);
    PRAGMA user_version = 0;
  `);
  seed.query("INSERT INTO users (id, username, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)")
    .run("user-1", "owner", "hash", "salt", 1);
  seed.query("INSERT INTO notebooks (id, user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run("notebook-1", "user-1", "收件箱", 1, 1);
  seed.query(`INSERT INTO notes (id, user_id, notebook_id, title, content_markdown, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run("note-1", "user-1", "notebook-1", "保留的笔记", "这条数据必须保留。", 1, 1);
  seed.close();

  try {
    const database = await openDatabase(databasePath);
    try {
      expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: CURRENT_SCHEMA_VERSION });
      expect(database.query("SELECT title, content_markdown FROM notes WHERE id = ?").get("note-1"))
        .toEqual({ title: "保留的笔记", content_markdown: "这条数据必须保留。" });
      expect(database.query("SELECT name FROM sqlite_master WHERE type = ? AND name = ?").get("table", "schema_migrations")).toBeNull();
    } finally {
      database.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses an unversioned database with unknown schema and leaves it unchanged", async () => {
  const database = new Database(":memory:");
  database.exec("CREATE TABLE unknown_layout (value TEXT)");
  try {
    await expect(initializeDatabase(database)).rejects.toThrow("no supported schema version");
    expect(database.query("SELECT name FROM sqlite_master WHERE type = ? AND name = ?").get("table", "unknown_layout")).toBeTruthy();
    expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 0 });
  } finally {
    database.close();
  }
});
