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
          "SELECT ordinal, depth, text, done, sort_created_at FROM note_tasks ORDER BY ordinal",
        )
        .all(),
    ).toEqual([
      { ordinal: 0, depth: 0, text: "Parent", done: 0, sort_created_at: -1 },
      { ordinal: 1, depth: 1, text: "Child", done: 1, sort_created_at: -1 },
    ]);
    expect(
      database.query("SELECT done, task_count FROM note_task_counts ORDER BY done").all(),
    ).toEqual([
      { done: 0, task_count: 1 },
      { done: 1, task_count: 1 },
    ]);
    expect(database.query("PRAGMA user_version").get()).toEqual({
      user_version: CURRENT_SCHEMA_VERSION,
    });
    const taskIndexSql = database
      .query("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get("idx_note_tasks_user_recent") as { sql: string };
    expect(taskIndexSql.sql).toContain("sort_created_at");
  } finally {
    database.close();
  }
});

test("rebuilds derived task data when upgrading a version 4 database", async () => {
  const database = new Database(":memory:");
  database.exec(await Bun.file("database/schema.sql").text());
  try {
    await initializeDatabase(database, { currentSchemaVersion: 4 });
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
      .run("active", "user", "notebook", "Active", "- [ ] Open\n- [x] Done", 10, 10);
    database
      .query(
        "INSERT INTO notes (id, user_id, notebook_id, title, content_markdown, deleted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run("trashed", "user", "notebook", "Trashed", "- [ ] Hidden", 20, 20, 20);
    database
      .query(
        "INSERT INTO note_tasks (note_id, user_id, notebook_id, ordinal, depth, text, done, sort_created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run("active", "user", "notebook", 0, 0, "stale", 0, -10);
    database
      .query(
        "INSERT INTO note_tasks (note_id, user_id, notebook_id, ordinal, depth, text, done, sort_created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run("trashed", "user", "notebook", 0, 0, "Hidden", 0, -20);
    database
      .query(
        "INSERT INTO note_task_counts (user_id, notebook_id, done, task_count) VALUES (?, ?, ?, ?)",
      )
      .run("user", "notebook", 0, 99);

    await initializeDatabase(database);

    expect(
      database
        .query(
          "SELECT note_id, ordinal, text, done, sort_created_at FROM note_tasks ORDER BY ordinal",
        )
        .all(),
    ).toEqual([
      { note_id: "active", ordinal: 0, text: "Open", done: 0, sort_created_at: -10 },
      { note_id: "active", ordinal: 1, text: "Done", done: 1, sort_created_at: -10 },
    ]);
    expect(
      database.query("SELECT user_id, notebook_id, done, task_count FROM note_task_counts").all(),
    ).toEqual([
      { user_id: "user", notebook_id: "notebook", done: 0, task_count: 1 },
      { user_id: "user", notebook_id: "notebook", done: 1, task_count: 1 },
    ]);
    expect(database.query("PRAGMA user_version").get()).toEqual({
      user_version: CURRENT_SCHEMA_VERSION,
    });
  } finally {
    database.close();
  }
});

test("rebuilds every legacy tag row using the current Markdown parser", async () => {
  const database = new Database(":memory:");
  try {
    await initializeDatabase(database, { currentSchemaVersion: 5 });
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

    const insertNote = database.query(
      "INSERT INTO notes (id, user_id, notebook_id, title, content_markdown, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const insertTag = database.query(
      "INSERT INTO note_tags (note_id, user_id, tag_normalized, tag, position) VALUES (?, ?, ?, ?, ?)",
    );
    for (let index = 0; index < 101; index += 1) {
      const noteId = `note-${index.toString().padStart(3, "0")}`;
      insertNote.run(
        noteId,
        "user",
        "notebook",
        `Note ${index}`,
        "正文 #visible\n\n> ```md\n> #legacy\n> ```",
        1,
        1,
      );
      insertTag.run(noteId, "user", "visible", "visible", 0);
      insertTag.run(noteId, "user", "legacy", "legacy", 1);
    }

    await initializeDatabase(database);

    expect(database.query("PRAGMA user_version").get()).toEqual({
      user_version: CURRENT_SCHEMA_VERSION,
    });
    expect(
      database
        .query("SELECT COUNT(*) AS count FROM note_tags WHERE tag_normalized = ?")
        .get("legacy"),
    ).toEqual({ count: 0 });
    expect(
      database
        .query("SELECT COUNT(*) AS count FROM note_tags WHERE tag_normalized = ?")
        .get("visible"),
    ).toEqual({ count: 101 });
  } finally {
    database.close();
  }
});

test("removes legacy links and tags inside nested code without changing note contents", async () => {
  const database = new Database(":memory:");
  const content = "[[Target]] #visible\n\n- ~~~md\n  [[CodeTarget]] #hidden\n  ~~~";
  try {
    await initializeDatabase(database, { currentSchemaVersion: 6 });
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
    const insertNote = database.query(
      "INSERT INTO notes (id, user_id, notebook_id, title, title_normalized, content_markdown, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insertNote.run("target", "user", "notebook", "Target", "target", "", 1, 1);
    for (const id of ["source", "trashed"]) {
      insertNote.run(id, "user", "notebook", id, id, content, 1, 2);
      database
        .query(
          "INSERT INTO note_links (id, user_id, source_note_id, target_title, target_title_normalized, snippet, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(`${id}-false-link`, "user", id, "CodeTarget", "codetarget", "[[CodeTarget]]", 2);
      database
        .query(
          "INSERT INTO note_tags (note_id, user_id, tag_normalized, tag, position) VALUES (?, ?, ?, ?, ?)",
        )
        .run(id, "user", "hidden", "hidden", 0);
    }
    database.query("UPDATE notes SET deleted_at = 3 WHERE id = ?").run("trashed");
    const before = database
      .query("SELECT id, content_markdown, version, updated_at, deleted_at FROM notes ORDER BY id")
      .all();

    await initializeDatabase(database);

    expect(
      database
        .query(
          "SELECT source_note_id, target_title, target_note_id FROM note_links ORDER BY source_note_id",
        )
        .all(),
    ).toEqual([
      { source_note_id: "source", target_title: "Target", target_note_id: "target" },
      { source_note_id: "trashed", target_title: "Target", target_note_id: "target" },
    ]);
    expect(database.query("SELECT note_id, tag FROM note_tags ORDER BY note_id").all()).toEqual([
      { note_id: "source", tag: "visible" },
      { note_id: "trashed", tag: "visible" },
    ]);
    expect(
      database
        .query(
          "SELECT id, content_markdown, version, updated_at, deleted_at FROM notes ORDER BY id",
        )
        .all(),
    ).toEqual(before);
    expect(database.query("PRAGMA user_version").get()).toEqual({
      user_version: CURRENT_SCHEMA_VERSION,
    });
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
