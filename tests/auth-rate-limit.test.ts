import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOGIN_ADDRESS_MAX_FAILURES, LOGIN_ATTEMPT_MAX_ENTRIES, LOGIN_BLOCK_SECONDS } from "../server/core";
import { openDatabase } from "../server/test-db";
import { getLoginAttempt, loginClientKey, recordFailedLogin, resetLoginAttempt } from "../server/routes/auth";
import { rateLimitClientAddress } from "../server/core";

test("scopes login rate limits by submitted username and client address", () => {
  const request = new Request("http://localhost/api/auth/login", { method: "POST" });
  const owner = loginClientKey(request, {}, "203.0.113.7", "owner");
  const stranger = loginClientKey(request, {}, "203.0.113.7", "admin");
  const otherAddress = loginClientKey(request, {}, "203.0.113.8", "owner");
  // 猜错用户名不应消耗真实账号的失败额度（反向代理把所有人折叠到同一地址时尤其重要）。
  expect(owner).not.toBe(stranger);
  expect(owner).not.toBe(otherAddress);
  expect(loginClientKey(request, {}, "203.0.113.7", " OWNER ")).toBe(owner);
});

test("keeps a late login lockout after its failure window expires", async () => {
  const database = await openDatabase(":memory:");
  const key = `late-lockout-${crypto.randomUUID()}`;
  const startedAt = Math.floor(Date.now() / 1000);
  try {
    for (let index = 0; index < 7; index += 1) await recordFailedLogin(database, key, startedAt);
    await recordFailedLogin(database, key, startedAt + 899);

    expect(await getLoginAttempt(database, key, startedAt + 901)).toMatchObject({ failures: 8, blockedUntil: startedAt + 1799 });
    expect((await getLoginAttempt(database, key, startedAt + 1798)).blockedUntil).toBe(startedAt + 1799);
    expect(await getLoginAttempt(database, key, startedAt + 1799)).toMatchObject({ failures: 0, blockedUntil: 0 });
  } finally {
    await resetLoginAttempt(database, key);
    database.close();
  }
});

test("applies an address-level limit when failed attempts rotate usernames", async () => {
  const database = await openDatabase(":memory:");
  const request = new Request("http://localhost/api/auth/login", { method: "POST" });
  const addressKey = loginClientKey(request, {}, "203.0.113.19");
  const startedAt = Math.floor(Date.now() / 1000);
  try {
    for (let index = 0; index < LOGIN_ADDRESS_MAX_FAILURES; index += 1) {
      await recordFailedLogin(database, addressKey, startedAt + index, "login_address");
    }

    expect(await getLoginAttempt(database, addressKey, startedAt + LOGIN_ADDRESS_MAX_FAILURES, "login_address"))
      .toMatchObject({ failures: LOGIN_ADDRESS_MAX_FAILURES, blockedUntil: startedAt + LOGIN_ADDRESS_MAX_FAILURES - 1 + LOGIN_BLOCK_SECONDS });
  } finally {
    await resetLoginAttempt(database, addressKey, "login_address");
    database.close();
  }
});

test("does not prune an active username lockout when the key limit is reached", async () => {
  const database = await openDatabase(":memory:");
  const targetKey = `locked-owner-${crypto.randomUUID()}`;
  const startedAt = Math.floor(Date.now() / 1000);
  try {
    for (let index = 0; index < 8; index += 1) await recordFailedLogin(database, targetKey, startedAt);
    for (let index = 0; index < LOGIN_ATTEMPT_MAX_ENTRIES + 10; index += 1) {
      await recordFailedLogin(database, `rotating-user-${index}`, startedAt + 1);
    }

    expect(await getLoginAttempt(database, targetKey, startedAt + 2))
      .toMatchObject({ failures: 8, blockedUntil: startedAt + LOGIN_BLOCK_SECONDS });
  } finally {
    await resetLoginAttempt(database, targetKey);
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
      await recordFailedLogin(instanceA, key, startedAt);
    }

    // Instance B should immediately see the lockout state written by Instance A
    const attemptOnB = await getLoginAttempt(instanceB, key, startedAt + 10);
    expect(attemptOnB.failures).toBe(8);
    expect(attemptOnB.blockedUntil).toBe(startedAt + 900);

    // Simulate restart by opening Instance C
    instanceA.close();
    instanceB.close();
    const instanceC = await openDatabase(dbPath);
    const attemptOnC = await getLoginAttempt(instanceC, key, startedAt + 20);
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

test("rateLimitClientAddress extracts CF-Connecting-IP correctly in Cloudflare Worker environment", () => {
  const reqWithCfIp = new Request("https://example.com/api/auth/login", {
    headers: { "CF-Connecting-IP": "203.0.113.195" },
  });
  expect(rateLimitClientAddress(reqWithCfIp, {}, undefined)).toBe("203.0.113.195");

  const reqWithoutCfIp = new Request("https://example.com/api/auth/login");
  expect(rateLimitClientAddress(reqWithoutCfIp, {}, undefined)).toBe("unknown");
  expect(rateLimitClientAddress(reqWithoutCfIp, {}, "198.51.100.22")).toBe("198.51.100.22");
});
