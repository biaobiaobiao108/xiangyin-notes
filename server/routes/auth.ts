import {
  type AuthCredentials,
  constantTimeEqual,
  cookieHeader,
  createOpaqueToken,
  derivePassword,
  digestHex,
  first,
  hashPassword,
  isSecureRequest,
  json,
  jsonError,
  now,
  rateLimitClientAddress,
  readJson,
  type RouteContext,
  SESSION_COOKIE,
  SESSION_CLEANUP_INTERVAL_SECONDS,
  SESSION_TTL,
  syncNoteTags,
  type SqliteDatabase,
  type UserRow,
  welcomeMarkdown,
} from "../core";
import { syncNoteShortSearchTerms } from "../note-search";
import { syncStoredNoteTitleKey } from "../note-links";

type RuntimeEnvironment = Record<string, string | undefined>;

type LoginAttempt = {
  windowStartedAt: number;
  failures: number;
  blockedUntil: number;
};

const SESSION_COOKIE_TTL = 60 * 60 * 24 * 400;
const SESSION_REFRESH_WINDOW = 60 * 60 * 24 * 7;
const LOGIN_WINDOW_SECONDS = 15 * 60;
const LOGIN_MAX_FAILURES = 8;
const LOGIN_BLOCK_SECONDS = 15 * 60;
const LOGIN_ATTEMPT_CLEANUP_INTERVAL_SECONDS = 60;

const credentialChecks = new WeakMap<SqliteDatabase, { signature: string; task: Promise<void> }>();

async function syncEnvironmentPassword(database: SqliteDatabase, credentials: AuthCredentials) {
  const signature = await digestHex(`${credentials.username}\0${credentials.password}`);
  const previous = credentialChecks.get(database);
  if (previous?.signature === signature) return previous.task;

  const task = (async () => {
    await previous?.task;
    const existing = first<UserRow & { password_hash: string; password_salt: string }>(
      database,
      "SELECT id, username, password_hash, password_salt FROM users WHERE username = ?",
      credentials.username,
    );
    if (!existing) return;
    const derived = await derivePassword(credentials.password, existing.password_salt);
    if (constantTimeEqual(derived, existing.password_hash)) return;

    const replacement = await hashPassword(credentials.password);
    database.transaction(() => {
      const updated = database.query("UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ? AND password_hash = ? AND password_salt = ?")
        .run(replacement.hash, replacement.salt, existing.id, existing.password_hash, existing.password_salt);
      if (updated.changes) database.query("DELETE FROM sessions WHERE user_id = ?").run(existing.id);
    })();
  })();
  credentialChecks.set(database, { signature, task });
  try {
    await task;
  } catch (error) {
    if (credentialChecks.get(database)?.task === task) credentialChecks.delete(database);
    throw error;
  }
}

export function getAuthCredentials(environment: RuntimeEnvironment = Bun.env): AuthCredentials | null {
  const username = environment.XIANGYING_USERNAME?.trim();
  const password = environment.XIANGYING_PASSWORD?.trim();
  if (!username || !password) return null;
  return { username, password };
}

export function cookieValue(cookieHeader: string | null, name: string) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? match[1] : null;
}

export function loginClientKey(request: Request, environment: RuntimeEnvironment, clientAddress: string | undefined, username: string) {
  const address = rateLimitClientAddress(request, environment, clientAddress);
  return `${address.slice(0, 128)}:${username.slice(0, 32)}`;
}

const nextRateLimitCleanupAt = new WeakMap<SqliteDatabase, number>();

export function cleanupExpiredRateLimits(database: SqliteDatabase, timestamp: number) {
  const nextAt = nextRateLimitCleanupAt.get(database) ?? 0;
  if (timestamp < nextAt) return;
  nextRateLimitCleanupAt.set(database, timestamp + LOGIN_ATTEMPT_CLEANUP_INTERVAL_SECONDS);
  database.query("DELETE FROM rate_limits WHERE blocked_until <= ? AND updated_at < ?").run(timestamp, timestamp - 3600);
}

export function getLoginAttempt(database: SqliteDatabase, key: string, timestamp: number): LoginAttempt {
  cleanupExpiredRateLimits(database, timestamp);
  const row = database.query("SELECT points, window_started_at, blocked_until FROM rate_limits WHERE action = 'login' AND key = ?")
    .get(key) as { points: number; window_started_at: number; blocked_until: number } | null | undefined;

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

export function recordFailedLogin(database: SqliteDatabase, key: string, timestamp: number) {
  database.transaction(() => {
    const current = getLoginAttempt(database, key, timestamp);
    const failures = current.failures + 1;
    const windowStartedAt = current.failures === 0 ? timestamp : current.windowStartedAt;
    const blockedUntil = failures >= LOGIN_MAX_FAILURES ? timestamp + LOGIN_BLOCK_SECONDS : 0;

    database.query(`
      INSERT INTO rate_limits (action, key, points, window_started_at, blocked_until, updated_at)
      VALUES ('login', ?, ?, ?, ?, ?)
      ON CONFLICT(action, key) DO UPDATE SET
        points = excluded.points,
        window_started_at = excluded.window_started_at,
        blocked_until = excluded.blocked_until,
        updated_at = excluded.updated_at
    `).run(key, failures, windowStartedAt, blockedUntil, timestamp);
  })();
}

export function resetLoginAttempt(database: SqliteDatabase, key: string) {
  database.query("DELETE FROM rate_limits WHERE action = 'login' AND key = ?").run(key);
}

export function setSessionCookie(headers: Headers, request: Request, token: string, environment: RuntimeEnvironment, maxAge = SESSION_COOKIE_TTL) {
  const secure = environment.COOKIE_SECURE === "true";
  headers.set("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(token)}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`);
}

const nextSessionCleanupAt = new WeakMap<SqliteDatabase, number>();

export function cleanupExpiredSessions(database: SqliteDatabase, force = false) {
  const timestamp = now();
  if (!force && timestamp < (nextSessionCleanupAt.get(database) ?? 0)) return;
  nextSessionCleanupAt.set(database, timestamp + SESSION_CLEANUP_INTERVAL_SECONDS);
  database.query("DELETE FROM sessions WHERE expires_at <= ?").run(timestamp);
}

export async function ensureEnvironmentUser(database: SqliteDatabase, credentials: AuthCredentials): Promise<UserRow> {
  await syncEnvironmentPassword(database, credentials);
  const existing = first<UserRow>(database, "SELECT id, username FROM users WHERE username = ?", credentials.username);
  if (existing) return existing;

  const userId = crypto.randomUUID();
  const inboxId = crypto.randomUUID();
  const noteId = crypto.randomUUID();
  const createdAt = now();
  const password = await hashPassword(credentials.password);

  try {
    const seed = database.transaction(() => {
      database.query("INSERT INTO users (id, username, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)").run(userId, credentials.username, password.hash, password.salt, createdAt);
      database.query("INSERT INTO notebooks (id, user_id, name, color, is_system, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 0, ?, ?)").run(inboxId, userId, "收件箱", "#d96245", createdAt, createdAt);
      database.query("INSERT INTO notes (id, user_id, notebook_id, title, content_markdown, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)").run(noteId, userId, inboxId, "开始记录你的想法", welcomeMarkdown, createdAt, createdAt);
      syncStoredNoteTitleKey(database, noteId, "开始记录你的想法");
      syncNoteTags(database, userId, noteId, welcomeMarkdown);
      syncNoteShortSearchTerms(database, userId, noteId, "开始记录你的想法", welcomeMarkdown);
    });
    seed();
    return { id: userId, username: credentials.username };
  } catch (error) {
    const concurrent = first<UserRow>(database, "SELECT id, username FROM users WHERE username = ?", credentials.username);
    if (concurrent) return concurrent;
    throw error;
  }
}

export async function getCurrentUser(database: SqliteDatabase, environment: RuntimeEnvironment, request: Request) {
  const credentials = getAuthCredentials(environment);
  if (!credentials) return null;
  const session = cookieValue(request.headers.get("Cookie"), SESSION_COOKIE);
  if (!session) return null;
  await syncEnvironmentPassword(database, credentials);
  const tokenHash = await digestHex(session);
  const timestamp = now();
  const current = first<UserRow & { session_expires_at: number }>(database, `
    SELECT users.id, users.username, sessions.expires_at AS session_expires_at
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND users.username = ?
  `, tokenHash, timestamp, credentials.username);
  if (!current) return null;
  if (current.session_expires_at <= timestamp + SESSION_REFRESH_WINDOW) {
    database.query("UPDATE sessions SET expires_at = ? WHERE token_hash = ?").run(timestamp + SESSION_TTL, tokenHash);
  }
  return { id: current.id, username: current.username };
}

export async function requireUser(database: SqliteDatabase, environment: RuntimeEnvironment, request: Request) {
  return (await getCurrentUser(database, environment, request)) ?? jsonError(401, "UNAUTHENTICATED", "请先登录");
}

export function isResponse(value: UserRow | Response): value is Response {
  return value instanceof Response;
}

export async function handleAuthRoute(ctx: RouteContext): Promise<Response | null> {
  const { request, url, method, options } = ctx;
  const { database, environment = {}, clientAddress } = options;

  if (method === "GET" && url.pathname === "/api/health") {
    first(database, "SELECT 1 AS ok");
    return json({ status: "ok", database: "ok" });
  }

  if (method === "GET" && url.pathname === "/api/bootstrap") {
    const credentials = getAuthCredentials(environment);
    if (credentials && environment.NODE_ENV === "development" && environment.XIANGYING_DEV_AUTO_LOGIN === "true" && !await getCurrentUser(database, environment, request)) {
      const user = await ensureEnvironmentUser(database, credentials);
      const session = createOpaqueToken();
      const createdAt = now();
      database.query("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(await digestHex(session), user.id, createdAt, createdAt + SESSION_TTL);
      const headers = new Headers();
      setSessionCookie(headers, request, session, environment);
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
    const timestamp = now();
    const attempt = getLoginAttempt(database, attemptKey, timestamp);
    if (attempt.blockedUntil > timestamp) return jsonError(429, "TOO_MANY_LOGIN_ATTEMPTS", "登录尝试过于频繁，请稍后再试", { "Retry-After": String(attempt.blockedUntil - timestamp) });
    if (!constantTimeEqual(payload.username, credentials.username) || !constantTimeEqual(payload.password, credentials.password)) {
      recordFailedLogin(database, attemptKey, timestamp);
      return jsonError(401, "INVALID_CREDENTIALS", "用户名或密码不正确");
    }
    resetLoginAttempt(database, attemptKey);

    const user = await ensureEnvironmentUser(database, credentials);
    const session = createOpaqueToken();
    const createdAt = now();
    database.query("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(await digestHex(session), user.id, createdAt, createdAt + SESSION_TTL);
    const headers = new Headers();
    setSessionCookie(headers, request, session, environment);
    return json({ user }, 200, headers);
  }

  if (method === "POST" && url.pathname === "/api/auth/logout") {
    const session = cookieValue(request.headers.get("Cookie"), SESSION_COOKIE);
    if (session) database.query("DELETE FROM sessions WHERE token_hash = ?").run(await digestHex(session));
    const headers = new Headers();
    setSessionCookie(headers, request, "", environment, 0);
    headers.set("Clear-Site-Data", '"cookies"');
    return json({ ok: true }, 200, headers);
  }

  if (method === "GET" && url.pathname === "/api/me") {
    const user = await requireUser(database, environment, request);
    if (isResponse(user)) return user;
    const headers = new Headers();
    const session = cookieValue(request.headers.get("Cookie"), SESSION_COOKIE);
    if (session) setSessionCookie(headers, request, session, environment);
    return json({ user }, 200, headers);
  }

  return null;
}
