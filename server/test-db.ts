import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Database } from "bun:sqlite";
import type { BatchStatement, SqliteRunResult, TestSqliteDatabase } from "./db";

export type { TestSqliteDatabase } from "./db";

const migrationsRoot = resolve("migrations-d1");

export async function openDatabase(databasePath = ":memory:"): Promise<TestSqliteDatabase> {
  const resolvedPath = databasePath === ":memory:" ? databasePath : resolve(databasePath);
  if (resolvedPath !== ":memory:") await mkdir(dirname(resolvedPath), { recursive: true });
  const database = new Database(resolvedPath, { create: true });
  database.exec("PRAGMA foreign_keys = ON; PRAGMA auto_vacuum = INCREMENTAL;");
  Object.defineProperty(database, "batch", {
    configurable: true,
    value: async (statements: BatchStatement[]): Promise<SqliteRunResult[]> => {
      const apply = database.transaction(() => statements.map(({ sql, values = [] }) => {
        const statement = database.query(sql);
        if (/^\s*SELECT\b/iu.test(sql)) {
          return { changes: 0, results: statement.all(...values) as Record<string, unknown>[] };
        }
        const result = statement.run(...values);
        return { changes: result.changes };
      }));
      return apply();
    },
  });
  const enhanced = database as TestSqliteDatabase;
  await applyMigrations(enhanced);
  return enhanced;
}

export async function applyMigrations(database: TestSqliteDatabase, migrationsPath = migrationsRoot) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
  `);
  const glob = new Bun.Glob("*.sql");
  const files: string[] = [];
  for await (const file of glob.scan({ cwd: migrationsPath, onlyFiles: true })) files.push(file);
  for (const file of files.sort()) {
    const existing = database.query("SELECT name FROM schema_migrations WHERE name = ?").get(file);
    if (existing) continue;
    const sql = await Bun.file(resolve(migrationsPath, file)).text();
    const apply = database.transaction(() => {
      database.exec(sql);
      database.query("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(file, Date.now());
    });
    apply();
  }
}

export function reclaimDatabaseSpace(database: TestSqliteDatabase) {
  database.exec("INSERT INTO notes_fts(notes_fts) VALUES('optimize'); PRAGMA incremental_vacuum;");
}
