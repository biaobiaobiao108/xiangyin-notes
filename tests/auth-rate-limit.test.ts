import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../server/db";
import { getLoginAttempt, recordFailedLogin, resetLoginAttempt } from "../server/routes/auth";

test("keeps a late login lockout after its failure window expires", async () => {
  const database = await openDatabase(":memory:");
  const key = `late-lockout-${crypto.randomUUID()}`;
  const startedAt = Math.floor(Date.now() / 1000);
  try {
    for (let index = 0; index < 7; index += 1) recordFailedLogin(database, key, startedAt);
    recordFailedLogin(database, key, startedAt + 899);

    expect(getLoginAttempt(database, key, startedAt + 901)).toMatchObject({ failures: 8, blockedUntil: startedAt + 1799 });
    expect(getLoginAttempt(database, key, startedAt + 1798).blockedUntil).toBe(startedAt + 1799);
    expect(getLoginAttempt(database, key, startedAt + 1799)).toMatchObject({ failures: 0, blockedUntil: 0 });
  } finally {
    resetLoginAttempt(database, key);
    database.close();
  }
});

test("shares and persists rate limits across separate database instances targeting the same SQLite file", async () => {
  const dbPath = join(tmpdir(), `xiangying-rate-limit-multi-${crypto.randomUUID()}.sqlite`);
  const instanceA = await openDatabase(dbPath);
  const instanceB = await openDatabase(dbPath);
  const key = `multi-instance-${crypto.randomUUID()}`;
  const startedAt = Math.floor(Date.now() / 1000);

  try {
    // Record failures on Instance A
    for (let index = 0; index < 8; index += 1) {
      recordFailedLogin(instanceA, key, startedAt);
    }

    // Instance B should immediately see the lockout state written by Instance A
    const attemptOnB = getLoginAttempt(instanceB, key, startedAt + 10);
    expect(attemptOnB.failures).toBe(8);
    expect(attemptOnB.blockedUntil).toBe(startedAt + 900);

    // Simulate restart by opening Instance C
    instanceA.close();
    instanceB.close();
    const instanceC = await openDatabase(dbPath);
    const attemptOnC = getLoginAttempt(instanceC, key, startedAt + 20);
    expect(attemptOnC.failures).toBe(8);
    expect(attemptOnC.blockedUntil).toBe(startedAt + 900);
    instanceC.close();
  } finally {
    await Promise.all([
      rm(dbPath, { force: true }),
      rm(`${dbPath}-wal`, { force: true }),
      rm(`${dbPath}-shm`, { force: true }),
    ]);
  }
});
