import { CloudflareDatabaseAdapter, type BatchStatement, type SqliteRunResult } from "./d1";
import {
  applyMigrations as applyTestMigrations,
  openDatabase as openTestDatabase,
  reclaimDatabaseSpace as reclaimTestDatabaseSpace,
} from "./test-db";

export * from "./d1";

export type TestSqliteDatabase = import("bun:sqlite").Database & {
  batch(statements: BatchStatement[]): Promise<SqliteRunResult[]>;
};

/** Kept as a source-compatible name while route modules are migrated. */
export type SqliteDatabase = CloudflareDatabaseAdapter | TestSqliteDatabase;

export async function openDatabase(databasePath = ":memory:"): Promise<TestSqliteDatabase> {
  return await openTestDatabase(databasePath);
}

export const applyMigrations = applyTestMigrations;
export const reclaimDatabaseSpace = reclaimTestDatabaseSpace;
