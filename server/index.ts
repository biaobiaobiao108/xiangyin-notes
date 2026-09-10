import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ShareSnapshot, Note, NoteSummary, Share } from "../shared/types";
import { openDatabase, type SqliteDatabase } from "./db";

const SESSION_COOKIE = "xiangying_session";
const SESSION_TTL = 60 * 60 * 24 * 30;
const SHARE_TTL = 60 * 60 * 24 * 7;
const PASSWORD_ITERATIONS = 100_000;
const NOTE_PAGE_SIZE = 100;
const DEFAULT_CLIENT_ROOT = "./dist/client";
const encoder = new TextEncoder();

type SqlValue = string | number | null | Uint8Array | bigint;

export type RuntimeEnvironment = Record<string, string | undefined>;

export type ServerOptions = {
  database: SqliteDatabase;
  environment: RuntimeEnvironment;
  clientRoot?: string;
};

type UserRow = {
  id: string;
  username: string;
};

type NoteRow = {
  id: string;
  title: string;
  content_markdown: string;
  notebook_id: string;
  notebook_name: string;
  notebook_color: string;
  is_favorite: number;
  deleted_at: number | null;
  version: number;
  created_at: number;
  updated_at: number;
};

type ShareRow = {
  id: string;
  note_id: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  snapshot_title: string;
  snapshot_content_markdown: string;
};

type AuthCredentials = {
  username: string;
  password: string;
};

const welcomeMarkdown = "## 欢迎来到象映笔记\n\n这是你的第一个笔记。按下 **Ctrl /** 可以打开命令菜单，开始记录你的想法。\n\n- 写下值得保留的东西\n- 用笔记本整理上下文\n- 随时生成一个 7 天有效的只读分享\n";

function now() {
  return Math.floor(Date.now() / 1000);
}

function first<T>(database: SqliteDatabase, sql: string, ...values: SqlValue[]) {
  return (database.query(sql).get(...values) as T | null | undefined) ?? null;
}

function all<T>(database: SqliteDatabase, sql: string, ...values: SqlValue[]) {
  return database.query(sql).all(...values) as T[];
}

function toHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(value: string) {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function toBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function createOpaqueToken() {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function digestHex(value: string) {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

export async function derivePassword(password: string, saltHex: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: fromHex(saltHex), iterations: PASSWORD_ITERATIONS, hash: "SHA-256" },
    key,
    256,
  );
  return toHex(new Uint8Array(bits));
}

export async function hashPassword(password: string) {
  const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
  return { salt, hash: await derivePassword(password, salt) };
}

export function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function cookieValue(header: string | null, name: string) {
  const value = header?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return value ? decodeURIComponent(value.slice(name.length + 1)) : null;
}

function validUsername(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{3,32}$/.test(value);
}

function validPassword(value: unknown): value is string {
  return typeof value === "string" && value.length >= 12 && value.length <= 128;
}

function validText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

function validColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

function getAuthCredentials(environment: RuntimeEnvironment): AuthCredentials | null {
  if (!validUsername(environment.XIANGYING_USERNAME) || !validPassword(environment.XIANGYING_PASSWORD)) return null;
  return { username: environment.XIANGYING_USERNAME, password: environment.XIANGYING_PASSWORD };
}

function getPublicOrigin(requestUrl: URL, environment: RuntimeEnvironment) {
  const configuredUrl = environment.PUBLIC_URL?.trim();
  if (!configuredUrl) return requestUrl.origin;
  const publicUrl = new URL(configuredUrl);
  if (publicUrl.protocol !== "http:" && publicUrl.protocol !== "https:") throw new Error("PUBLIC_URL must use http or https");
  return publicUrl.origin;
}

function json(data: unknown, status = 200, headers?: HeadersInit) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { status, headers: responseHeaders });
}

function jsonError(status: number, code: string, message: string, fields?: Record<string, string>) {
  return json({ error: { code, message, ...(fields ? { fields } : {}) } }, status);
}

async function readJson<T>(request: Request) {
  try {
    return await request.json() as T;
  } catch {
    return null;
  }
}

function setSessionCookie(headers: Headers, request: Request, token: string, environment: RuntimeEnvironment, maxAge = SESSION_TTL) {
  const secure = environment.COOKIE_SECURE === "true";
  headers.set("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(token)}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`);
}

function toNote(row: NoteRow): NoteSummary {
  return {
    id: row.id,
    title: row.title,
    preview: formatPreview(row.content_markdown),
    notebookId: row.notebook_id,
    notebookName: row.notebook_name,
    isFavorite: Boolean(row.is_favorite),
    deletedAt: row.deleted_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toFullNote(row: NoteRow): Note {
  return { ...toNote(row), contentMarkdown: row.content_markdown };
}

export function formatPreview(markdown: string) {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`~\-[\]()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s+([,.;!?。！？、，；：])/g, "$1")
    .slice(0, 180);
}

export function buildFtsQuery(query: string) {
  return query
    .trim()
    .split(/\s+/)
    .map((part) => part.replace(/[^\p{L}\p{N}_-]/gu, ""))
    .filter(Boolean)
    .map((part) => `"${part.replaceAll('"', '""')}"`)
    .join(" AND ");
}

function getNote(database: SqliteDatabase, userId: string, noteId: string) {
  return first<NoteRow>(database, `
    SELECT n.id, n.title, n.content_markdown, n.notebook_id, b.name AS notebook_name,
      b.color AS notebook_color, n.is_favorite, n.deleted_at, n.version, n.created_at, n.updated_at
    FROM notes n JOIN notebooks b ON b.id = n.notebook_id
    WHERE n.id = ? AND n.user_id = ?
  `, noteId, userId);
}

async function ensureEnvironmentUser(database: SqliteDatabase, credentials: AuthCredentials): Promise<UserRow> {
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
      database.query("INSERT INTO notes_fts (note_id, title, content) VALUES (?, ?, ?)").run(noteId, "开始记录你的想法", welcomeMarkdown);
    });
    seed();
    return { id: userId, username: credentials.username };
  } catch (error) {
    const concurrent = first<UserRow>(database, "SELECT id, username FROM users WHERE username = ?", credentials.username);
    if (concurrent) return concurrent;
    throw error;
  }
}

async function getCurrentUser(database: SqliteDatabase, environment: RuntimeEnvironment, request: Request) {
  const credentials = getAuthCredentials(environment);
  if (!credentials) return null;
  const session = cookieValue(request.headers.get("Cookie"), SESSION_COOKIE);
  if (!session) return null;
  const tokenHash = await digestHex(session);
  return first<UserRow>(database, `
    SELECT users.id, users.username
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND users.username = ?
  `, tokenHash, now(), credentials.username);
}

async function requireUser(database: SqliteDatabase, environment: RuntimeEnvironment, request: Request) {
  return await getCurrentUser(database, environment, request) ?? jsonError(401, "UNAUTHENTICATED", "请先登录");
}

function isResponse(value: UserRow | Response): value is Response {
  return value instanceof Response;
}

function createNote(database: SqliteDatabase, userId: string, notebookId: string, title: string, contentMarkdown: string) {
  const id = crypto.randomUUID();
  const createdAt = now();
  const transaction = database.transaction(() => {
    database.query("INSERT INTO notes (id, user_id, notebook_id, title, content_markdown, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)").run(id, userId, notebookId, title, contentMarkdown, createdAt, createdAt);
    database.query("INSERT INTO notes_fts (note_id, title, content) VALUES (?, ?, ?)").run(id, title, contentMarkdown);
  });
  transaction();
  return id;
}

function updateNote(
  database: SqliteDatabase,
  current: NoteRow,
  userId: string,
  title: string,
  contentMarkdown: string,
  notebookId: string,
  isFavorite: number,
  deletedAt: number | null,
) {
  const updatedAt = now();
  const transaction = database.transaction(() => {
    const result = database.query("UPDATE notes SET title = ?, content_markdown = ?, notebook_id = ?, is_favorite = ?, deleted_at = ?, version = version + 1, updated_at = ? WHERE id = ? AND user_id = ? AND version = ?").run(title, contentMarkdown, notebookId, isFavorite, deletedAt, updatedAt, current.id, userId, current.version);
    if (result.changes !== 1) return false;
    database.query("DELETE FROM notes_fts WHERE note_id = ?").run(current.id);
    database.query("INSERT INTO notes_fts (note_id, title, content) VALUES (?, ?, ?)").run(current.id, title, contentMarkdown);
    return true;
  });
  return transaction();
}

function toShare(row: { id: string; note_id: string; created_at: number; expires_at: number; revoked_at: number | null }): Share {
  return { id: row.id, noteId: row.note_id, createdAt: row.created_at, expiresAt: row.expires_at, revokedAt: row.revoked_at };
}

async function handleApi(request: Request, options: ServerOptions) {
  const { database, environment } = options;
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const segments = url.pathname.split("/").filter(Boolean).slice(1).map((segment) => decodeURIComponent(segment));
  const resource = segments[0] ?? "";
  const id = segments[1] ?? "";
  const subresource = segments[2] ?? "";

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
    const payload = await readJson<{ username?: unknown; password?: unknown }>(request);
    if (!payload || typeof payload.username !== "string" || typeof payload.password !== "string") return jsonError(400, "INVALID_LOGIN", "请输入用户名和密码");
    const credentials = getAuthCredentials(environment);
    if (!credentials) return jsonError(503, "AUTH_NOT_CONFIGURED", "请先配置 XIANGYING_USERNAME 和 XIANGYING_PASSWORD");
    if (!constantTimeEqual(payload.username, credentials.username) || !constantTimeEqual(payload.password, credentials.password)) return jsonError(401, "INVALID_CREDENTIALS", "用户名或密码不正确");

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
    return json({ ok: true }, 200, headers);
  }

  const user = await requireUser(database, environment, request);
  if (isResponse(user)) return user;

  if (method === "GET" && url.pathname === "/api/me") return json({ user });

  if (resource === "notes" && !id && method === "GET") {
    const view = url.searchParams.get("view") ?? "all";
    const query = url.searchParams.get("query")?.slice(0, 80) ?? "";
    const notebookId = url.searchParams.get("notebookId");
    const conditions = ["n.user_id = ?"];
    const params: SqlValue[] = [user.id];
    let from = "notes n JOIN notebooks b ON b.id = n.notebook_id";

    if (view === "trash") conditions.push("n.deleted_at IS NOT NULL");
    else conditions.push("n.deleted_at IS NULL");
    if (view === "inbox") conditions.push("b.is_system = 1");
    if (view === "favorites") conditions.push("n.is_favorite = 1");
    if (view === "shared") {
      conditions.push("EXISTS (SELECT 1 FROM shares s WHERE s.note_id = n.id AND s.revoked_at IS NULL AND s.expires_at > ?)");
      params.push(now());
    }
    if (notebookId) {
      conditions.push("n.notebook_id = ?");
      params.push(notebookId);
    }
    if (query) {
      if (/[\u3400-\u9fff]/u.test(query)) {
        conditions.push("(n.title LIKE ? OR n.content_markdown LIKE ?)");
        params.push(`%${query}%`, `%${query}%`);
      } else {
        const ftsQuery = buildFtsQuery(query);
        // Without any searchable term the query must match nothing, not fall back to listing every note.
        if (!ftsQuery) return json({ notes: [], total: 0 });
        from += " JOIN notes_fts ON notes_fts.note_id = n.id";
        conditions.push("notes_fts MATCH ?");
        params.push(ftsQuery);
      }
    }
    const where = conditions.join(" AND ");
    const totalRow = first<{ count: number }>(database, `SELECT COUNT(*) AS count FROM ${from} WHERE ${where}`, ...params);
    const rows = all<NoteRow>(database, `
      SELECT n.id, n.title, n.content_markdown, n.notebook_id, b.name AS notebook_name,
        b.color AS notebook_color, n.is_favorite, n.deleted_at, n.version, n.created_at, n.updated_at
      FROM ${from} WHERE ${where} ORDER BY n.updated_at DESC LIMIT ${NOTE_PAGE_SIZE}
    `, ...params);
    return json({ notes: rows.map(toNote), total: Number(totalRow?.count ?? 0) });
  }

  if (resource === "notes" && !id && method === "POST") {
    const payload = await readJson<{ title?: unknown; contentMarkdown?: unknown; notebookId?: unknown }>(request);
    const title = payload?.title === undefined ? "未命名笔记" : payload.title;
    const contentMarkdown = payload?.contentMarkdown === undefined ? "" : payload.contentMarkdown;
    if (!validText(title, 200) || !validText(contentMarkdown, 1_000_000)) return jsonError(413, "NOTE_TOO_LARGE", "笔记标题或正文超出长度限制");
    const notebookId = typeof payload?.notebookId === "string" ? payload.notebookId : first<{ id: string }>(database, "SELECT id FROM notebooks WHERE user_id = ? AND is_system = 1 LIMIT 1", user.id)?.id;
    if (!notebookId) return jsonError(400, "NO_NOTEBOOK", "没有可用的收件箱");
    if (!first(database, "SELECT id FROM notebooks WHERE id = ? AND user_id = ?", notebookId, user.id)) return jsonError(400, "INVALID_NOTEBOOK", "笔记本不存在");
    const noteId = createNote(database, user.id, notebookId, title, contentMarkdown);
    const note = getNote(database, user.id, noteId);
    return json({ note: note ? toFullNote(note) : null }, 201);
  }

  if (resource === "notes" && id && subresource === "shares" && (method === "GET" || method === "POST")) {
    const note = getNote(database, user.id, id);
    if (!note) return jsonError(404, "NOTE_NOT_FOUND", "笔记不存在");
    if (method === "GET") {
      const rows = all<{ id: string; note_id: string; created_at: number; expires_at: number; revoked_at: number | null }>(database, "SELECT id, note_id, created_at, expires_at, revoked_at FROM shares WHERE note_id = ? AND user_id = ? ORDER BY created_at DESC", note.id, user.id);
      return json({ shares: rows.map(toShare) });
    }
    const createdAt = now();
    const expiresAt = createdAt + SHARE_TTL;
    const shareId = crypto.randomUUID();
    const token = createOpaqueToken();
    const tokenHash = await digestHex(token);
    const transaction = database.transaction(() => {
      database.query("INSERT INTO shares (id, note_id, user_id, token_hash, created_at, expires_at, snapshot_title, snapshot_content_markdown) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(shareId, note.id, user.id, tokenHash, createdAt, expiresAt, note.title, note.content_markdown);
    });
    transaction();
    const share: Share = { id: shareId, noteId: note.id, expiresAt, revokedAt: null, createdAt, url: `${getPublicOrigin(url, environment)}/share/${token}` };
    return json({ share }, 201);
  }

  if (resource === "notes" && id && method === "GET") {
    const note = getNote(database, user.id, id);
    return note ? json({ note: toFullNote(note) }) : jsonError(404, "NOTE_NOT_FOUND", "笔记不存在");
  }

  if (resource === "notes" && id && method === "PATCH") {
    const current = getNote(database, user.id, id);
    if (!current) return jsonError(404, "NOTE_NOT_FOUND", "笔记不存在");
    const payload = await readJson<{ version?: unknown; title?: unknown; contentMarkdown?: unknown; notebookId?: unknown; isFavorite?: unknown; deleted?: unknown }>(request);
    if (!payload || !Number.isInteger(payload.version)) return jsonError(400, "VERSION_REQUIRED", "保存笔记必须携带版本号");
    if (payload.version !== current.version) return json({ error: { code: "VERSION_CONFLICT", message: "这篇笔记已在别处更新", current: toFullNote(current) } }, 409);
    const title = payload.title === undefined ? current.title : payload.title;
    const contentMarkdown = payload.contentMarkdown === undefined ? current.content_markdown : payload.contentMarkdown;
    const notebookId = payload.notebookId === undefined ? current.notebook_id : payload.notebookId;
    const isFavorite = payload.isFavorite === undefined ? current.is_favorite : payload.isFavorite ? 1 : 0;
    const deletedAt = payload.deleted === undefined ? current.deleted_at : payload.deleted ? now() : null;
    if (!validText(title, 200) || !validText(contentMarkdown, 1_000_000) || typeof notebookId !== "string") return jsonError(413, "NOTE_TOO_LARGE", "笔记标题或正文超出长度限制");
    if (!first(database, "SELECT id FROM notebooks WHERE id = ? AND user_id = ?", notebookId, user.id)) return jsonError(400, "INVALID_NOTEBOOK", "笔记本不存在");
    if (!updateNote(database, current, user.id, title, contentMarkdown, notebookId, isFavorite, deletedAt)) {
      const latest = getNote(database, user.id, current.id);
      return json({ error: { code: "VERSION_CONFLICT", message: "这篇笔记已在别处更新", current: latest ? toFullNote(latest) : null } }, 409);
    }
    const note = getNote(database, user.id, current.id);
    return json({ note: note ? toFullNote(note) : null });
  }

  if (resource === "notes" && id && method === "DELETE") {
    const note = getNote(database, user.id, id);
    if (!note) return jsonError(404, "NOTE_NOT_FOUND", "笔记不存在");
    if (!note.deleted_at) return jsonError(400, "NOTE_NOT_TRASHED", "只能永久删除回收站中的笔记");
    const transaction = database.transaction(() => {
      database.query("DELETE FROM notes_fts WHERE note_id = ?").run(note.id);
      database.query("DELETE FROM notes WHERE id = ? AND user_id = ?").run(note.id, user.id);
    });
    transaction();
    return json({ ok: true });
  }

  if (resource === "notebooks" && !id && method === "GET") {
    const rows = all<{ id: string; name: string; color: string; is_system: number; count: number }>(database, `
      SELECT b.id, b.name, b.color, b.is_system,
        (SELECT COUNT(*) FROM notes n WHERE n.notebook_id = b.id AND n.deleted_at IS NULL) AS count
      FROM notebooks b WHERE b.user_id = ? ORDER BY b.sort_order, b.name
    `, user.id);
    return json({ notebooks: rows.map((row) => ({ id: row.id, name: row.name, color: row.color, isSystem: Boolean(row.is_system), count: Number(row.count) })) });
  }

  if (resource === "notebooks" && !id && method === "POST") {
    const payload = await readJson<{ name?: unknown; color?: unknown }>(request);
    if (!payload || !validText(payload.name, 40) || !payload.name.trim()) return jsonError(400, "INVALID_NOTEBOOK", "请输入笔记本名称");
    const notebookId = crypto.randomUUID();
    const createdAt = now();
    const color = payload.color === undefined ? "#718077" : payload.color;
    if (!validColor(color)) return jsonError(400, "INVALID_NOTEBOOK", "请输入有效的六位十六进制颜色");
    try {
      database.query("INSERT INTO notebooks (id, user_id, name, color, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, 10, ?, ?)").run(notebookId, user.id, payload.name.trim(), color, createdAt, createdAt);
    } catch {
      return jsonError(409, "NOTEBOOK_EXISTS", "已经有同名笔记本");
    }
    return json({ notebook: { id: notebookId, name: payload.name.trim(), color, isSystem: false, count: 0 } }, 201);
  }

  if (resource === "notebooks" && id && method === "PATCH") {
    const current = first<{ id: string; name: string; color: string; is_system: number }>(database, "SELECT id, name, color, is_system FROM notebooks WHERE id = ? AND user_id = ?", id, user.id);
    if (!current) return jsonError(404, "NOTEBOOK_NOT_FOUND", "笔记本不存在");
    const payload = await readJson<{ name?: unknown; color?: unknown }>(request);
    const name = payload?.name === undefined ? current.name : payload.name;
    const color = payload?.color === undefined ? current.color : payload.color;
    if (!validText(name, 40) || !name.trim() || !validColor(color)) return jsonError(400, "INVALID_NOTEBOOK", "笔记本名称或颜色无效");
    try {
      database.query("UPDATE notebooks SET name = ?, color = ?, updated_at = ? WHERE id = ? AND user_id = ?").run(name.trim(), color, now(), current.id, user.id);
    } catch {
      return jsonError(409, "NOTEBOOK_EXISTS", "已经有同名笔记本");
    }
    return json({ notebook: { id: current.id, name: name.trim(), color, isSystem: Boolean(current.is_system), count: Number(first<{ count: number }>(database, "SELECT COUNT(*) AS count FROM notes WHERE notebook_id = ? AND deleted_at IS NULL", current.id)?.count ?? 0) } });
  }

  if (resource === "notebooks" && id && method === "DELETE") {
    const current = first<{ id: string; is_system: number }>(database, "SELECT id, is_system FROM notebooks WHERE id = ? AND user_id = ?", id, user.id);
    if (!current) return jsonError(404, "NOTEBOOK_NOT_FOUND", "笔记本不存在");
    if (current.is_system) return jsonError(400, "SYSTEM_NOTEBOOK", "收件箱不能删除");
    const inbox = first<{ id: string }>(database, "SELECT id FROM notebooks WHERE user_id = ? AND is_system = 1 LIMIT 1", user.id);
    if (!inbox) return jsonError(500, "NO_INBOX", "找不到收件箱");
    const transaction = database.transaction(() => {
      database.query("UPDATE notes SET notebook_id = ?, updated_at = ? WHERE notebook_id = ? AND user_id = ?").run(inbox.id, now(), current.id, user.id);
      database.query("DELETE FROM notebooks WHERE id = ? AND user_id = ?").run(current.id, user.id);
    });
    transaction();
    return json({ ok: true });
  }

  if (resource === "shares" && id && method === "DELETE") {
    const result = database.query("UPDATE shares SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL").run(now(), id, user.id);
    return result.changes ? json({ ok: true }) : jsonError(404, "SHARE_NOT_FOUND", "分享链接不存在");
  }

  return jsonError(404, "NOT_FOUND", "接口不存在");
}

async function handlePublicShare(request: Request, database: SqliteDatabase) {
  const token = new URL(request.url).pathname.split("/").filter(Boolean)[2] ?? "";
  const row = first<ShareRow>(database, "SELECT id, note_id, created_at, expires_at, revoked_at, snapshot_title, snapshot_content_markdown FROM shares WHERE token_hash = ?", await digestHex(token));
  if (!row) return jsonError(404, "SHARE_NOT_FOUND", "分享链接不存在");
  if (row.revoked_at) return jsonError(410, "SHARE_REVOKED", "分享链接已撤销");
  if (row.expires_at <= now()) return jsonError(410, "SHARE_EXPIRED", "分享链接已过期");
  const snapshot: ShareSnapshot = { schemaVersion: 1, title: row.snapshot_title, contentMarkdown: row.snapshot_content_markdown, createdAt: row.created_at, expiresAt: row.expires_at };
  return json({ snapshot });
}

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
};

async function serveStatic(request: Request, clientRoot: string) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  const url = new URL(request.url);
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return new Response("Bad Request", { status: 400 });
  }
  if (pathname.includes("\0") || pathname.split(/[\\/]/).includes("..")) return new Response("Forbidden", { status: 403 });

  const relativePath = pathname.replace(/^[/\\]+/, "");
  const hasExtension = extname(relativePath) !== "";
  const rootPath = resolve(clientRoot);
  const requestedPath = hasExtension ? resolve(rootPath, relativePath) : join(rootPath, "index.html");
  const pathFromRoot = relative(rootPath, requestedPath);
  if (isAbsolute(pathFromRoot) || pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || pathFromRoot.startsWith(sep)) return new Response("Forbidden", { status: 403 });
  const file = Bun.file(requestedPath);
  if (!(await file.exists())) return new Response("Not Found", { status: 404 });

  const headers = new Headers();
  headers.set("Content-Type", MIME_TYPES[extname(requestedPath).toLowerCase()] ?? file.type ?? "application/octet-stream");
  headers.set("Cache-Control", hasExtension && relativePath !== "index.html" ? "public, max-age=31536000, immutable" : "no-cache");
  return new Response(request.method === "HEAD" ? null : file, { headers });
}

export async function handleRequest(request: Request, options: ServerOptions) {
  try {
    const url = new URL(request.url);
    if (url.pathname === "/api/shares/" || url.pathname.startsWith("/api/shares/")) {
      const segments = url.pathname.split("/").filter(Boolean);
      if (request.method === "GET" && segments.length === 3) return await handlePublicShare(request, options.database);
    }
    if (url.pathname.startsWith("/api/")) return await handleApi(request, options);
    return await serveStatic(request, options.clientRoot ?? DEFAULT_CLIENT_ROOT);
  } catch (error) {
    const url = new URL(request.url);
    console.error(`[request] ${request.method} ${url.pathname}`, error);
    if (url.pathname.startsWith("/api/")) return jsonError(500, "INTERNAL_ERROR", "服务器暂时无法处理请求");
    return new Response("Internal Server Error", { status: 500 });
  }
}

if (import.meta.main) {
  const database = await openDatabase();
  const port = Number.parseInt(Bun.env.PORT ?? "3000", 10) || 3000;
  const hostname = Bun.env.HOST?.trim() || "0.0.0.0";
  const server = Bun.serve({
    hostname,
    port,
    fetch(request) {
      return handleRequest(request, { database, environment: Bun.env });
    },
    error(error) {
      console.error("[server] uncaught error", error);
      return jsonError(500, "INTERNAL_ERROR", "服务器暂时无法处理请求");
    },
  });
  console.log(`象映笔记服务已启动：${server.url}`);
}
