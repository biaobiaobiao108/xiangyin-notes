import { expect, test } from "bun:test";
import { getLoginAttempt, recordFailedLogin, resetLoginAttempt } from "../server/routes/auth";

test("keeps a late login lockout after its failure window expires", () => {
  const key = `late-lockout-${crypto.randomUUID()}`;
  const startedAt = Math.floor(Date.now() / 1000);
  try {
    for (let index = 0; index < 7; index += 1) recordFailedLogin(key, startedAt);
    recordFailedLogin(key, startedAt + 899);

    expect(getLoginAttempt(key, startedAt + 901)).toMatchObject({ failures: 8, blockedUntil: startedAt + 1799 });
    expect(getLoginAttempt(key, startedAt + 1798).blockedUntil).toBe(startedAt + 1799);
    expect(getLoginAttempt(key, startedAt + 1799)).toMatchObject({ failures: 0, blockedUntil: 0 });
  } finally {
    resetLoginAttempt(key);
  }
});
