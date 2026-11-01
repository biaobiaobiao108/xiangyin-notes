import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { initializeDatabase, CURRENT_SCHEMA_VERSION } from "../server/db";
import { shortSearchToken, syncNoteShortSearchTerms } from "../server/note-search";

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
