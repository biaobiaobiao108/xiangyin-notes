import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ShareSnapshot, Note, NoteSummary, NoteView, Share, Notebook } from "../shared/types";
import type { SyncChange, SyncMutation, SyncPullResponse, SyncPushResult, SyncPushResponse } from "../shared/sync";
import { openDatabase, type SqliteDatabase } from "./db";

const SESSION_COOKIE = "xiangying_session";
const SESSION_TTL = 60 * 60 * 24 * 30;
const SHARE_TTL = 60 * 60 * 24 * 7;
const PASSWORD_ITERATIONS = 100_000;
const NOTE_PAGE_SIZE = 100;
const NOTE_PREVIEW_LIMIT = 180;
const NOTE_PREVIEW_SCAN_LIMIT = NOTE_PREVIEW_LIMIT + 64;
const NOTE_VIEWS: NoteView[] = ["all", "inbox", "favorites", "shared", "trash"];
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

type NotebookRow = {
  id: string;
  name: string;
  color: string;
  is_system: number;
  count: number;
  updated_at: number;
};

type SyncChangeRow = {
  sequence: number;
  entity_type: "note" | "notebook";
  entity_id: string;
  operation: "upsert" | "delete";
  payload_json: string | null;
};

type AuthCredentials = {
  username: string;
  password: string;
};

const welcomeMarkdown = "## 欢迎来到象映笔记\n\n这是你的第一个笔记。按下 **Ctrl /** 可以打开命令菜单，开始记录你的想法。\n\n- 写下值得保留的东西\n- 用笔记本整理上下文\n- 随时生成一个 7 天有效的只读分享\n";
const PREVIEW_SYNTAX = new Set(["#", ">", "*", "_", "`", "~", "-", "[", "]", "(", ")"]);

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

/** A title made of nothing but whitespace is stored as empty so the client can show its placeholder. */
function normalizeNoteTitle(value: string) {
  return value.trim() === "" ? "" : value;
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
  responseHeaders.set("Cache-Control", "no-store");
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

function toNotebook(row: NotebookRow): Notebook {
  return { id: row.id, name: row.name, color: row.color, isSystem: Boolean(row.is_system), count: Number(row.count), updatedAt: row.updated_at };
}

function getNotebook(database: SqliteDatabase, userId: string, notebookId: string) {
  return first<NotebookRow>(database, `
    SELECT b.id, b.name, b.color, b.is_system, b.updated_at,
      (SELECT COUNT(*) FROM notes n WHERE n.notebook_id = b.id AND n.deleted_at IS NULL) AS count
    FROM notebooks b WHERE b.id = ? AND b.user_id = ?
  `, notebookId, userId);
}

function recordSyncChange(database: SqliteDatabase, userId: string, entityType: "note" | "notebook", entityId: string, operation: "upsert" | "delete", payload: Note | Notebook | null) {
  database.query("INSERT INTO sync_changes (user_id, entity_type, entity_id, operation, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(userId, entityType, entityId, operation, payload ? JSON.stringify(payload) : null, now());
}

function hasSyncTombstone(database: SqliteDatabase, userId: string, entityType: "note" | "notebook", entityId: string) {
  return Boolean(first<{ entity_id: string }>(database, "SELECT entity_id FROM sync_changes WHERE user_id = ? AND entity_type = ? AND entity_id = ? AND operation = 'delete' LIMIT 1", userId, entityType, entityId));
}

export function formatPreview(markdown: string) {
  const output: string[] = [];
  let outputLength = 0;
  let pendingWhitespace = false;

  for (let index = 0; index < markdown.length && outputLength < NOTE_PREVIEW_SCAN_LIMIT; index += 1) {
    if (markdown.startsWith("```", index)) {
      const closingFence = markdown.indexOf("```", index + 3);
      if (closingFence !== -1) {
        index = closingFence + 2;
        pendingWhitespace = true;
        continue;
      }
    }

    const character = markdown[index];
    if (/\s/u.test(character) || PREVIEW_SYNTAX.has(character)) {
      pendingWhitespace = true;
      continue;
    }

    if (pendingWhitespace && output.length > 0) {
      output.push(" ");
      outputLength += 1;
    }
    output.push(character);
    outputLength += character.length;
    pendingWhitespace = false;
  }

  return output.join("")
    .trim()
    .replace(/\s+([,.;!?。！？、，；：])/g, "$1")
    .slice(0, NOTE_PREVIEW_LIMIT);
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
      const notebook = getNotebook(database, userId, inboxId);
      const note = getNote(database, userId, noteId);
      if (notebook) recordSyncChange(database, userId, "notebook", notebook.id, "upsert", toNotebook(notebook));
      if (note) recordSyncChange(database, userId, "note", note.id, "upsert", toFullNote(note));
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

function createNote(database: SqliteDatabase, userId: string, notebookId: string, title: string, contentMarkdown: string, requestedId?: string) {
  const id = requestedId ?? crypto.randomUUID();
  const createdAt = now();
  const transaction = database.transaction(() => {
    database.query("INSERT INTO notes (id, user_id, notebook_id, title, content_markdown, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)").run(id, userId, notebookId, title, contentMarkdown, createdAt, createdAt);
    database.query("INSERT INTO notes_fts (note_id, title, content) VALUES (?, ?, ?)").run(id, title, contentMarkdown);
    const note = getNote(database, userId, id);
    if (note) recordSyncChange(database, userId, "note", id, "upsert", toFullNote(note));
  });
  transaction();
  return id;
}

function updateNoteInTransaction(
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
  const result = database.query("UPDATE notes SET title = ?, content_markdown = ?, notebook_id = ?, is_favorite = ?, deleted_at = ?, version = version + 1, updated_at = ? WHERE id = ? AND user_id = ? AND version = ?").run(title, contentMarkdown, notebookId, isFavorite, deletedAt, updatedAt, current.id, userId, current.version);
  if (result.changes !== 1) return false;
  database.query("DELETE FROM notes_fts WHERE note_id = ?").run(current.id);
  database.query("INSERT INTO notes_fts (note_id, title, content) VALUES (?, ?, ?)").run(current.id, title, contentMarkdown);
  const next = getNote(database, userId, current.id);
  if (next) recordSyncChange(database, userId, "note", current.id, "upsert", toFullNote(next));
  return true;
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
  return database.transaction(() => updateNoteInTransaction(database, current, userId, title, contentMarkdown, notebookId, isFavorite, deletedAt))();
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

  if (method === "GET" && url.pathname === "/api/sync/pull") return await handleSyncPull(request, database, user);
  if (method === "POST" && url.pathname === "/api/sync/push") return await handleSyncPush(request, database, user);

  if (method === "DELETE" && url.pathname === "/api/trash") {
    const emptyTrash = database.transaction(() => {
      const deletedIds = all<{ id: string }>(database, "SELECT id FROM notes WHERE user_id = ? AND deleted_at IS NOT NULL", user.id).map((note) => note.id);
      database.query("DELETE FROM notes_fts WHERE note_id IN (SELECT id FROM notes WHERE user_id = ? AND deleted_at IS NOT NULL)").run(user.id);
      database.query("DELETE FROM notes WHERE user_id = ? AND deleted_at IS NOT NULL").run(user.id);
      for (const id of deletedIds) recordSyncChange(database, user.id, "note", id, "delete", null);
      return { ok: true, deletedCount: deletedIds.length, deletedIds };
    });
    return json(emptyTrash());
  }

  if (resource === "notes" && !id && method === "GET") {
    const view = url.searchParams.get("view") ?? "all";
    if (!NOTE_VIEWS.includes(view as NoteView)) return jsonError(400, "INVALID_VIEW", "不支持的笔记视图");
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
    const listStatement = database.query(`
      SELECT n.id, n.title, n.content_markdown, n.notebook_id, b.name AS notebook_name,
        b.color AS notebook_color, n.is_favorite, n.deleted_at, n.version, n.created_at, n.updated_at
      FROM ${from} WHERE ${where} ORDER BY n.updated_at DESC LIMIT ${NOTE_PAGE_SIZE}
    `);
    const notes: NoteSummary[] = [];
    for (const row of listStatement.iterate(...params) as Iterable<NoteRow>) notes.push(toNote(row));
    return json({ notes, total: Number(totalRow?.count ?? 0) });
  }

  if (resource === "notes" && !id && method === "POST") {
    const payload = await readJson<{ id?: unknown; title?: unknown; contentMarkdown?: unknown; notebookId?: unknown }>(request);
    const rawTitle = payload?.title === undefined ? "未命名笔记" : payload.title;
    const contentMarkdown = payload?.contentMarkdown === undefined ? "" : payload.contentMarkdown;
    if (!validText(rawTitle, 200) || !validText(contentMarkdown, 1_000_000)) return jsonError(413, "NOTE_TOO_LARGE", "笔记标题或正文超出长度限制");
    const title = normalizeNoteTitle(rawTitle);
    const notebookId = typeof payload?.notebookId === "string" ? payload.notebookId : first<{ id: string }>(database, "SELECT id FROM notebooks WHERE user_id = ? AND is_system = 1 LIMIT 1", user.id)?.id;
    if (!notebookId) return jsonError(400, "NO_NOTEBOOK", "没有可用的收件箱");
    if (!first(database, "SELECT id FROM notebooks WHERE id = ? AND user_id = ?", notebookId, user.id)) return jsonError(400, "INVALID_NOTEBOOK", "笔记本不存在");
    const noteId = createNote(database, user.id, notebookId, title, contentMarkdown, typeof payload?.id === "string" ? payload.id : undefined);
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
    const rawTitle = payload.title === undefined ? current.title : payload.title;
    const contentMarkdown = payload.contentMarkdown === undefined ? current.content_markdown : payload.contentMarkdown;
    const notebookId = payload.notebookId === undefined ? current.notebook_id : payload.notebookId;
    const isFavorite = payload.isFavorite === undefined ? current.is_favorite : payload.isFavorite ? 1 : 0;
    const deletedAt = payload.deleted === undefined ? current.deleted_at : payload.deleted ? now() : null;
    if (!validText(rawTitle, 200) || !validText(contentMarkdown, 1_000_000) || typeof notebookId !== "string") return jsonError(413, "NOTE_TOO_LARGE", "笔记标题或正文超出长度限制");
    const title = normalizeNoteTitle(rawTitle);
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
      recordSyncChange(database, user.id, "note", note.id, "delete", null);
    });
    transaction();
    return json({ ok: true });
  }

  if (resource === "notebooks" && !id && method === "GET") {
    const rows = all<NotebookRow>(database, `
      SELECT b.id, b.name, b.color, b.is_system, b.updated_at,
        (SELECT COUNT(*) FROM notes n WHERE n.notebook_id = b.id AND n.deleted_at IS NULL) AS count
      FROM notebooks b WHERE b.user_id = ? ORDER BY b.sort_order, b.name
    `, user.id);
    return json({ notebooks: rows.map(toNotebook) });
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
      const created = getNotebook(database, user.id, notebookId);
      if (created) recordSyncChange(database, user.id, "notebook", notebookId, "upsert", toNotebook(created));
    } catch {
      return jsonError(409, "NOTEBOOK_EXISTS", "已经有同名笔记本");
    }
    const created = getNotebook(database, user.id, notebookId);
    return json({ notebook: created ? toNotebook(created) : null }, 201);
  }

  if (resource === "notebooks" && id && method === "PATCH") {
    const current = getNotebook(database, user.id, id);
    if (!current) return jsonError(404, "NOTEBOOK_NOT_FOUND", "笔记本不存在");
    const payload = await readJson<{ name?: unknown; color?: unknown }>(request);
    const name = payload?.name === undefined ? current.name : payload.name;
    const color = payload?.color === undefined ? current.color : payload.color;
    if (!validText(name, 40) || !name.trim() || !validColor(color)) return jsonError(400, "INVALID_NOTEBOOK", "笔记本名称或颜色无效");
    try {
      database.query("UPDATE notebooks SET name = ?, color = ?, updated_at = ? WHERE id = ? AND user_id = ?").run(name.trim(), color, now(), current.id, user.id);
      const updated = getNotebook(database, user.id, current.id);
      if (updated) recordSyncChange(database, user.id, "notebook", current.id, "upsert", toNotebook(updated));
    } catch {
      return jsonError(409, "NOTEBOOK_EXISTS", "已经有同名笔记本");
    }
    const updated = getNotebook(database, user.id, current.id);
    return json({ notebook: updated ? toNotebook(updated) : null });
  }

  if (resource === "notebooks" && id && method === "DELETE") {
    const current = first<{ id: string; is_system: number }>(database, "SELECT id, is_system FROM notebooks WHERE id = ? AND user_id = ?", id, user.id);
    if (!current) return jsonError(404, "NOTEBOOK_NOT_FOUND", "笔记本不存在");
    if (current.is_system) return jsonError(400, "SYSTEM_NOTEBOOK", "收件箱不能删除");
    const inbox = first<{ id: string }>(database, "SELECT id FROM notebooks WHERE user_id = ? AND is_system = 1 LIMIT 1", user.id);
    if (!inbox) return jsonError(500, "NO_INBOX", "找不到收件箱");
    const transaction = database.transaction(() => {
      const movedNotes = all<{ id: string }>(database, "SELECT id FROM notes WHERE notebook_id = ? AND user_id = ?", current.id, user.id);
      for (const note of movedNotes) {
        database.query("UPDATE notes SET notebook_id = ?, version = version + 1, updated_at = ? WHERE id = ? AND user_id = ?").run(inbox.id, now(), note.id, user.id);
        const moved = getNote(database, user.id, note.id);
        if (moved) recordSyncChange(database, user.id, "note", note.id, "upsert", toFullNote(moved));
      }
      database.query("DELETE FROM notebooks WHERE id = ? AND user_id = ?").run(current.id, user.id);
      recordSyncChange(database, user.id, "notebook", current.id, "delete", null);
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

function decodeSyncChange(row: SyncChangeRow): SyncChange {
  let payload: SyncChange["payload"] = null;
  if (row.payload_json) {
    try { payload = JSON.parse(row.payload_json) as SyncChange["payload"]; } catch { payload = null; }
  }
  return { sequence: Number(row.sequence), entity: row.entity_type, entityId: row.entity_id, operation: row.operation, payload };
}

async function handleSyncPull(request: Request, database: SqliteDatabase, user: UserRow) {
  const url = new URL(request.url);
  const cursor = Number.parseInt(url.searchParams.get("cursor") ?? "0", 10);
  const limit = Math.min(250, Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "100", 10) || 100));
  if (!Number.isInteger(cursor) || cursor < 0) return jsonError(400, "INVALID_SYNC_CURSOR", "同步游标无效");

  if (cursor === 0) {
    const offset = Math.max(0, Number.parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);
    const snapshotCursorParam = Number.parseInt(url.searchParams.get("snapshotCursor") ?? "", 10);
    const snapshotCursor = Number.isInteger(snapshotCursorParam) && snapshotCursorParam >= 0
      ? snapshotCursorParam
      : Number(first<{ sequence: number }>(database, "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM sync_changes WHERE user_id = ?", user.id)?.sequence ?? 0);
    const noteRows = all<NoteRow>(database, `
      SELECT n.id, n.title, n.content_markdown, n.notebook_id, b.name AS notebook_name,
        b.color AS notebook_color, n.is_favorite, n.deleted_at, n.version, n.created_at, n.updated_at
      FROM notes n JOIN notebooks b ON b.id = n.notebook_id
      WHERE n.user_id = ? ORDER BY n.updated_at DESC, n.id LIMIT ? OFFSET ?
    `, user.id, limit, offset);
    const total = Number(first<{ count: number }>(database, "SELECT COUNT(*) AS count FROM notes WHERE user_id = ?", user.id)?.count ?? 0);
    const notebooks = offset === 0
      ? all<NotebookRow>(database, `
          SELECT b.id, b.name, b.color, b.is_system, b.updated_at,
            (SELECT COUNT(*) FROM notes n WHERE n.notebook_id = b.id AND n.deleted_at IS NULL) AS count
          FROM notebooks b WHERE b.user_id = ? ORDER BY b.sort_order, b.name
        `, user.id).map(toNotebook)
      : [];
    const body: SyncPullResponse = {
      mode: "snapshot",
      cursor: 0,
      snapshotCursor,
      offset,
      hasMore: offset + noteRows.length < total,
      notes: noteRows.map(toFullNote),
      notebooks,
      changes: [],
    };
    return json(body);
  }

  const rows = all<SyncChangeRow>(database, `
    SELECT sequence, entity_type, entity_id, operation, payload_json
    FROM sync_changes WHERE user_id = ? AND sequence > ? ORDER BY sequence LIMIT ?
  `, user.id, cursor, limit);
  const changes = rows.map(decodeSyncChange);
  const nextCursor = changes.at(-1)?.sequence ?? cursor;
  const body: SyncPullResponse = {
    mode: "changes",
    cursor: nextCursor,
    hasMore: rows.length === limit,
    notes: [],
    notebooks: [],
    changes,
  };
  return json(body);
}

function validSyncMutation(value: unknown): value is SyncMutation {
  if (!value || typeof value !== "object") return false;
  const mutation = value as Partial<SyncMutation>;
  return typeof mutation.operationId === "string" && mutation.operationId.length >= 8 && mutation.operationId.length <= 120
    && (mutation.entity === "note" || mutation.entity === "notebook")
    && (mutation.action === "upsert" || mutation.action === "delete")
    && typeof mutation.entityId === "string" && mutation.entityId.length >= 8 && mutation.entityId.length <= 120;
}

function applySyncMutation(database: SqliteDatabase, user: UserRow, mutation: SyncMutation): SyncPushResult {
  const cached = first<{ result_json: string }>(database, "SELECT result_json FROM sync_mutations WHERE user_id = ? AND operation_id = ?", user.id, mutation.operationId);
  if (cached) return JSON.parse(cached.result_json) as SyncPushResult;

  const result = database.transaction(() => {
    let response: SyncPushResult;

    if (mutation.entity === "note") {
      const payload = mutation.note;
      const current = getNote(database, user.id, mutation.entityId);
      if (mutation.action === "upsert") {
        if (!payload || !validText(payload.title, 200) || !validText(payload.contentMarkdown, 1_000_000) || typeof payload.notebookId !== "string" || typeof payload.isFavorite !== "boolean" || (payload.deletedAt !== null && !Number.isInteger(payload.deletedAt))) {
          response = { operationId: mutation.operationId, status: "rejected", message: "笔记数据无效" };
        } else if (!first(database, "SELECT id FROM notebooks WHERE id = ? AND user_id = ?", payload.notebookId, user.id)) {
          response = { operationId: mutation.operationId, status: "rejected", message: "笔记本不存在" };
        } else if (current && mutation.baseVersion !== current.version) {
          response = { operationId: mutation.operationId, status: "conflict", current: toFullNote(current), message: "服务器上的笔记已更新" };
        } else if (current) {
          const updated = updateNoteInTransaction(database, current, user.id, normalizeNoteTitle(payload.title), payload.contentMarkdown, payload.notebookId, payload.isFavorite ? 1 : 0, payload.deletedAt);
          const next = getNote(database, user.id, mutation.entityId);
          response = updated && next ? { operationId: mutation.operationId, status: "applied", note: toFullNote(next) } : { operationId: mutation.operationId, status: "conflict", current: next ? toFullNote(next) : null, message: "笔记更新失败" };
        } else if (hasSyncTombstone(database, user.id, "note", mutation.entityId)) {
          response = { operationId: mutation.operationId, status: "rejected", message: "笔记已永久删除，不能重新创建" };
        } else {
          try {
            const createdAt = now();
            database.query("INSERT INTO notes (id, user_id, notebook_id, title, content_markdown, is_favorite, deleted_at, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)").run(mutation.entityId, user.id, payload.notebookId, normalizeNoteTitle(payload.title), payload.contentMarkdown, payload.isFavorite ? 1 : 0, payload.deletedAt, createdAt, createdAt);
            database.query("INSERT INTO notes_fts (note_id, title, content) VALUES (?, ?, ?)").run(mutation.entityId, normalizeNoteTitle(payload.title), payload.contentMarkdown);
            const created = getNote(database, user.id, mutation.entityId);
            if (!created) throw new Error("note-create-missing");
            recordSyncChange(database, user.id, "note", mutation.entityId, "upsert", toFullNote(created));
            response = { operationId: mutation.operationId, status: "applied", note: toFullNote(created) };
          } catch {
            response = { operationId: mutation.operationId, status: "rejected", message: "笔记创建失败" };
          }
        }
      } else if (!current) {
        response = { operationId: mutation.operationId, status: "applied", current: null };
      } else if (mutation.baseVersion !== current.version) {
        response = { operationId: mutation.operationId, status: "conflict", current: toFullNote(current), message: "服务器上的笔记已更新" };
      } else if (!current.deleted_at) {
        response = { operationId: mutation.operationId, status: "rejected", message: "只能永久删除回收站中的笔记" };
      } else {
        database.query("DELETE FROM notes_fts WHERE note_id = ?").run(current.id);
        database.query("DELETE FROM notes WHERE id = ? AND user_id = ?").run(current.id, user.id);
        recordSyncChange(database, user.id, "note", current.id, "delete", null);
        response = { operationId: mutation.operationId, status: "applied", current: null };
      }
    } else {
      const payload = mutation.notebook;
      const current = getNotebook(database, user.id, mutation.entityId);
      if (mutation.action === "upsert") {
        if (!payload || !validText(payload.name, 40) || !payload.name.trim() || !validColor(payload.color)) {
          response = { operationId: mutation.operationId, status: "rejected", message: "笔记本数据无效" };
        } else if (current && mutation.baseUpdatedAt !== current.updated_at) {
          response = { operationId: mutation.operationId, status: "conflict", current: toNotebook(current), message: "服务器上的笔记本已更新" };
        } else if (current) {
          try {
            database.query("UPDATE notebooks SET name = ?, color = ?, updated_at = ? WHERE id = ? AND user_id = ?").run(payload.name.trim(), payload.color, now(), current.id, user.id);
            const next = getNotebook(database, user.id, current.id);
            if (!next) throw new Error("notebook-update-missing");
            recordSyncChange(database, user.id, "notebook", current.id, "upsert", toNotebook(next));
            response = { operationId: mutation.operationId, status: "applied", notebook: toNotebook(next) };
          } catch {
            response = { operationId: mutation.operationId, status: "rejected", message: "笔记本名称已经存在" };
          }
        } else if (hasSyncTombstone(database, user.id, "notebook", mutation.entityId)) {
          response = { operationId: mutation.operationId, status: "rejected", message: "笔记本已删除，不能重新创建" };
        } else {
          const createdAt = now();
          try {
            database.query("INSERT INTO notebooks (id, user_id, name, color, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, 10, ?, ?)").run(mutation.entityId, user.id, payload.name.trim(), payload.color, createdAt, createdAt);
            const created = getNotebook(database, user.id, mutation.entityId);
            if (!created) throw new Error("notebook-create-missing");
            recordSyncChange(database, user.id, "notebook", mutation.entityId, "upsert", toNotebook(created));
            response = { operationId: mutation.operationId, status: "applied", notebook: toNotebook(created) };
          } catch {
            response = { operationId: mutation.operationId, status: "rejected", message: "笔记本名称已经存在" };
          }
        }
      } else if (!current) {
        response = { operationId: mutation.operationId, status: "applied", current: null };
      } else if (mutation.baseUpdatedAt !== current.updated_at) {
        response = { operationId: mutation.operationId, status: "conflict", current: toNotebook(current), message: "服务器上的笔记本已更新" };
      } else if (current.is_system) {
        response = { operationId: mutation.operationId, status: "rejected", message: "收件箱不能删除" };
      } else {
        const inbox = first<{ id: string }>(database, "SELECT id FROM notebooks WHERE user_id = ? AND is_system = 1 LIMIT 1", user.id);
        if (!inbox) {
          response = { operationId: mutation.operationId, status: "rejected", message: "找不到收件箱" };
        } else {
          const movedNotes = all<{ id: string }>(database, "SELECT id FROM notes WHERE notebook_id = ? AND user_id = ?", current.id, user.id);
          for (const note of movedNotes) {
            const existing = getNote(database, user.id, note.id);
            if (!existing) continue;
            database.query("UPDATE notes SET notebook_id = ?, version = version + 1, updated_at = ? WHERE id = ? AND user_id = ?").run(inbox.id, now(), note.id, user.id);
            const moved = getNote(database, user.id, note.id);
            if (moved) recordSyncChange(database, user.id, "note", note.id, "upsert", toFullNote(moved));
          }
          database.query("DELETE FROM notebooks WHERE id = ? AND user_id = ?").run(current.id, user.id);
          recordSyncChange(database, user.id, "notebook", current.id, "delete", null);
          response = { operationId: mutation.operationId, status: "applied", current: null };
        }
      }
    }

    database.query("INSERT INTO sync_mutations (user_id, operation_id, result_json, created_at) VALUES (?, ?, ?, ?)").run(user.id, mutation.operationId, JSON.stringify(response), now());
    return response;
  })();
  return result;
}

async function handleSyncPush(request: Request, database: SqliteDatabase, user: UserRow) {
  const payload = await readJson<{ mutations?: unknown }>(request);
  if (!payload || !Array.isArray(payload.mutations) || payload.mutations.length > 50 || !payload.mutations.every(validSyncMutation)) return jsonError(400, "INVALID_SYNC_MUTATIONS", "同步操作无效");
  const body: SyncPushResponse = { results: payload.mutations.map((mutation) => applySyncMutation(database, user, mutation)) };
  return json(body);
}

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
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
  const basename = relativePath.toLowerCase();
  const mutablePwaAsset = basename === "sw.js" || basename === "manifest.webmanifest";
  headers.set("Cache-Control", hasExtension && relativePath !== "index.html" && !mutablePwaAsset ? "public, max-age=31536000, immutable" : "no-cache");
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

  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (signal: string) => {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      console.log(`[server] 收到 ${signal}，开始关闭服务`);

      let forceShutdownTimer: ReturnType<typeof setTimeout> | null = null;
      const forceShutdown = new Promise<"forced">((resolveForceShutdown) => {
        forceShutdownTimer = setTimeout(() => {
          console.warn("[server] 优雅关闭超时，强制关闭活动连接");
          void server.stop(true).then(() => resolveForceShutdown("forced"), (error) => {
            console.error("[server] 强制关闭服务失败", error);
            resolveForceShutdown("forced");
          });
        }, 5_000);
      });

      try {
        await Promise.race([server.stop(), forceShutdown]);
      } finally {
        if (forceShutdownTimer) clearTimeout(forceShutdownTimer);
        database.close();
        console.log("[server] 服务已关闭");
      }
    })();

    return shutdownPromise;
  };

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}
