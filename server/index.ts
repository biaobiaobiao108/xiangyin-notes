import { mkdir, rename } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ImageAssetSummary, ShareSnapshot, Note, NoteSummary, NoteView, Share, Notebook, NoteLinkSummary, UnlinkedMention, NoteBacklinksResponse } from "../shared/types";
import { extractTags, normalizeTag, parseTagQuery } from "../shared/tags";
import { extractContextSnippet, extractWikiLinks, findUnlinkedMentionsInMarkdown, linkMentionInMarkdown, normalizeLinkTitle, replaceWikiLinkTarget } from "../shared/wiki-links";
import { databasePathFromEnv, openDatabase, type SqliteDatabase } from "./db";
import { IMAGE_ALLOWED_MIME_TYPES, IMAGE_MAX_BYTES, extensionForMimeType, inspectImage } from "./images";
import {
  findActiveNoteIdByTitle,
  resolveNoteLinksForTarget,
  resolveNoteLinksForTitles,
  resolveNoteLinksForUser,
  sourceNoteIdsReferencingTarget,
  syncNoteLinks,
} from "./note-links";
import { createZip, type ZipEntry } from "./zip";

const SESSION_COOKIE = "xiangying_session";
const SESSION_TTL = 60 * 60 * 24 * 30;
const SESSION_COOKIE_TTL = 60 * 60 * 24 * 400;
const SESSION_REFRESH_WINDOW = 60 * 60 * 24 * 7;
const SHARE_TTL = 60 * 60 * 24 * 7;
const PASSWORD_ITERATIONS = 100_000;
const NOTE_PAGE_SIZE = 100;
const BACKLINK_REFERENCE_LIMIT = 100;
const BACKLINK_MENTION_LIMIT = 100;
const BACKLINK_CANDIDATE_LIMIT = 100;
const BACKLINK_SCAN_CHAR_LIMIT = 8 * 1024 * 1024;
const NOTE_PREVIEW_LIMIT = 180;
const NOTE_PREVIEW_SCAN_LIMIT = NOTE_PREVIEW_LIMIT + 64;
const NOTE_BODY_MAX_BYTES = 4_500_000;
const LOGIN_WINDOW_SECONDS = 15 * 60;
const LOGIN_MAX_FAILURES = 8;
const LOGIN_BLOCK_SECONDS = 15 * 60;
const LOGIN_ATTEMPT_MAX_ENTRIES = 2_000;
const LOGIN_ATTEMPT_CLEANUP_INTERVAL_SECONDS = 60;
const SESSION_CLEANUP_INTERVAL_SECONDS = 60;
const ORPHAN_ASSET_TTL_SECONDS = 24 * 60 * 60;
const ORPHAN_ASSET_CLEANUP_INTERVAL_SECONDS = 60;
const NOTE_VIEWS: NoteView[] = ["all", "inbox", "favorites", "shared", "trash"];
const DEFAULT_CLIENT_ROOT = "./dist/client";
const DEV_SERVICE_WORKER_SOURCE = `
self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith("xiangying-notes-")).map((key) => caches.delete(key)));
    await self.clients.claim();
    const clients = await self.clients.matchAll({ type: "window" });
    await Promise.all(clients.map((client) => client.navigate(client.url)));
  })());
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(request));
});
`;
const encoder = new TextEncoder();

type SqlValue = string | number | null | Uint8Array | bigint;

export type RuntimeEnvironment = Record<string, string | undefined>;

export type ServerOptions = {
  database: SqliteDatabase;
  environment: RuntimeEnvironment;
  clientRoot?: string;
  assetRoot?: string;
  clientAddress?: string;
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
  thumbnail_asset_id: string | null;
  thumbnail_storage_path: string | null;
  thumbnail_original_name: string | null;
  thumbnail_mime_type: string | null;
  thumbnail_byte_size: number | null;
  thumbnail_width: number | null;
  thumbnail_height: number | null;
  thumbnail_created_at: number | null;
};

type ImageAssetRow = {
  id: string;
  user_id: string;
  note_id: string | null;
  storage_path: string;
  original_name: string;
  mime_type: string;
  byte_size: number;
  width: number;
  height: number;
  document_order: number | null;
  created_at: number;
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

const NOTE_SELECT = `
  n.id, n.title, n.content_markdown, n.notebook_id, b.name AS notebook_name,
  b.color AS notebook_color, n.is_favorite, n.deleted_at, n.version, n.created_at, n.updated_at,
  a.id AS thumbnail_asset_id, a.storage_path AS thumbnail_storage_path,
  a.original_name AS thumbnail_original_name, a.mime_type AS thumbnail_mime_type,
  a.byte_size AS thumbnail_byte_size, a.width AS thumbnail_width,
  a.height AS thumbnail_height, a.created_at AS thumbnail_created_at
`;

const NOTE_FROM = `
  notes n
  JOIN notebooks b ON b.id = n.notebook_id
  LEFT JOIN image_assets a ON a.note_id = n.id AND a.document_order = 0
`;

type AuthCredentials = {
  username: string;
  password: string;
};

type LoginAttempt = {
  windowStartedAt: number;
  failures: number;
  blockedUntil: number;
};

class InvalidNoteAssetsError extends Error {
  constructor() {
    super("invalid-note-assets");
    this.name = "InvalidNoteAssetsError";
  }
}

const welcomeMarkdown = "## 欢迎来到象映笔记\n\n这是你的第一个笔记。按下 **Ctrl /** 可以打开命令菜单，开始记录你的想法。\n\n- 写下值得保留的东西\n- 用笔记本整理上下文\n- 随时生成一个 7 天有效的只读分享\n";
const PREVIEW_SYNTAX = new Set(["#", ">", "*", "_", "`", "~", "-", "[", "]", "(", ")"]);
const loginAttempts = new Map<string, LoginAttempt>();
let nextLoginAttemptCleanupAt = 0;
let nextSessionCleanupAt = 0;
let nextOrphanAssetCleanupAt = 0;
const ASSET_REFERENCE_PATTERN = /\/api\/assets\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?=[?#)\s]|$)/giu;
const MARKDOWN_IMAGE_SOURCE_PATTERN = /!\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/gu;
const PRIVATE_ASSET_SOURCE_PATTERN = /^\/api\/assets\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?=[?#]|$)/iu;

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
  if (!value) return null;
  try { return decodeURIComponent(value.slice(name.length + 1)); } catch { return null; }
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

function escapeLikePattern(value: string) {
  return value.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_");
}

/** A title made of nothing but whitespace is stored as empty so the client can show its placeholder. */
function normalizeNoteTitle(value: string) {
  return value.trim() === "" ? "" : value;
}

function getAuthCredentials(environment: RuntimeEnvironment): AuthCredentials | null {
  if (!validUsername(environment.XIANGYING_USERNAME) || !validPassword(environment.XIANGYING_PASSWORD)) return null;
  return { username: environment.XIANGYING_USERNAME, password: environment.XIANGYING_PASSWORD };
}

function assetRootFromEnv(environment: RuntimeEnvironment) {
  const configured = environment.ASSETS_PATH?.trim();
  if (configured) return resolve(configured);
  const databasePath = databasePathFromEnv(environment);
  return databasePath === ":memory:" ? resolve("./data/attachments") : join(dirname(resolve(databasePath)), "attachments");
}

function assetFilePath(assetRoot: string, storagePath: string) {
  const root = resolve(assetRoot);
  const requested = resolve(root, storagePath);
  const pathFromRoot = relative(root, requested);
  if (isAbsolute(pathFromRoot) || pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || pathFromRoot.startsWith(sep)) return null;
  return requested;
}

function assetUrl(id: string) {
  return `/api/assets/${encodeURIComponent(id)}`;
}

function toImageAsset(row: Pick<ImageAssetRow, "id" | "original_name" | "mime_type" | "byte_size" | "width" | "height" | "created_at">): ImageAssetSummary {
  return {
    id: row.id,
    url: assetUrl(row.id),
    originalName: row.original_name,
    mimeType: row.mime_type,
    byteSize: Number(row.byte_size),
    width: Number(row.width),
    height: Number(row.height),
    createdAt: Number(row.created_at),
  };
}

function noteAssetIds(markdown: string) {
  const ids: string[] = [];
  const seen = new Set<string>();
  ASSET_REFERENCE_PATTERN.lastIndex = 0;
  for (const match of markdown.matchAll(ASSET_REFERENCE_PATTERN)) {
    const id = match[1].toLowerCase();
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

function noteImageSources(markdown: string) {
  const sources: string[] = [];
  MARKDOWN_IMAGE_SOURCE_PATTERN.lastIndex = 0;
  for (const match of markdown.matchAll(MARKDOWN_IMAGE_SOURCE_PATTERN)) sources.push(match[1]);
  return sources;
}

function rewriteAssetUrlsForShare(markdown: string, token: string) {
  ASSET_REFERENCE_PATTERN.lastIndex = 0;
  return markdown.replace(ASSET_REFERENCE_PATTERN, (_match, id: string) => `/api/share-assets/${token}/${id}`);
}

function safeOriginalName(value: string) {
  const normalized = value.replace(/[\\/\0]/g, "_").trim();
  return (normalized || "image").slice(0, 200);
}

function thumbnailFromNoteRow(row: NoteRow): ImageAssetSummary | null {
  if (!row.thumbnail_asset_id || !row.thumbnail_original_name || !row.thumbnail_mime_type || row.thumbnail_byte_size === null || row.thumbnail_width === null || row.thumbnail_height === null || row.thumbnail_created_at === null) return null;
  return toImageAsset({
    id: row.thumbnail_asset_id,
    original_name: row.thumbnail_original_name,
    mime_type: row.thumbnail_mime_type,
    byte_size: row.thumbnail_byte_size,
    width: row.thumbnail_width,
    height: row.thumbnail_height,
    created_at: row.thumbnail_created_at,
  });
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

function jsonError(status: number, code: string, message: string, fields?: Record<string, string>, headers?: HeadersInit) {
  return json({ error: { code, message, ...(fields ? { fields } : {}) } }, status, headers);
}

async function readJson<T>(request: Request, maxBytes = 64 * 1024) {
  try {
    const declaredLength = Number(request.headers.get("Content-Length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) return null;
    if (!request.body) return null;
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}

function cleanupExpiredSessions(database: SqliteDatabase) {
  const timestamp = now();
  if (timestamp < nextSessionCleanupAt) return;
  nextSessionCleanupAt = timestamp + SESSION_CLEANUP_INTERVAL_SECONDS;
  database.query("DELETE FROM sessions WHERE expires_at <= ?").run(timestamp);
}

function loginClientKey(request: Request, environment: RuntimeEnvironment, clientAddress: string | undefined, username: string) {
  let address = clientAddress?.trim() || "unknown";
  if (environment.TRUST_PROXY === "true") {
    const forwarded = request.headers.get("X-Forwarded-For")?.split(",", 1)[0]?.trim();
    address = forwarded || request.headers.get("X-Real-IP")?.trim() || address;
  }
  return `${address.slice(0, 128)}:${username.slice(0, 32)}`;
}

function getLoginAttempt(key: string, timestamp: number) {
  if (timestamp >= nextLoginAttemptCleanupAt) {
    for (const [existingKey, attempt] of loginAttempts) {
      if (attempt.blockedUntil <= timestamp && timestamp - attempt.windowStartedAt > LOGIN_WINDOW_SECONDS) loginAttempts.delete(existingKey);
    }
    nextLoginAttemptCleanupAt = timestamp + LOGIN_ATTEMPT_CLEANUP_INTERVAL_SECONDS;
  }
  const current = loginAttempts.get(key);
  if (!current || timestamp - current.windowStartedAt > LOGIN_WINDOW_SECONDS) {
    if (!current && loginAttempts.size >= LOGIN_ATTEMPT_MAX_ENTRIES) {
      const oldestKey = loginAttempts.keys().next().value as string | undefined;
      if (oldestKey) loginAttempts.delete(oldestKey);
    }
    const next = { windowStartedAt: timestamp, failures: 0, blockedUntil: 0 };
    loginAttempts.set(key, next);
    return next;
  }
  return current;
}

function recordFailedLogin(key: string, timestamp: number) {
  const attempt = getLoginAttempt(key, timestamp);
  attempt.failures += 1;
  if (attempt.failures >= LOGIN_MAX_FAILURES) attempt.blockedUntil = timestamp + LOGIN_BLOCK_SECONDS;
}

function resetLoginAttempt(key: string) {
  loginAttempts.delete(key);
}

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; font-src 'self' https://cdn.jsdelivr.net; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
};

function withSecurityHeaders(response: Response, environment: RuntimeEnvironment) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  if (environment.COOKIE_SECURE === "true") headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function setSessionCookie(headers: Headers, request: Request, token: string, environment: RuntimeEnvironment, maxAge = SESSION_COOKIE_TTL) {
  const secure = environment.COOKIE_SECURE === "true";
  headers.set("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(token)}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`);
}

function toNote(row: NoteRow, tags = extractTags(row.content_markdown)): NoteSummary {
  return {
    id: row.id,
    title: row.title,
    preview: formatPreview(row.content_markdown),
    tags,
    thumbnail: thumbnailFromNoteRow(row),
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

export function formatPreview(markdown: string) {
  const output: string[] = [];
  let outputLength = 0;
  let pendingWhitespace = false;

  for (let index = 0; index < markdown.length && outputLength < NOTE_PREVIEW_SCAN_LIMIT; index += 1) {
    const image = markdown.slice(index).match(/^!\[[^\]]*\]\([^)]*\)/u);
    if (image) {
      index += image[0].length - 1;
      pendingWhitespace = true;
      continue;
    }
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

export function parseSearchTerms(query: string) {
  const parts = query.trim().split(/\s+/).filter(Boolean);
  const tokens: string[] = [];
  const ftsTokens: string[] = [];
  const shortTokens: string[] = [];

  for (const part of parts) {
    const cleaned = part.replaceAll('"', "").trim();
    if (!cleaned) continue;
    tokens.push(cleaned);
    if (cleaned.length >= 3) {
      ftsTokens.push(cleaned);
    } else {
      shortTokens.push(cleaned);
    }
  }

  return { tokens, ftsTokens, shortTokens };
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
    SELECT ${NOTE_SELECT}
    FROM ${NOTE_FROM}
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

async function requireUser(database: SqliteDatabase, environment: RuntimeEnvironment, request: Request) {
  return await getCurrentUser(database, environment, request) ?? jsonError(401, "UNAUTHENTICATED", "请先登录");
}

function isResponse(value: UserRow | Response): value is Response {
  return value instanceof Response;
}

function validNoteAssetReferences(database: SqliteDatabase, userId: string, noteId: string | null, contentMarkdown: string) {
  if (noteImageSources(contentMarkdown).some((source) => !PRIVATE_ASSET_SOURCE_PATTERN.test(source))) return false;
  const ids = noteAssetIds(contentMarkdown);
  if (!ids.length) return true;
  const assets = all<Pick<ImageAssetRow, "id" | "note_id">>(database, `SELECT id, note_id FROM image_assets WHERE user_id = ? AND id IN (${ids.map(() => "?").join(",")})`, userId, ...ids);
  const assetsById = new Map(assets.map((asset) => [asset.id.toLowerCase(), asset]));
  return assets.length === ids.length && ids.every((id) => {
    const asset = assetsById.get(id);
    return Boolean(asset) && (asset?.note_id === null || asset?.note_id === noteId);
  });
}

function syncNoteAssetReferences(database: SqliteDatabase, userId: string, noteId: string, contentMarkdown: string) {
  const ids = noteAssetIds(contentMarkdown);
  const assets = ids.length
    ? all<ImageAssetRow>(database, `SELECT id, user_id, note_id, storage_path, original_name, mime_type, byte_size, width, height, document_order, created_at FROM image_assets WHERE user_id = ? AND id IN (${ids.map(() => "?").join(",")})`, userId, ...ids)
    : [];
  const assetsById = new Map(assets.map((asset) => [asset.id.toLowerCase(), asset]));
  if (assets.length !== ids.length || ids.some((id) => {
    const asset = assetsById.get(id);
    return !asset || (asset.note_id !== null && asset.note_id !== noteId);
  })) return false;

  database.query("UPDATE image_assets SET document_order = NULL WHERE note_id = ?").run(noteId);
  for (const [documentOrder, id] of ids.entries()) {
    database.query("UPDATE image_assets SET note_id = ?, document_order = ? WHERE id = ? AND user_id = ?").run(noteId, documentOrder, id, userId);
  }
  return true;
}

function assetPathsForNotes(database: SqliteDatabase, userId: string, noteIds: string[]) {
  if (!noteIds.length) return [] as string[];
  return all<{ storage_path: string }>(database, `SELECT storage_path FROM image_assets WHERE user_id = ? AND note_id IN (${noteIds.map(() => "?").join(",")})`, userId, ...noteIds).map((asset) => asset.storage_path);
}

async function removeAssetFiles(assetRoot: string, storagePaths: string[]) {
  for (const storagePath of storagePaths) {
    const filePath = assetFilePath(assetRoot, storagePath);
    if (!filePath) {
      console.warn("[assets] refused to delete an unsafe storage path", storagePath);
      continue;
    }
    try {
      await Bun.file(filePath).unlink();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("[assets] failed to delete asset file", filePath, error);
    }
  }
}

async function cleanupOrphanAssets(database: SqliteDatabase, assetRoot: string) {
  const timestamp = now();
  if (timestamp < nextOrphanAssetCleanupAt) return;
  nextOrphanAssetCleanupAt = timestamp + ORPHAN_ASSET_CLEANUP_INTERVAL_SECONDS;
  const staleAssets = all<{ id: string; storage_path: string }>(database, "SELECT id, storage_path FROM image_assets WHERE note_id IS NULL AND created_at <= ? LIMIT 100", timestamp - ORPHAN_ASSET_TTL_SECONDS);
  if (!staleAssets.length) return;
  const deleteStaleAssets = database.transaction(() => {
    const statement = database.query("DELETE FROM image_assets WHERE id = ? AND note_id IS NULL");
    for (const asset of staleAssets) statement.run(asset.id);
  });
  deleteStaleAssets();
  await removeAssetFiles(assetRoot, staleAssets.map((asset) => asset.storage_path));
}

function createNote(database: SqliteDatabase, userId: string, notebookId: string, title: string, contentMarkdown: string, requestedId?: string) {
  const id = requestedId ?? crypto.randomUUID();
  const createdAt = now();
  const transaction = database.transaction(() => {
    database.query("INSERT INTO notes (id, user_id, notebook_id, title, content_markdown, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)").run(id, userId, notebookId, title, contentMarkdown, createdAt, createdAt);
    if (!syncNoteAssetReferences(database, userId, id, contentMarkdown)) throw new Error("invalid-note-assets");
    database.query("INSERT INTO notes_fts (note_id, title, content) VALUES (?, ?, ?)").run(id, title, contentMarkdown);
    syncNoteLinks(database, userId, id, contentMarkdown, createdAt);
    resolveNoteLinksForTarget(database, userId, title, id);
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
  const titleChanged = current.title !== title;
  const oldTitle = current.title;

  const updated = database.query("UPDATE notes SET title = ?, content_markdown = ?, notebook_id = ?, is_favorite = ?, deleted_at = ?, version = version + 1, updated_at = ? WHERE id = ? AND user_id = ? AND version = ? RETURNING id").get(title, contentMarkdown, notebookId, isFavorite, deletedAt, updatedAt, current.id, userId, current.version) as { id: string } | null;
  if (!updated) return false;
  if (!syncNoteAssetReferences(database, userId, current.id, contentMarkdown)) throw new InvalidNoteAssetsError();
  database.query("DELETE FROM notes_fts WHERE note_id = ?").run(current.id);
  database.query("INSERT INTO notes_fts (note_id, title, content) VALUES (?, ?, ?)").run(current.id, title, contentMarkdown);
  syncNoteLinks(database, userId, current.id, contentMarkdown, updatedAt);

  if (titleChanged && oldTitle.trim() && title.trim()) {
    const referencingSourceNoteIds = sourceNoteIdsReferencingTarget(database, userId, current.id);
    for (const sourceNoteId of referencingSourceNoteIds) {
      const refNote = getNote(database, userId, sourceNoteId);
      if (!refNote) continue;
      const { content: replacedContent, count } = replaceWikiLinkTarget(refNote.content_markdown, oldTitle, title);
      if (count > 0) {
        database.query("UPDATE notes SET content_markdown = ?, version = version + 1, updated_at = ? WHERE id = ? AND user_id = ?").run(replacedContent, updatedAt, refNote.id, userId);
        database.query("DELETE FROM notes_fts WHERE note_id = ?").run(refNote.id);
        database.query("INSERT INTO notes_fts (note_id, title, content) VALUES (?, ?, ?)").run(refNote.id, refNote.title, replacedContent);
        syncNoteLinks(database, userId, refNote.id, replacedContent, updatedAt);
      }
    }
  }
  if (titleChanged || deletedAt !== current.deleted_at) {
    resolveNoteLinksForTitles(database, userId, [oldTitle, title]);
  }

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

async function uploadImageAsset(request: Request, database: SqliteDatabase, user: UserRow, assetRoot: string) {
  const declaredLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > IMAGE_MAX_BYTES + 256 * 1024) return jsonError(413, "IMAGE_TOO_LARGE", "图片超过 10 MiB 大小限制");

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return jsonError(400, "INVALID_IMAGE_UPLOAD", "图片上传数据无效");
  }
  const entry = formData.get("file");
  if (!(entry instanceof File)) return jsonError(400, "INVALID_IMAGE_UPLOAD", "请选择图片文件");
  if (entry.size <= 0 || entry.size > IMAGE_MAX_BYTES) return jsonError(413, "IMAGE_TOO_LARGE", "图片超过 10 MiB 大小限制");

  const bytes = new Uint8Array(await entry.arrayBuffer());
  const inspection = inspectImage(bytes);
  if (!inspection || !IMAGE_ALLOWED_MIME_TYPES.has(inspection.mimeType)) return jsonError(415, "UNSUPPORTED_IMAGE", "只支持 JPEG、PNG、WebP 和 GIF 图片");

  const id = crypto.randomUUID();
  const storagePath = `${user.id}/${id}${extensionForMimeType(inspection.mimeType)}`;
  const filePath = assetFilePath(assetRoot, storagePath);
  if (!filePath) return jsonError(500, "ASSET_STORAGE_ERROR", "图片存储路径无效");
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.uploading-${crypto.randomUUID()}`;
  try {
    await Bun.write(temporaryPath, bytes);
    await rename(temporaryPath, filePath);
    database.query("INSERT INTO image_assets (id, user_id, storage_path, original_name, mime_type, byte_size, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, user.id, storagePath, safeOriginalName(entry.name), inspection.mimeType, bytes.byteLength, inspection.width, inspection.height, now());
  } catch (error) {
    await Bun.file(temporaryPath).unlink().catch(() => undefined);
    await Bun.file(filePath).unlink().catch(() => undefined);
    throw error;
  }

  const asset = first<ImageAssetRow>(database, "SELECT id, user_id, note_id, storage_path, original_name, mime_type, byte_size, width, height, document_order, created_at FROM image_assets WHERE id = ? AND user_id = ?", id, user.id);
  return asset ? json({ asset: toImageAsset(asset) }, 201) : jsonError(500, "ASSET_STORAGE_ERROR", "图片保存失败");
}

async function serveImageAsset(request: Request, database: SqliteDatabase, userId: string, assetId: string, assetRoot: string, cacheControl = "private, max-age=3600") {
  const asset = first<ImageAssetRow>(database, "SELECT id, user_id, note_id, storage_path, original_name, mime_type, byte_size, width, height, document_order, created_at FROM image_assets WHERE id = ? AND user_id = ?", assetId, userId);
  if (!asset) return jsonError(404, "ASSET_NOT_FOUND", "图片不存在");
  const filePath = assetFilePath(assetRoot, asset.storage_path);
  if (!filePath) return jsonError(404, "ASSET_NOT_FOUND", "图片不存在");
  const file = Bun.file(filePath);
  if (!(await file.exists())) return jsonError(404, "ASSET_NOT_FOUND", "图片不存在");
  const headers = new Headers({
    "Content-Type": asset.mime_type,
    "Content-Length": String(asset.byte_size),
    "Content-Disposition": "inline",
    "Cache-Control": cacheControl,
  });
  return new Response(request.method === "HEAD" ? null : file, { headers });
}

async function servePublicShareAsset(request: Request, database: SqliteDatabase, assetRoot: string) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  const segments = new URL(request.url).pathname.split("/").filter(Boolean);
  const token = segments[2] ?? "";
  const assetId = segments[3] ?? "";
  const share = first<{ note_id: string; expires_at: number; revoked_at: number | null }>(database, "SELECT note_id, expires_at, revoked_at FROM shares WHERE token_hash = ?", await digestHex(token));
  if (!share) return jsonError(404, "SHARE_NOT_FOUND", "分享链接不存在");
  if (share.revoked_at) return jsonError(410, "SHARE_REVOKED", "分享链接已撤销");
  if (share.expires_at <= now()) return jsonError(410, "SHARE_EXPIRED", "分享链接已过期");
  const asset = first<ImageAssetRow>(database, "SELECT id, user_id, note_id, storage_path, original_name, mime_type, byte_size, width, height, document_order, created_at FROM image_assets WHERE id = ? AND note_id = ?", assetId, share.note_id);
  if (!asset) return jsonError(404, "ASSET_NOT_FOUND", "图片不存在");
  const filePath = assetFilePath(assetRoot, asset.storage_path);
  if (!filePath) return jsonError(404, "ASSET_NOT_FOUND", "图片不存在");
  const file = Bun.file(filePath);
  if (!(await file.exists())) return jsonError(404, "ASSET_NOT_FOUND", "图片不存在");
  return new Response(request.method === "HEAD" ? null : file, { headers: { "Content-Type": asset.mime_type, "Content-Length": String(asset.byte_size), "Content-Disposition": "inline", "Cache-Control": "no-store" } });
}

function toShare(row: { id: string; note_id: string; created_at: number; expires_at: number; revoked_at: number | null }): Share {
  return { id: row.id, noteId: row.note_id, createdAt: row.created_at, expiresAt: row.expires_at, revokedAt: row.revoked_at };
}

async function handleApi(request: Request, options: ServerOptions) {
  const { database, environment, clientAddress } = options;
  const assetRoot = resolve(options.assetRoot ?? assetRootFromEnv(environment));
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  let segments: string[];
  try {
    segments = url.pathname.split("/").filter(Boolean).slice(1).map((segment) => decodeURIComponent(segment));
  } catch {
    return jsonError(400, "INVALID_PATH", "请求路径无效");
  }
  const resource = segments[0] ?? "";
  const id = segments[1] ?? "";
  const subresource = segments[2] ?? "";
  cleanupExpiredSessions(database);
  void cleanupOrphanAssets(database, assetRoot).catch((error) => console.warn("[assets] orphan cleanup failed", error));

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
    if (payload.username.length > 128 || payload.password.length > 256) return jsonError(400, "INVALID_LOGIN", "用户名或密码格式无效");
    const credentials = getAuthCredentials(environment);
    if (!credentials) return jsonError(503, "AUTH_NOT_CONFIGURED", "请先配置 XIANGYING_USERNAME 和 XIANGYING_PASSWORD");
    const attemptKey = loginClientKey(request, environment, clientAddress, payload.username);
    const timestamp = now();
    const attempt = getLoginAttempt(attemptKey, timestamp);
    if (attempt.blockedUntil > timestamp) return jsonError(429, "TOO_MANY_LOGIN_ATTEMPTS", "登录尝试过于频繁，请稍后再试", undefined, { "Retry-After": String(attempt.blockedUntil - timestamp) });
    if (!constantTimeEqual(payload.username, credentials.username) || !constantTimeEqual(payload.password, credentials.password)) {
      recordFailedLogin(attemptKey, timestamp);
      return jsonError(401, "INVALID_CREDENTIALS", "用户名或密码不正确");
    }
    resetLoginAttempt(attemptKey);

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

  const user = await requireUser(database, environment, request);
  if (isResponse(user)) return user;

  if (method === "GET" && url.pathname === "/api/me") {
    const headers = new Headers();
    const session = cookieValue(request.headers.get("Cookie"), SESSION_COOKIE);
    if (session) setSessionCookie(headers, request, session, environment);
    return json({ user }, 200, headers);
  }

  if (method === "GET" && url.pathname === "/api/export") {
    const notes = all<{ id: string; title: string; content_markdown: string; updated_at: number; notebook_name: string }>(
      database,
      `
      SELECT n.id, n.title, n.content_markdown, n.updated_at, b.name AS notebook_name
      FROM notes n
      JOIN notebooks b ON b.id = n.notebook_id
      WHERE n.user_id = ? AND n.deleted_at IS NULL
      ORDER BY b.sort_order, b.name, n.updated_at DESC
      `,
      user.id,
    );

    const assetRows = all<{ id: string; storage_path: string; original_name: string }>(
      database,
      "SELECT id, storage_path, original_name FROM image_assets WHERE user_id = ?",
      user.id,
    );

    const entries: ZipEntry[] = [];
    const usedPaths = new Set<string>();

    const assetFileNameMap = new Map<string, string>();
    for (const asset of assetRows) {
      const filePath = assetFilePath(assetRoot, asset.storage_path);
      if (!filePath) continue;
      const file = Bun.file(filePath);
      if (!(await file.exists())) continue;
      const safeName = asset.original_name.replace(/[\\/:*?"<>|]/g, "_").slice(0, 80) || "image";
      const attachmentRelPath = `attachments/${asset.id.slice(0, 8)}_${safeName}`;
      assetFileNameMap.set(asset.id.toLowerCase(), attachmentRelPath);
      entries.push({
        name: attachmentRelPath,
        data: new Uint8Array(await file.arrayBuffer()),
      });
    }

    for (const note of notes) {
      const notebookDir = (note.notebook_name.trim() || "收件箱").replace(/[\\/:*?"<>|]/g, "_");
      const baseTitle = (note.title.trim() || "未命名笔记").replace(/[\\/:*?"<>|]/g, "_").slice(0, 100);
      let filename = `${notebookDir}/${baseTitle}.md`;
      let counter = 1;
      while (usedPaths.has(filename.toLowerCase())) {
        filename = `${notebookDir}/${baseTitle} (${counter}).md`;
        counter += 1;
      }
      usedPaths.add(filename.toLowerCase());

      let content = note.content_markdown;
      ASSET_REFERENCE_PATTERN.lastIndex = 0;
      content = content.replace(ASSET_REFERENCE_PATTERN, (_match, id: string) => {
        const localRel = assetFileNameMap.get(id.toLowerCase());
        return localRel ? `../${localRel}` : `/api/assets/${id}`;
      });

      entries.push({
        name: filename,
        data: content,
        mtime: new Date(note.updated_at * 1000),
      });
    }

    const zipBytes = createZip(entries);
    const dateStr = new Date().toISOString().slice(0, 10);
    const headers = new Headers({
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="xiangying-notes-${dateStr}.zip"`,
      "Cache-Control": "no-store",
    });
    return new Response(zipBytes.buffer as ArrayBuffer, { headers });
  }

  if (resource === "assets" && !id && method === "POST") return await uploadImageAsset(request, database, user, assetRoot);
  if (resource === "assets" && id && (method === "GET" || method === "HEAD")) return await serveImageAsset(request, database, user.id, id, assetRoot);

  if (method === "DELETE" && url.pathname === "/api/trash") {
    const emptyTrash = database.transaction(() => {
      const deletedIds = all<{ id: string }>(database, "SELECT id FROM notes WHERE user_id = ? AND deleted_at IS NOT NULL", user.id).map((note) => note.id);
      const assetPaths = assetPathsForNotes(database, user.id, deletedIds);
      database.query("DELETE FROM notes_fts WHERE note_id IN (SELECT id FROM notes WHERE user_id = ? AND deleted_at IS NOT NULL)").run(user.id);
      database.query("DELETE FROM notes WHERE user_id = ? AND deleted_at IS NOT NULL").run(user.id);
      return { ok: true, deletedCount: deletedIds.length, deletedIds, assetPaths };
    });
    const emptiedTrash = emptyTrash();
    await removeAssetFiles(assetRoot, emptiedTrash.assetPaths);
    return json({ ok: emptiedTrash.ok, deletedCount: emptiedTrash.deletedCount, deletedIds: emptiedTrash.deletedIds });
  }

  if (resource === "wiki-notes" && id === "ensure" && method === "POST") {
    const payload = await readJson<{ title?: unknown; notebookId?: unknown }>(request, 64 * 1024);
    if (!payload || !validText(payload.title, 200) || !payload.title.trim() || typeof payload.notebookId !== "string") {
      return jsonError(400, "INVALID_WIKI_TARGET", "双向链接目标无效");
    }
    const title = payload.title.trim();
    const existingId = findActiveNoteIdByTitle(database, user.id, title);
    if (existingId) {
      const existing = getNote(database, user.id, existingId);
      if (existing) return json({ note: toFullNote(existing), created: false });
    }
    if (!first(database, "SELECT id FROM notebooks WHERE id = ? AND user_id = ?", payload.notebookId, user.id)) {
      return jsonError(400, "INVALID_NOTEBOOK", "笔记本不存在");
    }
    const noteId = createNote(database, user.id, payload.notebookId, title, "");
    const note = getNote(database, user.id, noteId);
    return note ? json({ note: toFullNote(note), created: true }, 201) : jsonError(500, "NOTE_CREATE_FAILED", "笔记创建失败");
  }

  if (resource === "notes" && !id && method === "GET") {
    const view = url.searchParams.get("view") ?? "all";
    if (!NOTE_VIEWS.includes(view as NoteView)) return jsonError(400, "INVALID_VIEW", "不支持的笔记视图");
    const query = url.searchParams.get("query")?.slice(0, 80) ?? "";
    const notebookId = url.searchParams.get("notebookId");
    const conditions = ["n.user_id = ?"];
    const params: SqlValue[] = [user.id];
    let from = NOTE_FROM;

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
    const tagQuery = parseTagQuery(query);
    if (query && !tagQuery) {
      const { tokens, ftsTokens, shortTokens } = parseSearchTerms(query);
      // Without any searchable term the query must match nothing, not fall back to listing every note.
      if (tokens.length === 0) return json({ notes: [], total: 0 });

      if (ftsTokens.length > 0) {
        const ftsQuery = ftsTokens.map((part) => `"${part.replaceAll('"', '""')}"`).join(" AND ");
        from += " JOIN notes_fts ON notes_fts.note_id = n.id";
        conditions.push("notes_fts MATCH ?");
        params.push(ftsQuery);
      }

      for (const short of shortTokens) {
        const escapedQuery = escapeLikePattern(short);
        conditions.push("(n.title LIKE ? ESCAPE '!' OR n.content_markdown LIKE ? ESCAPE '!')");
        params.push(`%${escapedQuery}%`, `%${escapedQuery}%`);
      }
    }
    const offset = Math.max(0, Number.parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);
    const where = conditions.join(" AND ");
    if (tagQuery) {
      const tagListStatement = database.query(`
        SELECT ${NOTE_SELECT}
        FROM ${from} WHERE ${where} ORDER BY n.updated_at DESC
      `);
      const notes: NoteSummary[] = [];
      let total = 0;
      for (const row of tagListStatement.iterate(...params) as Iterable<NoteRow>) {
        const tags = extractTags(row.content_markdown);
        if (!tags.some((tag) => normalizeTag(tag) === tagQuery)) continue;
        if (total >= offset && notes.length < NOTE_PAGE_SIZE) notes.push(toNote(row, tags));
        total += 1;
      }
      return json({ notes, total });
    }
    const totalRow = first<{ count: number }>(database, `SELECT COUNT(*) AS count FROM ${from} WHERE ${where}`, ...params);
    const listStatement = database.query(`
      SELECT ${NOTE_SELECT}
      FROM ${from} WHERE ${where} ORDER BY n.updated_at DESC LIMIT ${NOTE_PAGE_SIZE} OFFSET ${offset}
    `);
    const notes: NoteSummary[] = [];
    for (const row of listStatement.iterate(...params) as Iterable<NoteRow>) notes.push(toNote(row));
    return json({ notes, total: Number(totalRow?.count ?? 0) });
  }

  if (resource === "notes" && !id && method === "POST") {
    const payload = await readJson<{ id?: unknown; title?: unknown; contentMarkdown?: unknown; notebookId?: unknown }>(request, NOTE_BODY_MAX_BYTES);
    if (!payload) return jsonError(400, "INVALID_JSON", "请求体无效或超出大小限制");
    const rawTitle = payload?.title === undefined ? "未命名笔记" : payload.title;
    const contentMarkdown = payload?.contentMarkdown === undefined ? "" : payload.contentMarkdown;
    if (!validText(rawTitle, 200) || !validText(contentMarkdown, 1_000_000)) return jsonError(413, "NOTE_TOO_LARGE", "笔记标题或正文超出长度限制");
    const title = normalizeNoteTitle(rawTitle);
    const notebookId = typeof payload?.notebookId === "string" ? payload.notebookId : first<{ id: string }>(database, "SELECT id FROM notebooks WHERE user_id = ? AND is_system = 1 LIMIT 1", user.id)?.id;
    if (!notebookId) return jsonError(400, "NO_NOTEBOOK", "没有可用的收件箱");
    if (!first(database, "SELECT id FROM notebooks WHERE id = ? AND user_id = ?", notebookId, user.id)) return jsonError(400, "INVALID_NOTEBOOK", "笔记本不存在");
    if (!validNoteAssetReferences(database, user.id, null, contentMarkdown)) return jsonError(400, "INVALID_ASSET", "笔记引用了无权访问的图片");
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
    const publicOrigin = getPublicOrigin(url, environment);
    const createdAt = now();
    const expiresAt = createdAt + SHARE_TTL;
    const shareId = crypto.randomUUID();
    const token = createOpaqueToken();
    const tokenHash = await digestHex(token);
    const transaction = database.transaction(() => {
      database.query("INSERT INTO shares (id, note_id, user_id, token_hash, created_at, expires_at, snapshot_title, snapshot_content_markdown) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(shareId, note.id, user.id, tokenHash, createdAt, expiresAt, note.title, rewriteAssetUrlsForShare(note.content_markdown, token));
    });
    transaction();
    const share: Share = { id: shareId, noteId: note.id, expiresAt, revokedAt: null, createdAt, url: `${publicOrigin}/share/${token}` };
    return json({ share }, 201);
  }

  if (resource === "notes" && id && subresource === "backlinks" && method === "GET") {
    const note = getNote(database, user.id, id);
    if (!note) return jsonError(404, "NOTE_NOT_FOUND", "笔记不存在");

    const linkedRows = database.query(`
      SELECT nl.id AS link_id, nl.source_note_id, n.title AS source_title, n.content_markdown AS source_content, n.updated_at AS source_updated_at, nb.name AS notebook_name, nl.target_title, nl.target_note_id
      FROM note_links nl
      JOIN notes n ON nl.source_note_id = n.id AND n.user_id = nl.user_id
      JOIN notebooks nb ON n.notebook_id = nb.id
      WHERE nl.user_id = ? AND nl.target_note_id = ? AND nl.source_note_id != ? AND n.deleted_at IS NULL
      ORDER BY n.updated_at DESC
      LIMIT ?
    `);
    const linkedReferences: NoteLinkSummary[] = [];
    let truncated = false;
    let scannedChars = 0;
    for (const row of linkedRows.iterate(
      user.id,
      note.id,
      note.id,
      BACKLINK_REFERENCE_LIMIT + 1,
    ) as Iterable<{
      link_id: string;
      source_note_id: string;
      source_title: string;
      source_content: string;
      source_updated_at: number;
      notebook_name: string;
      target_title: string;
      target_note_id: string | null;
    }>) {
      if (linkedReferences.length >= BACKLINK_REFERENCE_LIMIT) {
        truncated = true;
        break;
      }
      scannedChars += row.source_content.length;
      if (scannedChars > BACKLINK_SCAN_CHAR_LIMIT) {
        truncated = true;
        break;
      }
      const links = extractWikiLinks(row.source_content);
      const matched = links.find((l) => normalizeLinkTitle(l.target) === normalizeLinkTitle(row.target_title) || normalizeLinkTitle(l.target) === normalizeLinkTitle(note.title));
      const snippet = matched ? extractContextSnippet(row.source_content, matched.start, matched.end) : row.source_content.slice(0, 100);
      linkedReferences.push({
        id: row.link_id,
        sourceNoteId: row.source_note_id,
        sourceNoteTitle: row.source_title,
        sourceNotebookName: row.notebook_name,
        targetTitle: row.target_title,
        targetNoteId: row.target_note_id,
        snippet,
        updatedAt: row.source_updated_at,
      });
    }

    const unlinkedMentions: UnlinkedMention[] = [];
    const trimmedTitle = note.title.trim();
    if (trimmedTitle.length >= 2) {
      const { ftsTokens } = parseSearchTerms(trimmedTitle);
      const useFts = trimmedTitle.length >= 3 && ftsTokens.length > 0;
      let candidateFrom = "notes n JOIN notebooks nb ON n.notebook_id = nb.id";
      const candidateConditions = ["n.user_id = ?", "n.deleted_at IS NULL", "n.id != ?"];
      const candidateParams: SqlValue[] = [user.id, note.id];

      if (useFts) {
        candidateFrom += " JOIN notes_fts ON notes_fts.note_id = n.id";
        candidateConditions.push("notes_fts MATCH ?");
        candidateParams.push(ftsTokens.map((p) => `"${p.replaceAll('"', '""')}"`).join(" AND "));
      } else {
        candidateConditions.push("n.content_markdown LIKE ? ESCAPE '!'");
        candidateParams.push(`%${escapeLikePattern(trimmedTitle)}%`);
      }

      const candidateSql = `
        SELECT n.id, n.title, n.content_markdown, nb.name AS notebook_name, n.version, n.updated_at
        FROM ${candidateFrom}
        WHERE ${candidateConditions.join(" AND ")}
        ORDER BY n.updated_at DESC
        LIMIT ?
      `;
      candidateParams.push(BACKLINK_CANDIDATE_LIMIT + 1);
      const candidates = database.query(candidateSql);
      let candidateCount = 0;
      mentionLoop: for (const candidate of candidates.iterate(...candidateParams) as Iterable<{
        id: string;
        title: string;
        content_markdown: string;
        notebook_name: string;
        version: number;
        updated_at: number;
      }>) {
        candidateCount += 1;
        if (candidateCount > BACKLINK_CANDIDATE_LIMIT) {
          truncated = true;
          break;
        }
        scannedChars += candidate.content_markdown.length;
        if (scannedChars > BACKLINK_SCAN_CHAR_LIMIT) {
          truncated = true;
          break;
        }
        const mentions = findUnlinkedMentionsInMarkdown(candidate.content_markdown, note.title);
        for (const m of mentions) {
          if (unlinkedMentions.length >= BACKLINK_MENTION_LIMIT) {
            truncated = true;
            break mentionLoop;
          }
          unlinkedMentions.push({
            sourceNoteId: candidate.id,
            sourceNoteTitle: candidate.title,
            sourceNotebookName: candidate.notebook_name,
            snippet: m.snippet,
            matchIndex: m.start,
            matchText: m.matchText,
            sourceVersion: candidate.version,
            updatedAt: candidate.updated_at,
          });
        }
      }
    }

    const payload: NoteBacklinksResponse = { linkedReferences, unlinkedMentions, truncated };
    return json(payload);
  }

  if (resource === "notes" && id && subresource === "link-mention" && method === "POST") {
    const targetNote = getNote(database, user.id, id);
    if (!targetNote) return jsonError(404, "NOTE_NOT_FOUND", "目标笔记不存在");

    const payload = await readJson<{ sourceNoteId?: unknown; sourceVersion?: unknown; matchStart?: unknown; matchEnd?: unknown; matchText?: unknown }>(request, 10_000);
    if (!payload || typeof payload.sourceNoteId !== "string" || !Number.isInteger(payload.sourceVersion) || !Number.isInteger(payload.matchStart) || !Number.isInteger(payload.matchEnd) || !validText(payload.matchText, 200) || !payload.matchText) {
      return jsonError(400, "INVALID_MENTION_PAYLOAD", "提及参数无效");
    }

    const sourceNote = getNote(database, user.id, payload.sourceNoteId);
    if (!sourceNote) return jsonError(404, "SOURCE_NOTE_NOT_FOUND", "来源笔记不存在");
    if (sourceNote.version !== payload.sourceVersion) return jsonError(409, "MENTION_STALE", "来源笔记已更新，请重新选择提及");

    const matchStart = payload.matchStart as number;
    const matchEnd = payload.matchEnd as number;
    if (matchStart < 0 || matchEnd > sourceNote.content_markdown.length || matchStart >= matchEnd) {
      return jsonError(400, "INVALID_MENTION_RANGE", "提及范围无效");
    }
    const currentMatch = sourceNote.content_markdown.slice(matchStart, matchEnd);
    const isCurrentMention = currentMatch === payload.matchText
      && normalizeLinkTitle(currentMatch) === normalizeLinkTitle(targetNote.title)
      && findUnlinkedMentionsInMarkdown(sourceNote.content_markdown, targetNote.title).some((mention) => mention.start === matchStart && mention.end === matchEnd);
    if (!isCurrentMention) return jsonError(409, "MENTION_STALE", "提及位置已变化，请重新选择");

    const newContent = linkMentionInMarkdown(sourceNote.content_markdown, matchStart, matchEnd, targetNote.title);
    if (!updateNote(database, sourceNote, user.id, sourceNote.title, newContent, sourceNote.notebook_id, sourceNote.is_favorite, sourceNote.deleted_at)) {
      return jsonError(409, "VERSION_CONFLICT", "来源笔记已被更新，请重试");
    }

    return json({ ok: true });
  }

  if (resource === "notes" && id && method === "GET") {
    const note = getNote(database, user.id, id);
    return note ? json({ note: toFullNote(note) }) : jsonError(404, "NOTE_NOT_FOUND", "笔记不存在");
  }

  if (resource === "notes" && id && method === "PATCH") {
    const current = getNote(database, user.id, id);
    if (!current) return jsonError(404, "NOTE_NOT_FOUND", "笔记不存在");
    const payload = await readJson<{ version?: unknown; title?: unknown; contentMarkdown?: unknown; notebookId?: unknown; isFavorite?: unknown; deleted?: unknown }>(request, NOTE_BODY_MAX_BYTES);
    if (!payload || !Number.isInteger(payload.version)) return jsonError(400, "VERSION_REQUIRED", "保存笔记必须携带版本号");
    if (payload.version !== current.version) return json({ error: { code: "VERSION_CONFLICT", message: "这篇笔记已在别处更新", current: toFullNote(current) } }, 409);
    const rawTitle = payload.title === undefined ? current.title : payload.title;
    const contentMarkdown = payload.contentMarkdown === undefined ? current.content_markdown : payload.contentMarkdown;
    const notebookId = payload.notebookId === undefined ? current.notebook_id : payload.notebookId;
    if (payload.isFavorite !== undefined && typeof payload.isFavorite !== "boolean") return jsonError(400, "INVALID_NOTE", "收藏状态无效");
    if (payload.deleted !== undefined && typeof payload.deleted !== "boolean") return jsonError(400, "INVALID_NOTE", "回收站状态无效");
    const isFavorite = payload.isFavorite === undefined ? current.is_favorite : payload.isFavorite ? 1 : 0;
    const deletedAt = payload.deleted === undefined ? current.deleted_at : payload.deleted ? now() : null;
    if (!validText(rawTitle, 200) || !validText(contentMarkdown, 1_000_000) || typeof notebookId !== "string") return jsonError(413, "NOTE_TOO_LARGE", "笔记标题或正文超出长度限制");
    const title = normalizeNoteTitle(rawTitle);
    if (!first(database, "SELECT id FROM notebooks WHERE id = ? AND user_id = ?", notebookId, user.id)) return jsonError(400, "INVALID_NOTEBOOK", "笔记本不存在");
    if (!validNoteAssetReferences(database, user.id, current.id, contentMarkdown)) return jsonError(400, "INVALID_ASSET", "笔记引用了无权访问的图片");
    let updated: boolean;
    try {
      updated = updateNote(database, current, user.id, title, contentMarkdown, notebookId, isFavorite, deletedAt);
    } catch (error) {
      if (error instanceof InvalidNoteAssetsError) return jsonError(400, "INVALID_ASSET", "笔记引用了无权访问的图片");
      throw error;
    }
    if (!updated) {
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
    const assetPaths = assetPathsForNotes(database, user.id, [note.id]);
    const transaction = database.transaction(() => {
      database.query("DELETE FROM note_links WHERE user_id = ? AND source_note_id = ?").run(user.id, note.id);
      database.query("DELETE FROM notes_fts WHERE note_id = ?").run(note.id);
      database.query("DELETE FROM notes WHERE id = ? AND user_id = ?").run(note.id, user.id);
    });
    transaction();
    await removeAssetFiles(assetRoot, assetPaths);
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
      }
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
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
};

async function serveStatic(request: Request, clientRoot: string, environment: RuntimeEnvironment) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  const url = new URL(request.url);
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return new Response("Bad Request", { status: 400 });
  }
  if (pathname.includes("\0") || pathname.split(/[\\/]/).includes("..")) return new Response("Forbidden", { status: 403 });

  if (pathname === "/sw.js" && environment.NODE_ENV === "development") {
    return new Response(request.method === "HEAD" ? null : DEV_SERVICE_WORKER_SOURCE, {
      headers: {
        "Cache-Control": "no-cache",
        "Content-Type": "text/javascript; charset=utf-8",
      },
    });
  }

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
    let response: Response;
    if (url.pathname === "/api/share-assets/" || url.pathname.startsWith("/api/share-assets/")) {
      response = await servePublicShareAsset(request, options.database, resolve(options.assetRoot ?? assetRootFromEnv(options.environment)));
    } else if (url.pathname === "/api/shares/" || url.pathname.startsWith("/api/shares/")) {
      const segments = url.pathname.split("/").filter(Boolean);
      if (request.method === "GET" && segments.length === 3) response = await handlePublicShare(request, options.database);
      else response = url.pathname.startsWith("/api/") ? await handleApi(request, options) : await serveStatic(request, options.clientRoot ?? DEFAULT_CLIENT_ROOT, options.environment);
    } else if (url.pathname.startsWith("/api/")) {
      response = await handleApi(request, options);
    } else {
      response = await serveStatic(request, options.clientRoot ?? DEFAULT_CLIENT_ROOT, options.environment);
    }
    return withSecurityHeaders(response, options.environment);
  } catch (error) {
    const url = new URL(request.url);
    console.error(`[request] ${request.method} ${url.pathname}`, error);
    if (url.pathname.startsWith("/api/")) return withSecurityHeaders(jsonError(500, "INTERNAL_ERROR", "服务器暂时无法处理请求"), options.environment);
    return withSecurityHeaders(new Response("Internal Server Error", { status: 500 }), options.environment);
  }
}

if (import.meta.main) {
  const database = await openDatabase();
  const port = Number.parseInt(Bun.env.PORT ?? "3000", 10) || 3000;
  const hostname = Bun.env.HOST?.trim() || "0.0.0.0";
  const clientRoot = Bun.env.CLIENT_ROOT?.trim() || DEFAULT_CLIENT_ROOT;
  const server = Bun.serve({
    hostname,
    port,
    fetch(request, server) {
      return handleRequest(request, { database, environment: Bun.env, clientRoot, clientAddress: server.requestIP(request)?.address });
    },
    error(error) {
      console.error("[server] uncaught error", error);
      return withSecurityHeaders(jsonError(500, "INTERNAL_ERROR", "服务器暂时无法处理请求"), Bun.env);
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
