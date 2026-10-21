import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { applyMigrations } from "../server/db";

async function createLegacyDatabase(hasSnippet: boolean) {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
    INSERT INTO schema_migrations (name, applied_at) VALUES ('0001_baseline.sql', 1);
    CREATE TABLE note_links (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      source_note_id TEXT NOT NULL,
      target_title TEXT NOT NULL,
      target_title_normalized TEXT NOT NULL DEFAULT '',
      target_note_id TEXT,
      ${hasSnippet ? "snippet TEXT NOT NULL DEFAULT ''," : ""}
      created_at INTEGER NOT NULL
    );
  `);
  if (hasSnippet) database.query("INSERT INTO schema_migrations (name, applied_at) VALUES ('0002_note_links_snippet.sql', 2)").run();
  await applyMigrations(database);
  return database;
}

test("repairs legacy baseline databases with missing note link and rate limit schema", async () => {
  const database = await createLegacyDatabase(false);
  try {
    const columns = database.query("PRAGMA table_info(note_links)").all() as Array<{ name: string }>;
    expect(columns.some((column) => column.name === "snippet")).toBe(true);
    expect(database.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rate_limits'").get()).toBeTruthy();
    expect(database.query("SELECT name FROM schema_migrations WHERE name = '0003_legacy_schema_repair.sql'").get()).toBeTruthy();
  } finally {
    database.close();
  }
});

test("repairs the remaining schema without re-adding a note link snippet column", async () => {
  const database = await createLegacyDatabase(true);
  try {
    const columns = database.query("PRAGMA table_info(note_links)").all() as Array<{ name: string }>;
    expect(columns.filter((column) => column.name === "snippet")).toHaveLength(1);
    expect(database.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_rate_limits_action_expiry'").get()).toBeTruthy();
  } finally {
    database.close();
  }
});
