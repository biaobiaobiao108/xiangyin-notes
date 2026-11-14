import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyMigrations,
  CURRENT_SCHEMA_VERSION,
  SEARCH_INDEX_REBUILD_KEY,
  createExpectedSchemaDatabase,
  initializeDatabase,
  openDatabase,
  type SchemaMigration,
} from "../server/db";
import { LEGACY_PASSWORD_ITERATIONS } from "../server/core";

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

test("migrates version 1 users to tracked password iterations", async () => {
  const database = new Database(":memory:");
  database.exec(await Bun.file("database/schema.sql").text());
  database
    .query(
      "INSERT INTO users (id, username, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run("legacy-user", "owner", "legacy-hash", "legacy-salt", 1);

  try {
    await initializeDatabase(database);
    expect(database.query("PRAGMA user_version").get()).toEqual({
      user_version: CURRENT_SCHEMA_VERSION,
    });
    expect(
      (
        database.query("PRAGMA table_info(users)").all() as Array<{
          name: string;
          dflt_value: string;
        }>
      ).find((column) => column.name === "password_iterations"),
    ).toMatchObject({ dflt_value: String(LEGACY_PASSWORD_ITERATIONS) });
    expect(
      database.query("SELECT password_iterations FROM users WHERE id = ?").get("legacy-user"),
    ).toEqual({ password_iterations: LEGACY_PASSWORD_ITERATIONS });
  } finally {
    database.close();
  }
});

test("migrates version 2 databases to the memo schema", async () => {
  const database = await createExpectedSchemaDatabase(2);
  try {
    expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    await initializeDatabase(database);
    expect(database.query("PRAGMA user_version").get()).toEqual({
      user_version: CURRENT_SCHEMA_VERSION,
    });
    expect(
      database
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memos'")
        .get(),
    ).toBeTruthy();
    expect(
      database
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memos_fts'")
        .get(),
    ).toBeTruthy();
  } finally {
    database.close();
  }
});

test("uses targeted indexes for paged notes and foreign-key cleanup", async () => {
  const database = await openDatabase(":memory:");
  try {
    const names = new Set(
      (
        database.query("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{
          name: string;
        }>
      ).map(({ name }) => name),
    );
    expect(names.has("idx_notes_user_deleted_updated_id")).toBe(true);
    expect(names.has("idx_notes_user_notebook_deleted_updated_id")).toBe(true);
    expect(names.has("idx_notes_user_trash_updated")).toBe(true);
    expect(names.has("idx_notes_user_favorites_updated")).toBe(true);
    expect(names.has("idx_sessions_user")).toBe(true);
    expect(names.has("idx_note_links_source_note")).toBe(true);
    expect(names.has("idx_note_links_target_note")).toBe(true);
    expect(names.has("idx_notes_short_overflow_user")).toBe(true);
    expect(names.has("idx_notes_user_deleted_title")).toBe(false);
    expect(names.has("idx_notes_user_deleted_updated")).toBe(false);
    expect(names.has("idx_notes_user_notebook_deleted_updated")).toBe(false);
    expect(names.has("idx_note_links_target_title")).toBe(false);

    const updatedPlan = database
      .query(
        "EXPLAIN QUERY PLAN SELECT id FROM notes WHERE user_id = ? AND deleted_at IS NULL AND (updated_at, id) < (?, ?) ORDER BY updated_at DESC, id DESC LIMIT ?",
      )
      .all("user", 100, "note", 100) as Array<{ detail: string }>;
    const updatedDetails = updatedPlan.map(({ detail }) => detail).join(" ");
    expect(updatedDetails).toContain("idx_notes_user_deleted_updated_id");
    expect(updatedDetails).not.toContain("TEMP B-TREE");

    const notebookPlan = database
      .query(
        "EXPLAIN QUERY PLAN SELECT id FROM notes WHERE user_id = ? AND notebook_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC, id DESC LIMIT ?",
      )
      .all("user", "notebook", 100) as Array<{ detail: string }>;
    expect(notebookPlan.map(({ detail }) => detail).join(" ")).toContain(
      "idx_notes_user_notebook_deleted_updated_id",
    );

    const sourceLinkPlan = database
      .query("EXPLAIN QUERY PLAN SELECT rowid FROM note_links WHERE source_note_id = ?")
      .all("note") as Array<{ detail: string }>;
    expect(sourceLinkPlan.map(({ detail }) => detail).join(" ")).toContain(
      "idx_note_links_source_note",
    );
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
    sourceVersion: CURRENT_SCHEMA_VERSION,
    targetVersion: CURRENT_SCHEMA_VERSION + 1,
    migrate: (target) => {
      target.exec("CREATE TABLE should_rollback (id INTEGER PRIMARY KEY)");
      throw new Error("migration failure");
    },
  };

  try {
    expect(() => applyMigrations(database, [failingMigration], CURRENT_SCHEMA_VERSION + 1)).toThrow(
      "migration failure",
    );
    expect(database.query("PRAGMA user_version").get()).toEqual({
      user_version: CURRENT_SCHEMA_VERSION,
    });
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

test("keeps the kanban table and indexes in the current schema", async () => {
  const database = await openDatabase(":memory:");
  try {
    expect(database.query("PRAGMA user_version").get()).toEqual({
      user_version: CURRENT_SCHEMA_VERSION,
    });
    expect(
      database
        .query("SELECT name FROM sqlite_master WHERE type = ? AND name = ?")
        .get("table", "kanban_cards"),
    ).toBeTruthy();
    expect(
      database
        .query("SELECT name FROM sqlite_master WHERE type = ? AND name = ?")
        .get("index", "idx_kanban_cards_user_status"),
    ).toBeTruthy();
  } finally {
    database.close();
  }
});

test("keeps the memo source, tag index, and FTS triggers in the current schema", async () => {
  const database = await openDatabase(":memory:");
  try {
    const objects = new Map(
      (
        database
          .query("SELECT type, name FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'")
          .all() as Array<{
          type: string;
          name: string;
        }>
      ).map((row) => [`${row.type}:${row.name}`, row]),
    );
    expect(objects.has("table:memos")).toBe(true);
    expect(objects.has("table:memo_tags")).toBe(true);
    expect(objects.has("table:memos_fts")).toBe(true);
    expect(objects.has("index:idx_memos_user_created")).toBe(true);
    expect(objects.has("index:idx_memo_tags_tag_user")).toBe(true);
    expect(objects.has("trigger:memos_ai")).toBe(true);
    expect(objects.has("trigger:memos_ad")).toBe(true);
    expect(objects.has("trigger:memos_au")).toBe(true);

    database
      .query(
        "INSERT INTO users (id, username, password_hash, password_salt, password_iterations, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("memo-user", "memo-owner", "hash", "salt", 600000, 1);
    database
      .query(
        "INSERT INTO memos (id, user_id, content_markdown, search_text, version, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
      )
      .run("memo-1", "memo-user", "remember alpha", "remember alpha", 1, 1);
    expect(
      database.query("SELECT rowid FROM memos_fts WHERE memos_fts MATCH ?").all("alpha"),
    ).toHaveLength(1);
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

test("db:check reports an unfinished search-index rebuild", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xiangying-schema-check-"));
  const path = join(directory, "notes.sqlite");
  const database = await openDatabase(path);
  database
    .query("INSERT INTO app_metadata (key, value) VALUES (?, '1')")
    .run(SEARCH_INDEX_REBUILD_KEY);
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
    expect(stdout).toContain("搜索索引重建: 未完成");
    expect(stderr).toBe("");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("db:check reports SQLite and foreign-key integrity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xiangying-schema-check-"));
  const path = join(directory, "notes.sqlite");
  const database = await openDatabase(path);
  database.query("INSERT INTO app_metadata (key, value) VALUES (?, ?)").run("db-check-test", "1");
  database.close();

  try {
    const healthy = Bun.spawn(["bun", "run", "scripts/check-schema-drift.ts", path], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [healthyExitCode, healthyStdout, healthyStderr] = await Promise.all([
      healthy.exited,
      new Response(healthy.stdout).text(),
      new Response(healthy.stderr).text(),
    ]);
    expect(healthyExitCode).toBe(0);
    expect(healthyStdout).toContain("SQLite 完整性: 正常");
    expect(healthyStdout).toContain("外键检查: 正常");
    expect(healthyStderr).toBe("");

    const corrupted = new Database(path);
    try {
      corrupted.exec("PRAGMA foreign_keys = OFF");
      corrupted
        .query(
          "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
        )
        .run("orphan-session", "missing-user", 1, 2);
    } finally {
      corrupted.close();
    }

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
    expect(stdout).toContain("外键检查: 发现 1 条违规");
    expect(stdout).toContain("sessions rowid=1 → users");
    expect(stdout).toContain("请先备份数据库并排查");
    expect(stderr).toBe("");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
