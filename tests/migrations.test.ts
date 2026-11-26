import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyMigrations,
  CURRENT_SCHEMA_VERSION,
  MIN_SUPPORTED_SCHEMA_VERSION,
  SEARCH_INDEX_REBUILD_KEY,
  createExpectedSchemaDatabase,
  initializeDatabase,
  openDatabase,
  type SchemaMigration,
} from "../server/db";

test("rejects populated databases below the supported schema version", async () => {
  const database = await createExpectedSchemaDatabase(7);
  try {
    database
      .query(
        "INSERT INTO users (id, username, password_hash, password_salt, created_at) VALUES ('owner', 'owner', 'hash', 'salt', 1)",
      )
      .run();
    await expect(initializeDatabase(database, { minimumSchemaVersion: 8 })).rejects.toThrow(
      "schema version 7 is unsupported",
    );
    expect(database.query("PRAGMA user_version").get()).toEqual({
      user_version: 7,
    });
  } finally {
    database.close();
  }
});

test("upgrades populated v6 databases to the current schema version", async () => {
  const database = await createExpectedSchemaDatabase(6);
  try {
    database
      .query(
        "INSERT INTO users (id, username, password_hash, password_salt, created_at) VALUES ('owner', 'owner', 'hash', 'salt', 1)",
      )
      .run();
    database
      .query(
        "INSERT INTO notebooks (id, user_id, name, color, is_system, sort_order, created_at, updated_at) VALUES ('inbox', 'owner', '收集箱', '#4c7a6b', 1, 0, 1, 1)",
      )
      .run();
    database
      .query(
        "INSERT INTO notes (id, user_id, notebook_id, title, content_markdown, is_favorite, deleted_at, version, created_at, updated_at) VALUES ('note-1', 'owner', 'inbox', '旧版笔记', '正文内容', 0, NULL, 1, 1, 1)",
      )
      .run();
    await initializeDatabase(database);
    expect(database.query("PRAGMA user_version").get()).toEqual({
      user_version: CURRENT_SCHEMA_VERSION,
    });
    expect(
      database.query("SELECT title, content_markdown FROM notes WHERE id = 'note-1'").get(),
    ).toEqual({
      title: "旧版笔记",
      content_markdown: "正文内容",
    });
    expect(
      database
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memos'")
        .get(),
    ).toEqual({ name: "memos" });
  } finally {
    database.close();
  }
});

test("drops title-based link records and rebuilds the UUID index from Markdown", async () => {
  const database = await createExpectedSchemaDatabase(10);
  try {
    const uuid = "11111111-1111-4111-8111-111111111111";
    const markdown = `[[同名标题]] 和 [[${uuid}|显示标题]]`;
    database.exec(`
      INSERT INTO users (id, username, password_hash, password_salt, created_at)
        VALUES ('owner', 'owner', 'hash', 'salt', 1);
      INSERT INTO notebooks (id, user_id, name, created_at, updated_at)
        VALUES ('inbox', 'owner', '收集箱', 1, 1);
    `);
    database
      .query(
        `
      INSERT INTO notes (id, user_id, notebook_id, title, content_markdown, created_at, updated_at)
      VALUES ('source', 'owner', 'inbox', '来源', ?, 1, 1)
    `,
      )
      .run(markdown);
    database
      .query(
        `
      INSERT INTO note_links (id, user_id, source_note_id, target_title, created_at)
      VALUES ('old-link', 'owner', 'source', '同名标题', 1)
    `,
      )
      .run();
    await initializeDatabase(database);
    expect(database.query("SELECT target_note_id FROM note_links").all()).toEqual([
      { target_note_id: uuid },
    ]);
    expect(
      database.query("SELECT content_markdown, version FROM notes WHERE id = 'source'").get(),
    ).toEqual({ content_markdown: markdown, version: 1 });
  } finally {
    database.close();
  }
});

test("v12 indexes only aliases in stored link text and preserves note versions", async () => {
  const database = await createExpectedSchemaDatabase(11);
  try {
    const source = "11111111-1111-4111-8111-111111111111";
    const target = "22222222-2222-4222-8222-222222222222";
    const markdown = `[[${target}|旧标题]] [[${target}|旧标题|别名]]`;
    database.exec(`
      INSERT INTO users (id, username, password_hash, password_salt, created_at)
        VALUES ('owner', 'owner', 'hash', 'salt', 1);
      INSERT INTO notebooks (id, user_id, name, created_at, updated_at)
        VALUES ('inbox', 'owner', '收集箱', 1, 1);
    `);
    database
      .query(
        `
      INSERT INTO notes (id, user_id, notebook_id, title, content_markdown, search_text, version, created_at, updated_at)
      VALUES (?, 'owner', 'inbox', ?, ?, ?, 7, 1, 2)
    `,
      )
      .run(source, "来源", markdown, "旧标题 别名");
    database
      .query(
        `
      INSERT INTO note_links (id, user_id, source_note_id, target_note_id, snippet)
      VALUES ('old-link', 'owner', ?, ?, ?)
    `,
      )
      .run(source, target, markdown);
    await initializeDatabase(database);
    expect(database.query("SELECT id, has_plain_link FROM note_links").all()).toEqual([
      { id: "old-link", has_plain_link: 1 },
    ]);
    expect(
      database.query("SELECT search_text, content_markdown, version, updated_at FROM notes").get(),
    ).toEqual({ search_text: "别名", content_markdown: markdown, version: 7, updated_at: 2 });
    expect(
      database.query("SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?").all('"旧标题"'),
    ).toEqual([]);
  } finally {
    database.close();
  }
});

test("resumes an interrupted initialization from an older empty schema", async () => {
  const database = await createExpectedSchemaDatabase(1);
  try {
    await initializeDatabase(database);
    expect(database.query("PRAGMA user_version").get()).toEqual({
      user_version: CURRENT_SCHEMA_VERSION,
    });
  } finally {
    database.close();
  }
});

test("rolls back the baseline and completed steps when a fresh initialization fails", async () => {
  const database = new Database(":memory:");
  const migrations: SchemaMigration[] = [
    {
      sourceVersion: 1,
      targetVersion: 2,
      migrate: (db) => db.exec("CREATE TABLE first_step(id INTEGER)"),
    },
    {
      sourceVersion: 2,
      targetVersion: 3,
      migrate: () => {
        throw new Error("interrupted");
      },
    },
  ];
  try {
    await expect(
      initializeDatabase(database, { migrations, currentSchemaVersion: 3 }),
    ).rejects.toThrow("interrupted");
    expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 0 });
    expect(database.query("SELECT name FROM sqlite_schema").all()).toEqual([]);
    await initializeDatabase(database);
    expect(database.query("PRAGMA user_version").get()).toEqual({
      user_version: CURRENT_SCHEMA_VERSION,
    });
  } finally {
    database.close();
  }
});

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

test("upgrades the supported previous schema to the current version", async () => {
  const database = await createExpectedSchemaDatabase(MIN_SUPPORTED_SCHEMA_VERSION);
  try {
    await initializeDatabase(database);
    expect(database.query("PRAGMA user_version").get()).toEqual({
      user_version: CURRENT_SCHEMA_VERSION,
    });
    expect(
      database
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memos_short_fts'")
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
    expect(names.has("idx_note_links_source_note")).toBe(false);
    expect(names.has("idx_note_links_user_target")).toBe(true);
    expect(names.has("idx_note_links_source")).toBe(false);
    expect(names.has("idx_note_links_target")).toBe(false);
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
      "sqlite_autoindex_note_links",
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
    expect(objects.has("table:memos_short_fts")).toBe(true);
    expect(objects.has("table:memos_short_overflow")).toBe(true);
    expect(objects.has("index:idx_memos_user_created")).toBe(true);
    expect(objects.has("index:idx_memo_tags_tag_user")).toBe(true);
    expect(objects.has("index:idx_memo_tags_user_tag")).toBe(true);
    expect(objects.has("trigger:memos_ai")).toBe(true);
    expect(objects.has("trigger:memos_ad")).toBe(true);
    expect(objects.has("trigger:memos_au")).toBe(true);
    expect(objects.has("trigger:memos_short_fts_delete")).toBe(true);

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
    expect(stdout, stderr).toContain("不支持的 schema 版本：999");
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
    expect(stdout, stderr).toContain("搜索索引重建: 未完成");
    expect(stderr).toBe("");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("db:check opens a clean WAL database without creating sidecars or changing it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xiangying-schema-check-"));
  const path = join(directory, "笔记 #%.sqlite");
  const database = await openDatabase(path);
  database.close();

  try {
    expect(await Bun.file(`${path}-wal`).exists()).toBe(false);
    expect(await Bun.file(`${path}-shm`).exists()).toBe(false);
    const before = await stat(path);
    const child = Bun.spawn(["bun", "run", "scripts/check-schema-drift.ts", path], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    expect(stdout).toContain("SQLite 完整性: 正常");
    expect(stdout).toContain("外键检查: 正常");
    expect(stderr).toBe("");
    expect(await Bun.file(`${path}-wal`).exists()).toBe(false);
    expect(await Bun.file(`${path}-shm`).exists()).toBe(false);
    expect(await stat(path)).toMatchObject({ size: before.size, mtimeMs: before.mtimeMs });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("db:check reads committed data from an active WAL without using an immutable view", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xiangying-schema-check-"));
  const path = join(directory, "notes.sqlite");
  const database = await openDatabase(path);
  database
    .query("INSERT INTO app_metadata (key, value) VALUES (?, '1')")
    .run(SEARCH_INDEX_REBUILD_KEY);

  try {
    expect(await Bun.file(`${path}-wal`).exists()).toBe(true);
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
    database.close();
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
    expect(healthyExitCode, healthyStderr).toBe(0);
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
