import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Database } from "bun:sqlite";

const DEFAULT_DATABASE_PATH = "./data/xiangying-notes.sqlite";
const DEFAULT_MIGRATIONS_PATH = "./migrations";

type MigrationRow = {
  name: string;
};

type TableCountRow = {
  count: number;
};

export type SqliteDatabase = Database;

export function databasePathFromEnv(env: Record<string, string | undefined> = Bun.env) {
  return env.DATABASE_PATH?.trim() || DEFAULT_DATABASE_PATH;
}

function isEmptyDatabase(database: SqliteDatabase) {
  const row = database.query("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get() as TableCountRow | null | undefined;
  return Number(row?.count ?? 0) === 0;
}

async function countMigrationFiles(migrationsPath: string) {
  const glob = new Bun.Glob("*.sql");
  let count = 0;
  try {
    for await (const file of glob.scan({ cwd: migrationsPath, onlyFiles: true })) {
      if (file) count += 1;
    }
  } catch {
    return 0;
  }
  return count;
}

function appliedMigrationCount(database: SqliteDatabase) {
  try {
    const row = database.query("SELECT COUNT(*) AS count FROM schema_migrations").get() as TableCountRow | null | undefined;
    return Number(row?.count ?? 0);
  } catch {
    return 0;
  }
}

export function reclaimDatabaseSpace(database: SqliteDatabase) {
  try {
    database.exec(`
      INSERT INTO notes_fts(notes_fts) VALUES('optimize');
      PRAGMA incremental_vacuum;
      PRAGMA wal_checkpoint(TRUNCATE);
    `);
  } catch {
    database.exec(`
      PRAGMA incremental_vacuum;
      PRAGMA wal_checkpoint(TRUNCATE);
    `);
  }
}

export async function openDatabase(
  databasePath = databasePathFromEnv(),
) {
  const resolvedPath = databasePath === ":memory:" ? databasePath : resolve(databasePath);
  if (resolvedPath !== ":memory:") await mkdir(dirname(resolvedPath), { recursive: true });

  const database = new Database(resolvedPath, { create: true });
  database.exec("PRAGMA busy_timeout = 5000;");
  const autoVacuumRow = database.query("PRAGMA auto_vacuum;").get() as { auto_vacuum: number } | null | undefined;
  if (Number(autoVacuumRow?.auto_vacuum ?? 0) !== 2) {
    if (resolvedPath !== ":memory:") console.warn("[db] 正在启用 auto_vacuum=INCREMENTAL，首次整理可能需要一些时间");
    database.exec("PRAGMA auto_vacuum = INCREMENTAL;");
    database.exec("VACUUM;");
  }
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA cache_size = -20000;
    PRAGMA temp_store = MEMORY;
  `);
  if (isEmptyDatabase(database)) {
    await applyMigrations(database);
  } else {
    // Existing databases are never migrated automatically; warn instead of failing later at runtime.
    const pending = (await countMigrationFiles(DEFAULT_MIGRATIONS_PATH)) - appliedMigrationCount(database);
    if (pending > 0) console.warn(`[db] 检测到 ${pending} 个未应用的迁移，请执行 bun run db:migrate`);
  }
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
