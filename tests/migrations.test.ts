import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
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
