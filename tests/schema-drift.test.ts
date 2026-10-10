import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { snapshotSchema } from "../scripts/schema-snapshot";

describe("schema drift snapshots", () => {
  test("keeps the FTS virtual table while excluding its SQLite-managed shadow tables", () => {
    const database = new Database(":memory:");
    try {
      database.exec("CREATE TABLE notes (rowid INTEGER PRIMARY KEY, title TEXT NOT NULL)");
      database.exec("CREATE VIRTUAL TABLE notes_fts USING fts5(title, content='notes', content_rowid='rowid', tokenize='trigram')");

      const snapshot = snapshotSchema(database);

      expect(snapshot.has("table:notes_fts")).toBe(true);
      expect(snapshot.has("table:notes_fts_data")).toBe(false);
      expect(snapshot.has("table:notes_fts_idx")).toBe(false);
      expect(snapshot.has("table:notes_fts_config")).toBe(false);
    } finally {
      database.close();
    }
  });
});
