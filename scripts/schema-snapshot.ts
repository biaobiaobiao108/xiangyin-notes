import { Database } from "bun:sqlite";

const FTS_SHADOW_TABLES = new Set([
  "notes_fts_data",
  "notes_fts_idx",
  "notes_fts_docsize",
  "notes_fts_config",
]);

export function snapshotSchema(database: Database) {
  const rows = database.query("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL").all() as Array<{ type: string; name: string; sql: string }>;
  const objects = new Map<string, string>();
  for (const row of rows) {
    if (FTS_SHADOW_TABLES.has(row.name)) continue;
    objects.set(`${row.type}:${row.name}`, (row.sql ?? "").replace(/\s+/g, " ").replace(/\"/g, "").trim());
  }
  return objects;
}
