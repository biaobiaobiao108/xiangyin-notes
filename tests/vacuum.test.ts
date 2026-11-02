import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkpointDatabase,
  openDatabase,
  reclaimDatabaseSpace,
  type SqliteDatabase,
} from "../server/db";
import { runVacuum } from "../server/vacuum";

describe("database vacuum and reclaim", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `xiangying-vacuum-test-${crypto.randomUUID()}.sqlite`);
  });

  afterEach(async () => {
    await rm(dbPath, { force: true }).catch(() => {});
    await rm(`${dbPath}-wal`, { force: true }).catch(() => {});
    await rm(`${dbPath}-shm`, { force: true }).catch(() => {});
  });

  test("reclaimDatabaseSpace executes incremental vacuum and WAL truncate", async () => {
    const db: SqliteDatabase = await openDatabase(dbPath);
    try {
      expect(() => reclaimDatabaseSpace(db)).not.toThrow();
    } finally {
      db.close();
    }
  });

  test("checkpointDatabase completes a WAL checkpoint", async () => {
    const db: SqliteDatabase = await openDatabase(dbPath);
    try {
      db.exec("CREATE TABLE checkpoint_probe (value TEXT)");
      db.query("INSERT INTO checkpoint_probe (value) VALUES (?)").run("pending");
      expect((db.query("PRAGMA wal_checkpoint;").get() as { busy: number }).busy).toBe(0);
      expect(() => checkpointDatabase(db)).not.toThrow();
      expect((db.query("PRAGMA wal_checkpoint;").get() as { busy: number }).busy).toBe(0);
    } finally {
      db.close();
    }
  });

  test("runVacuum opens, optimizes, reclaims, and closes target database", async () => {
    // Initialize database file
    const initialDb = await openDatabase(dbPath);
    initialDb.close();

    await expect(runVacuum(dbPath)).resolves.toBeUndefined();
  });
});
