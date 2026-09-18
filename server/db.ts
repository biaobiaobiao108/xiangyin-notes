import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { extractTags, normalizeTag } from "../shared/tags";

const DEFAULT_DATABASE_PATH = "./data/xiangying-notes.sqlite";
const DEFAULT_MIGRATIONS_PATH = "./migrations";

type MigrationRow = {
  name: string;
};

type TableCountRow = {
  count: number;
};

export type SqliteDatabase = Database;

function rebuildNoteTags(database: SqliteDatabase) {
  const notes = database.query("SELECT id, user_id, content_markdown FROM notes").all() as Array<{ id: string; user_id: string; content_markdown: string }>;
  const rebuild = database.transaction(() => {
    database.query("DELETE FROM note_tags").run();
    const insert = database.query("INSERT INTO note_tags (note_id, user_id, tag_normalized, tag, position) VALUES (?, ?, ?, ?, ?)");
    for (const note of notes) {
      const seen = new Set<string>();
      let position = 0;
      for (const tag of extractTags(note.content_markdown)) {
        const normalized = normalizeTag(tag);
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        insert.run(note.id, note.user_id, normalized, tag, position++);
      }
    }
  });
  rebuild();
}

export function databasePathFromEnv(env: Record<string, string | undefined> = Bun.env) {
  return env.DATABASE_PATH?.trim() || DEFAULT_DATABASE_PATH;
}

function isEmptyDatabase(database: SqliteDatabase) {
  const row = database.query("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get() as TableCountRow | null | undefined;
  return Number(row?.count ?? 0) === 0;
}

export async function openDatabase(
  databasePath = databasePathFromEnv(),
) {
  const resolvedPath = databasePath === ":memory:" ? databasePath : resolve(databasePath);
  if (resolvedPath !== ":memory:") await mkdir(dirname(resolvedPath), { recursive: true });

  const database = new Database(resolvedPath, { create: true });
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA cache_size = -20000;
    PRAGMA temp_store = MEMORY;
  `);
  if (isEmptyDatabase(database)) await applyMigrations(database);
  return database;
}

export async function applyMigrations(database: SqliteDatabase, migrationsPath = DEFAULT_MIGRATIONS_PATH) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);

  const migrationFiles: string[] = [];
  const glob = new Bun.Glob("*.sql");
  for await (const file of glob.scan({ cwd: migrationsPath, onlyFiles: true })) migrationFiles.push(file);

  for (const file of migrationFiles.sort()) {
    const name = file.replaceAll("\\", "/");
    const applied = database.query("SELECT name FROM schema_migrations WHERE name = ?").get(name) as MigrationRow | null;
    if (applied) continue;

    const sql = await Bun.file(join(migrationsPath, file)).text();
    const applyMigration = database.transaction(() => {
      database.exec(sql);
      database.query("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(name, Date.now());
    });
    applyMigration();
    if (name === "0002_note_tags.sql") rebuildNoteTags(database);
  }
}
