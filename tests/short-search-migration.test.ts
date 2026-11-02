import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeDatabase,
  CURRENT_SCHEMA_VERSION,
  SEARCH_INDEX_REBUILD_KEY,
  openDatabase,
} from "../server/db";
import { buildShortSearchTokens, shortSearchToken } from "../server/note-search";

test("stores each distinct short term once per note", () => {
  const { tokens, truncated } = buildShortSearchTokens("猫猫", "猫");
  expect(truncated).toBe(false);
  expect(tokens.split(" ")).toHaveLength(2);
  expect(new Set(tokens.split(" "))).toEqual(
    new Set([shortSearchToken("猫"), shortSearchToken("猫猫")]),
  );
});

test("upgrading legacy short-search databases rebuilds the current short index", async () => {
  const database = new Database(":memory:");
  database.exec(await Bun.file("database/schema.sql").text());
  try {
    await initializeDatabase(database, { currentSchemaVersion: 9 });
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
      .run("note", "user", "notebook", "Docker", "正文包含你好和 Docker", 1, 1);
    database
      .query("INSERT INTO note_short_terms (note_id, user_id, term) VALUES (?, ?, ?)")
      .run("note", "user", "do");

    await initializeDatabase(database);

    expect(database.query("PRAGMA user_version").get()).toEqual({
      user_version: CURRENT_SCHEMA_VERSION,
    });
    expect(
      database.query("SELECT type, name FROM sqlite_master WHERE name = ?").get("notes_short_fts"),
    ).toBeTruthy();
    expect(
      database
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'note_short_terms'")
        .get(),
    ).toBeNull();
    expect(
      database.query("SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?").all("正文包含"),
    ).toHaveLength(1);
    expect(
      database
        .query("SELECT rowid FROM notes_short_fts WHERE notes_short_fts MATCH ?")
        .all(shortSearchToken("你好")),
    ).toHaveLength(1);
  } finally {
    database.close();
  }
});

test("upgrading version 12 rebuilds the short index and clears the migration marker", async () => {
  const database = new Database(":memory:");
  try {
    await initializeDatabase(database, { currentSchemaVersion: 12 });
    await initializeDatabase(database);

    expect(
      database.query("SELECT value FROM app_metadata WHERE key = ?").get(SEARCH_INDEX_REBUILD_KEY),
    ).toBeNull();
  } finally {
    database.close();
  }
});

test("version 16 repairs a rowid-broken main index even without a rebuild marker", async () => {
  const database = new Database(":memory:");
  try {
    await initializeDatabase(database, { currentSchemaVersion: 15 });
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
      .run("note", "user", "notebook", "标题", "正文包含猫", 1, 1);
    database.query("DELETE FROM app_metadata WHERE key = ?").run(SEARCH_INDEX_REBUILD_KEY);
    database.query("UPDATE notes SET rowid = 100 WHERE id = 'note'").run();

    await initializeDatabase(database);

    expect(
      database
        .query(
          "SELECT n.id FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid WHERE notes_fts MATCH ?",
        )
        .all("正文包含猫"),
    ).toEqual([{ id: "note" }]);
    expect(
      database.query("SELECT 1 FROM app_metadata WHERE key = ?").get(SEARCH_INDEX_REBUILD_KEY),
    ).toBeNull();
  } finally {
    database.close();
  }
});

test("reopening resumes an interrupted full-text rebuild", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xiangying-search-recovery-"));
  const path = join(directory, "notes.sqlite");
  try {
    const first = await openDatabase(path);
    first
      .query(
        "INSERT INTO users (id, username, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("user", "owner", "hash", "salt", 1);
    first
      .query(
        "INSERT INTO notebooks (id, user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("notebook", "user", "Notes", 1, 1);
    first
      .query(
        "INSERT INTO notes (id, user_id, notebook_id, title, content_markdown, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("note", "user", "notebook", "标题", "正文包含猫", 1, 1);

    // Simulate a process dying after VACUUM changed rowids but before the
    // derived full-text index was rebuilt.
    first.query("UPDATE notes SET rowid = 100 WHERE id = 'note'").run();
    first
      .query("INSERT INTO app_metadata (key, value) VALUES (?, '1')")
      .run(SEARCH_INDEX_REBUILD_KEY);
    first.close();

    const reopened = await openDatabase(path);
    try {
      expect(
        reopened
          .query(
            "SELECT n.id FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid WHERE notes_fts MATCH ?",
          )
          .all("正文包含猫"),
      ).toEqual([{ id: "note" }]);
      expect(
        reopened.query("SELECT 1 FROM app_metadata WHERE key = ?").get(SEARCH_INDEX_REBUILD_KEY),
      ).toBeNull();
    } finally {
      reopened.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
