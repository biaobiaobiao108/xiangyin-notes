import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Database } from "bun:sqlite";

const DEFAULT_DATABASE_PATH = "./data/lumen-notes.sqlite";
const DEFAULT_MIGRATIONS_PATH = "./migrations";

type MigrationRow = {
  name: string;
};

export type SqliteDatabase = Database;

export function databasePathFromEnv(env: Record<string, string | undefined> = Bun.env) {
  return env.DATABASE_PATH?.trim() || DEFAULT_DATABASE_PATH;
}

export async function openDatabase(
  databasePath = databasePathFromEnv(),
) {
  const resolvedPath = databasePath === ":memory:" ? databasePath : resolve(databasePath);
  if (resolvedPath !== ":memory:") await mkdir(dirname(resolvedPath), { recursive: true });

  const database = new Database(resolvedPath, { create: true });
  database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
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
  }
}
