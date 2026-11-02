import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { initializeDatabase, CURRENT_SCHEMA_VERSION } from "../server/db";
import {
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
