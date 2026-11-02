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
import {
  MAX_SHORT_INDEX_TOKENS,
  rebuildNoteShortSearchIndex,
  shortSearchToken,
  syncNoteShortSearchTerms,
} from "../server/note-search";

test("upgrading version 10 rebuilds short search for Unicode and punctuation", async () => {
  const database = new Database(":memory:");
  try {
    await initializeDatabase(database, { currentSchemaVersion: 10 });
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
      .run("note", "user", "notebook", "École", "正文 😊!", 1, 1);
    syncNoteShortSearchTerms(database, "user", "note", "École", "正文 😊!", true);
    const find = (term: string) =>
      database
        .query("SELECT rowid FROM notes_short_fts WHERE notes_short_fts MATCH ?")
        .all(shortSearchToken(term));
    expect(find("é")).toEqual([]);
    expect(find("😊!")).toEqual([]);

    await initializeDatabase(database);

    expect(database.query("PRAGMA user_version").get()).toEqual({
      user_version: CURRENT_SCHEMA_VERSION,
    });
    expect(find("é")).toHaveLength(1);
    expect(find("😊!")).toHaveLength(1);
  } finally {
    database.close();
  }
});

test("upgrading version 11 adds the overflow lookup index", async () => {
  const database = new Database(":memory:");
  try {
    await initializeDatabase(database, { currentSchemaVersion: 11 });
    expect(
      database
        .query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get("idx_notes_short_overflow_user"),
    ).toBeNull();

    await initializeDatabase(database);

    expect(database.query("PRAGMA user_version").get()).toEqual({
      user_version: CURRENT_SCHEMA_VERSION,
    });
    expect(
      database
        .query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get("idx_notes_short_overflow_user"),
    ).toBeTruthy();
  } finally {
    database.close();
  }
});

test("upgrading version 12 creates the rebuild marker and metadata table", async () => {
  const database = new Database(":memory:");
  try {
    await initializeDatabase(database, { currentSchemaVersion: 12 });
    await initializeDatabase(database);

    expect(
      database.query("SELECT value FROM app_metadata WHERE key = ?").get(SEARCH_INDEX_REBUILD_KEY),
    ).toEqual({ value: "1" });
  } finally {
    database.close();
  }
});

test("rebuilding short search follows note rowid changes", async () => {
  const database = new Database(":memory:");
  try {
    await initializeDatabase(database);
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
    syncNoteShortSearchTerms(database, "user", "note", "标题", "正文包含猫");

    database.query("UPDATE notes SET rowid = 100 WHERE id = ?").run("note");
    rebuildNoteShortSearchIndex(database);

    expect(
      database
        .query(
          "SELECT n.id FROM notes_short_fts JOIN notes n ON n.rowid = notes_short_fts.rowid WHERE notes_short_fts MATCH ?",
        )
        .all(shortSearchToken("猫")),
    ).toEqual([{ id: "note" }]);
  } finally {
    database.close();
  }
});

test("reopening resumes an interrupted short-search rebuild", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xiangying-short-search-recovery-"));
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
    syncNoteShortSearchTerms(first, "user", "note", "标题", "正文包含猫");

    // Simulate a process dying after VACUUM changed rowids but before the
    // derived indexes were rebuilt.
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
            "SELECT n.id FROM notes_short_fts JOIN notes n ON n.rowid = notes_short_fts.rowid WHERE notes_short_fts MATCH ?",
          )
          .all(shortSearchToken("猫")),
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

test("long diverse notes use overflow instead of unbounded token rows", async () => {
  const database = new Database(":memory:");
  try {
    await initializeDatabase(database);
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
    const content = Array.from({ length: MAX_SHORT_INDEX_TOKENS }, (_, index) =>
      String.fromCodePoint(0x4e00 + index),
    ).join("");
    database
      .query(
        "INSERT INTO notes (id, user_id, notebook_id, title, content_markdown, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("note", "user", "notebook", "标题", content, 1, 1);

    syncNoteShortSearchTerms(database, "user", "note", "标题", content);

    expect(
      database.query("SELECT note_id FROM notes_short_overflow WHERE note_id = ?").get("note"),
    ).toEqual({ note_id: "note" });
  } finally {
    database.close();
  }
});
