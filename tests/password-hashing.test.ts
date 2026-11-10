import { expect, test } from "bun:test";
import { derivePassword, LEGACY_PASSWORD_ITERATIONS, PASSWORD_ITERATIONS } from "../server/core";
import { openDatabase } from "../server/db";
import { ensureEnvironmentUser } from "../server/routes/auth";

test("upgrades a legacy password hash without revoking its sessions", async () => {
  const database = await openDatabase(":memory:");
  const username = "owner";
  const password = "correct horse battery staple";
  const salt = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");

  try {
    const legacyHash = await derivePassword(password, salt, LEGACY_PASSWORD_ITERATIONS);
    database
      .query(
        "INSERT INTO users (id, username, password_hash, password_salt, password_iterations, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("legacy-user", username, legacyHash, salt, LEGACY_PASSWORD_ITERATIONS, 1);
    database
      .query(
        "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
      )
      .run("legacy-session", "legacy-user", 1, 2_000_000_000);

    expect(await ensureEnvironmentUser(database, { username, password })).toEqual({
      id: "legacy-user",
      username,
    });

    const upgraded = database
      .query("SELECT password_hash, password_salt, password_iterations FROM users WHERE id = ?")
      .get("legacy-user") as {
      password_hash: string;
      password_salt: string;
      password_iterations: number;
    };
    expect(upgraded.password_iterations).toBe(PASSWORD_ITERATIONS);
    expect(
      await derivePassword(password, upgraded.password_salt, upgraded.password_iterations),
    ).toBe(upgraded.password_hash);
    expect(database.query("SELECT COUNT(*) AS count FROM sessions").get()).toEqual({ count: 1 });
  } finally {
    database.close();
  }
});
