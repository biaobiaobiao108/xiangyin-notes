import {
  all,
  type AuthCredentials,
  constantTimeEqual,
  createOpaqueToken,
  derivePassword,
  digestHex,
  first,
  hashPassword,
  isSecureRequest,
  json,
  jsonError,
  LOGIN_ATTEMPT_CLEANUP_INTERVAL_SECONDS,
  LOGIN_ATTEMPT_MAX_ENTRIES,
  LOGIN_ADDRESS_MAX_FAILURES,
  LOGIN_BLOCK_SECONDS,
  LOGIN_MAX_FAILURES,
  LOGIN_WINDOW_SECONDS,
  now,
  rateLimitClientAddress,
  readJson,
  type RouteContext,
  SESSION_COOKIE,
  SESSION_CLEANUP_INTERVAL_SECONDS,
  SESSION_COOKIE_TTL,
  SESSION_REFRESH_WINDOW,
  SESSION_TTL,
  syncNoteTags,
  type SqliteDatabase,
  type UserRow,
  welcomeMarkdown,
} from "../core";
import { syncNoteShortSearchTerms } from "../note-search";
import { syncStoredNoteTitleKey } from "../note-links";
import { createRealtimeSessionRevoker, type RealtimeSessionRevoker } from "../realtime-revocation";

type RuntimeEnvironment = Record<string, string | undefined>;

type LoginAttempt = {
  windowStartedAt: number;
  failures: number;
  blockedUntil: number;
};

type LoginRateLimitAction = "login" | "login_address";


type CredentialCheck = { signature: string; task: Promise<string | null>; revocationNotified: boolean };
const credentialChecks = new WeakMap<SqliteDatabase, CredentialCheck>();

async function syncEnvironmentPassword(database: SqliteDatabase, credentials: AuthCredentials, realtime?: RealtimeSessionRevoker) {
  const signature = await digestHex(`${credentials.username}\0${credentials.password}`);
  const previous = credentialChecks.get(database);
  if (previous?.signature === signature) {
    const revokedUserId = await previous.task;
    if (revokedUserId && realtime && !previous.revocationNotified) {
      previous.revocationNotified = true;
      realtime.revokeUser(revokedUserId);
    }
    return;
  }

  const task = (async () => {
    await previous?.task;
    const existing = await first<UserRow & { password_hash: string; password_salt: string }>(
      database,
      "SELECT id, username, password_hash, password_salt FROM users WHERE username = ?",
      credentials.username,
    );
    if (!existing) return null;
    const derived = await derivePassword(credentials.password, existing.password_salt);
    if (constantTimeEqual(derived, existing.password_hash)) return null;

    const replacement = await hashPassword(credentials.password);
    const results = await database.batch([
      { sql: "UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ? AND password_hash = ? AND password_salt = ?", values: [replacement.hash, replacement.salt, existing.id, existing.password_hash, existing.password_salt] },
      { sql: "DELETE FROM sessions WHERE user_id = ? AND EXISTS (SELECT 1 FROM users WHERE id = ? AND password_hash = ? AND password_salt = ?)", values: [existing.id, existing.id, replacement.hash, replacement.salt] },
    ]);
    return results[0]?.changes ? existing.id : null;
  })();
  const check: CredentialCheck = { signature, task, revocationNotified: false };
  credentialChecks.set(database, check);
  try {
    const revokedUserId = await task;
    if (revokedUserId && realtime && !check.revocationNotified) {
      check.revocationNotified = true;
      realtime.revokeUser(revokedUserId);
    }
  } catch (error) {
    if (credentialChecks.get(database)?.task === task) credentialChecks.delete(database);
    throw error;
  }
}

export function getAuthCredentials(environment: RuntimeEnvironment = {}): AuthCredentials | null {
  const username = environment.XIANGYING_USERNAME?.trim();
  const password = environment.XIANGYING_PASSWORD;
  if (!username || password === undefined || password.length === 0) return null;
  return { username, password };
}

export function cookieValue(cookieHeader: string | null, name: string) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? match[1] : null;
}

export function loginClientKey(request: Request, environment: RuntimeEnvironment, clientAddress: string | undefined, username?: string) {
  const address = rateLimitClientAddress(request, environment, clientAddress);
  // Include the submitted username so failed guesses for other names cannot
  // exhaust the owner's budget, which matters when a proxy collapses every
  // client onto one address (TRUST_PROXY not configured).
  const scope = username?.trim().toLowerCase() ?? "";
  return (scope ? `${scope}\u0000${address}` : address).slice(0, 128);
}

const nextRateLimitCleanupAt = new WeakMap<SqliteDatabase, number>();

export async function cleanupExpiredRateLimits(database: SqliteDatabase, timestamp: number) {
  const nextAt = nextRateLimitCleanupAt.get(database) ?? 0;
  if (timestamp < nextAt) return;
  nextRateLimitCleanupAt.set(database, timestamp + LOGIN_ATTEMPT_CLEANUP_INTERVAL_SECONDS);
  await database.query(`
    DELETE FROM rate_limits
    WHERE (blocked_until > 0 AND blocked_until <= ?)
       OR (blocked_until = 0 AND updated_at < ?)
  `).run(timestamp, timestamp - 3600);
  await pruneRateLimitAction(database, "login", LOGIN_ATTEMPT_MAX_ENTRIES, timestamp);
  await pruneRateLimitAction(database, "login_address", LOGIN_ATTEMPT_MAX_ENTRIES, timestamp);
}

async function pruneRateLimitAction(database: SqliteDatabase, action: LoginRateLimitAction, maxEntries: number, timestamp: number) {
  const row = await database.query("SELECT COUNT(*) AS count FROM rate_limits WHERE action = ?").get(action) as { count: number };
  const excess = Number(row.count) - maxEntries;
  if (excess <= 0) return;
  await database.query(`
    DELETE FROM rate_limits
    WHERE action = ? AND key IN (
      SELECT key FROM rate_limits WHERE action = ? AND blocked_until <= ?
      ORDER BY updated_at ASC, key ASC LIMIT ?
    )
  `).run(action, action, timestamp, excess);
}

export async function getLoginAttempt(database: SqliteDatabase, key: string, timestamp: number, action: LoginRateLimitAction = "login"): Promise<LoginAttempt> {
  await cleanupExpiredRateLimits(database, timestamp);
  const row = await database.query("SELECT points, window_started_at, blocked_until FROM rate_limits WHERE action = ? AND key = ?")
    .get(action, key) as { points: number; window_started_at: number; blocked_until: number } | null | undefined;

  if (!row) {
    return { windowStartedAt: timestamp, failures: 0, blockedUntil: 0 };
  }

  if (row.blocked_until > timestamp) {
    return { windowStartedAt: row.window_started_at, failures: row.points, blockedUntil: row.blocked_until };
  }

  if (timestamp - row.window_started_at > LOGIN_WINDOW_SECONDS) {
    return { windowStartedAt: timestamp, failures: 0, blockedUntil: 0 };
  }

  return { windowStartedAt: row.window_started_at, failures: row.points, blockedUntil: 0 };
}

export async function recordFailedLogin(database: SqliteDatabase, key: string, timestamp: number, action: LoginRateLimitAction = "login") {
  const maxFailures = action === "login_address" ? LOGIN_ADDRESS_MAX_FAILURES : LOGIN_MAX_FAILURES;
  await database.query(`
    INSERT INTO rate_limits (action, key, points, window_started_at, blocked_until, updated_at)
    VALUES (?, ?, 1, ?, 0, ?)
    ON CONFLICT(action, key) DO UPDATE SET
      points = CASE WHEN excluded.window_started_at - rate_limits.window_started_at > ? THEN 1 ELSE rate_limits.points + 1 END,
      window_started_at = CASE WHEN excluded.window_started_at - rate_limits.window_started_at > ? THEN excluded.window_started_at ELSE rate_limits.window_started_at END,
      blocked_until = CASE
        WHEN (CASE WHEN excluded.window_started_at - rate_limits.window_started_at > ? THEN 1 ELSE rate_limits.points + 1 END) >= ? THEN excluded.window_started_at + ?
        ELSE 0
      END,
      updated_at = excluded.updated_at
  `).run(action, key, timestamp, timestamp, LOGIN_WINDOW_SECONDS, LOGIN_WINDOW_SECONDS, LOGIN_WINDOW_SECONDS, maxFailures, LOGIN_BLOCK_SECONDS);
  await pruneRateLimitAction(database, action, LOGIN_ATTEMPT_MAX_ENTRIES, timestamp);
}

export async function resetLoginAttempt(database: SqliteDatabase, key: string, action: LoginRateLimitAction = "login") {
  await database.query("DELETE FROM rate_limits WHERE action = ? AND key = ?").run(action, key);
}

export function setSessionCookie(headers: Headers, request: Request, token: string, environment: RuntimeEnvironment, maxAge = SESSION_COOKIE_TTL, clientAddress?: string) {
  const secure = isSecureRequest(request, environment, clientAddress);
  headers.set("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(token)}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`);
}

const nextSessionCleanupAt = new WeakMap<SqliteDatabase, number>();

export async function cleanupExpiredSessions(database: SqliteDatabase, force = false) {
  const timestamp = now();
  if (!force && timestamp < (nextSessionCleanupAt.get(database) ?? 0)) return;
  nextSessionCleanupAt.set(database, timestamp + SESSION_CLEANUP_INTERVAL_SECONDS);
  await database.query("DELETE FROM sessions WHERE expires_at <= ?").run(timestamp);
}

export async function ensureEnvironmentUser(database: SqliteDatabase, credentials: AuthCredentials, realtime?: RealtimeSessionRevoker): Promise<UserRow> {
  await syncEnvironmentPassword(database, credentials, realtime);
  const existing = await first<UserRow>(database, "SELECT id, username FROM users WHERE username = ?", credentials.username);
  if (existing) return existing;

  // Changing XIANGYING_USERNAME creates a new account; the previous account's
  // notes stay in the database but become unreachable from the UI.
  const previousUsers = await all<{ username: string }>(database, "SELECT username FROM users WHERE username != ? ORDER BY created_at LIMIT 3", credentials.username);
  if (previousUsers.length > 0) {
    console.warn(`[auth] 环境变量 XIANGYING_USERNAME=${credentials.username} 与已有账号（${previousUsers.map((user) => user.username).join("、")}）不一致，将创建新账号；原账号的笔记仍保留在数据库中，当前账号不可见。如需继续使用原笔记，请把用户名改回原先的值。`);
  }

  const userId = crypto.randomUUID();
  const inboxId = crypto.randomUUID();
  const noteId = crypto.randomUUID();
  const createdAt = now();
  const password = await hashPassword(credentials.password);

  try {
    await database.batch([
      { sql: "INSERT INTO users (id, username, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)", values: [userId, credentials.username, password.hash, password.salt, createdAt] },
      { sql: "INSERT INTO notebooks (id, user_id, name, color, is_system, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 0, ?, ?)", values: [inboxId, userId, "收件箱", "#d96245", createdAt, createdAt] },
      { sql: "INSERT INTO notes (id, user_id, notebook_id, title, content_markdown, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)", values: [noteId, userId, inboxId, "开始记录你的想法", welcomeMarkdown, createdAt, createdAt] },
    ]);
  } catch (error) {
    const concurrent = await first<UserRow>(database, "SELECT id, username FROM users WHERE username = ?", credentials.username);
    if (concurrent) return concurrent;
    throw error;
  }
  await syncStoredNoteTitleKey(database, noteId, "开始记录你的想法");
  await syncNoteTags(database, userId, noteId, welcomeMarkdown);
  await syncNoteShortSearchTerms(database, userId, noteId, "开始记录你的想法", welcomeMarkdown);
  return { id: userId, username: credentials.username };
}

export async function getCurrentUser(database: SqliteDatabase, environment: RuntimeEnvironment, request: Request, realtime?: RealtimeSessionRevoker) {
  const credentials = getAuthCredentials(environment);
  if (!credentials) return null;
  const session = cookieValue(request.headers.get("Cookie"), SESSION_COOKIE);
  if (!session) return null;
  await syncEnvironmentPassword(database, credentials, realtime);
  const tokenHash = await digestHex(session);
  const timestamp = now();
  const current = await first<UserRow & { session_expires_at: number }>(database, `
    SELECT users.id, users.username, sessions.expires_at AS session_expires_at
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND users.username = ?
  `, tokenHash, timestamp, credentials.username);
  if (!current) return null;
  if (current.session_expires_at <= timestamp + SESSION_REFRESH_WINDOW) {
    await database.query("UPDATE sessions SET expires_at = ? WHERE token_hash = ?").run(timestamp + SESSION_TTL, tokenHash);
  }
  return { id: current.id, username: current.username };
}

export async function requireUser(database: SqliteDatabase, environment: RuntimeEnvironment, request: Request, realtime?: RealtimeSessionRevoker) {
  return (await getCurrentUser(database, environment, request, realtime)) ?? jsonError(401, "UNAUTHENTICATED", "请先登录");
}

export function isResponse(value: UserRow | Response): value is Response {
  return value instanceof Response;
}

export async function handleAuthRoute(ctx: RouteContext): Promise<Response | null> {
  const { request, url, method, options } = ctx;
  const { database, environment = {}, clientAddress } = options;
  const realtime = createRealtimeSessionRevoker(options);

  if (method === "GET" && url.pathname === "/api/health") {
    await first(database, "SELECT 1 AS ok");
    return json({ status: "ok", database: "ok" });
  }

  if (method === "GET" && url.pathname === "/api/bootstrap") {
    const credentials = getAuthCredentials(environment);
    if (credentials && environment.NODE_ENV === "development" && environment.XIANGYING_DEV_AUTO_LOGIN === "true" && !await getCurrentUser(database, environment, request, realtime)) {
      const user = await ensureEnvironmentUser(database, credentials, realtime);
      const session = createOpaqueToken();
      const createdAt = now();
      await database.query("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(await digestHex(session), user.id, createdAt, createdAt + SESSION_TTL);
      const headers = new Headers();
      setSessionCookie(headers, request, session, environment, SESSION_COOKIE_TTL, clientAddress);
      return json({ configured: true }, 200, headers);
    }
    return json({ configured: Boolean(credentials) });
  }

  if (method === "POST" && url.pathname === "/api/setup") {
    return getAuthCredentials(environment)
      ? jsonError(409, "AUTH_MANAGED_BY_ENV", "登录凭据由环境变量管理，无需网页初始化")
      : jsonError(503, "AUTH_NOT_CONFIGURED", "请先配置 XIANGYING_USERNAME 和 XIANGYING_PASSWORD");
  }

  if (method === "POST" && url.pathname === "/api/auth/login") {
    const payload = await readJson<{ username?: unknown; password?: unknown }>(request, 64 * 1024);
    if (!payload || typeof payload.username !== "string" || typeof payload.password !== "string") return jsonError(400, "INVALID_LOGIN", "请输入用户名和密码");
    if (payload.username.length > 128) return jsonError(400, "INVALID_LOGIN", "用户名或密码格式无效");
    const credentials = getAuthCredentials(environment);
    if (!credentials) return jsonError(503, "AUTH_NOT_CONFIGURED", "请先配置 XIANGYING_USERNAME 和 XIANGYING_PASSWORD");
    const attemptKey = loginClientKey(request, environment, clientAddress, payload.username);
    const addressKey = loginClientKey(request, environment, clientAddress);
    const timestamp = now();
    const attempt = await getLoginAttempt(database, attemptKey, timestamp);
    const addressAttempt = await getLoginAttempt(database, addressKey, timestamp, "login_address");
    const retryAfter = Math.max(attempt.blockedUntil, addressAttempt.blockedUntil) - timestamp;
    if (retryAfter > 0) return jsonError(429, "TOO_MANY_LOGIN_ATTEMPTS", "登录尝试过于频繁，请稍后再试", { "Retry-After": String(retryAfter) });
    if (!constantTimeEqual(payload.username, credentials.username) || !constantTimeEqual(payload.password, credentials.password)) {
      await recordFailedLogin(database, attemptKey, timestamp);
      await recordFailedLogin(database, addressKey, timestamp, "login_address");
      return jsonError(401, "INVALID_CREDENTIALS", "用户名或密码不正确");
    }
    await resetLoginAttempt(database, attemptKey);
    await resetLoginAttempt(database, addressKey, "login_address");

    const user = await ensureEnvironmentUser(database, credentials, realtime);
    const session = createOpaqueToken();
    const createdAt = now();
    await database.query("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(await digestHex(session), user.id, createdAt, createdAt + SESSION_TTL);
    const headers = new Headers();
    setSessionCookie(headers, request, session, environment, SESSION_COOKIE_TTL, clientAddress);
    return json({ user }, 200, headers);
  }

  if (method === "POST" && url.pathname === "/api/auth/logout") {
    const session = cookieValue(request.headers.get("Cookie"), SESSION_COOKIE);
    if (session) {
      const tokenHash = await digestHex(session);
      const activeSession = await first<{ user_id: string }>(database, "SELECT user_id FROM sessions WHERE token_hash = ?", tokenHash);
      await database.query("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
      if (activeSession) realtime?.revokeSession(activeSession.user_id, tokenHash);
    }
    const headers = new Headers();
    setSessionCookie(headers, request, "", environment, 0, clientAddress);
    headers.set("Clear-Site-Data", '"cookies"');
    return json({ ok: true }, 200, headers);
  }

  if (method === "GET" && url.pathname === "/api/me") {
    const user = await requireUser(database, environment, request, realtime);
    if (isResponse(user)) return user;
    const headers = new Headers();
    const session = cookieValue(request.headers.get("Cookie"), SESSION_COOKIE);
    if (session) setSessionCookie(headers, request, session, environment, SESSION_COOKIE_TTL, clientAddress);
    return json({ user }, 200, headers);
  }

  return null;
}
