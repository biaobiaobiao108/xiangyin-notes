import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { extractTags, normalizeTag } from "../shared/tags";
import type { Note, NoteSummary, NoteView } from "../shared/types";
import type { RealtimeHub } from "./realtime";
import type { SqliteDatabase } from "./db";
import { formatPreview, NOTE_PREVIEW_SCAN_LIMIT } from "./note-preview";
import { thumbnailFromNoteRow } from "./note-assets";

export { formatPreview, NOTE_PREVIEW_LIMIT, NOTE_PREVIEW_SCAN_LIMIT } from "./note-preview";
export {
  ASSET_REFERENCE_PATTERN,
  assetUrl,
  InvalidNoteAssetsError,
  noteAssetIds,
  noteImageSources,
  PRIVATE_ASSET_SOURCE_PATTERN,
  rewriteMarkdownAssetDestinations,
  syncNoteAssetReferences,
  thumbnailFromNoteRow,
  toImageAsset,
  validNoteAssetReferences,
  validNoteImageSource,
  validNoteLinkDestination,
} from "./note-assets";

export type { SqliteDatabase };

export function normalizeNoteTitle(value: string) {
  return value.trim() === "" ? "" : value;
}

export type SqlValue = string | number | null | Uint8Array | bigint;

export type ServerOptions = {
  database: SqliteDatabase;
  environment?: Record<string, string | undefined>;
  clientRoot?: string;
  assetRoot?: string;
  clientAddress?: string;
  realtime?: RealtimeHub;
};

export type AuthCredentials = {
  username: string;
  password: string;
};

export type UserRow = {
  id: string;
  username: string;
};

export type NotebookRow = {
  id: string;
  user_id: string;
  name: string;
  color: string;
  is_system: number;
  sort_order: number;
  created_at: number;
  updated_at: number;
};

export type NoteRow = {
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

export type ImageAssetRow = {
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

export type RateLimitEntry = {
  count: number;
  resetAt: number;
};

export type RouteContext = {
  request: Request;
  url: URL;
  method: string;
  segments: string[];
  options: ServerOptions;
};

export const SESSION_COOKIE = "xiangying_session";
export const SESSION_TTL = 60 * 60 * 24 * 30;
export const SESSION_COOKIE_TTL = 60 * 60 * 24 * 400;
export const SESSION_REFRESH_WINDOW = 60 * 60 * 24 * 7;
export const PASSWORD_ITERATIONS = 600_000;
export const LEGACY_PASSWORD_ITERATIONS = 100_000;
export const NOTE_PAGE_SIZE = 100;
export const BACKLINK_REFERENCE_LIMIT = 100;
export const BACKLINK_MENTION_LIMIT = 100;
export const BACKLINK_CANDIDATE_LIMIT = 100;
export const BACKLINK_SCAN_CHAR_LIMIT = 8 * 1024 * 1024;
export const NOTE_BODY_MAX_BYTES = 4_500_000;
export const NOTE_CONTENT_MAX_LENGTH = 1_000_000;
export const LOGIN_WINDOW_SECONDS = 15 * 60;
export const LOGIN_MAX_FAILURES = 8;
// A separate, higher address budget stops username rotation without making a few typos block shared networks.
export const LOGIN_ADDRESS_MAX_FAILURES = 100;
export const LOGIN_BLOCK_SECONDS = 15 * 60;
export const LOGIN_ATTEMPT_MAX_ENTRIES = 2_000;
export const LOGIN_ATTEMPT_CLEANUP_INTERVAL_SECONDS = 60;
export const SESSION_CLEANUP_INTERVAL_SECONDS = 60;
export const NOTE_VIEWS: NoteView[] = ["all", "inbox", "favorites", "trash"];

export const welcomeMarkdown =
  "## 欢迎来到象映笔记\n\n这是你的第一个笔记。Windows 用户按下 **Alt + /**，macOS 用户按下 **Command + /**，即可打开命令菜单，开始记录你的想法。\n\n- 写下值得保留的东西\n- 用笔记本整理上下文\n- 随时整理值得保留的想法\n";

export function now() {
  return Math.floor(Date.now() / 1000);
}

export function first<T>(database: SqliteDatabase, sql: string, ...values: SqlValue[]) {
  return database.query(sql).get(...values) as T | null | undefined;
}

export function all<T>(database: SqliteDatabase, sql: string, ...values: SqlValue[]) {
  return database.query(sql).all(...values) as T[];
}

export function validText(value: unknown, maxLength: number) {
  return typeof value === "string" && value.length <= maxLength;
}

export function escapeLikePattern(value: string) {
  return value.replace(/[!%_]/g, "!$&");
}

export function createOpaqueToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("base64url");
}

export async function digestHex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Buffer.from(digest).toString("hex");
}

export async function derivePassword(
  password: string,
  saltHex: string,
  iterations = PASSWORD_ITERATIONS,
) {
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );
  const salt = Buffer.from(saltHex, "hex");
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations,
      hash: "SHA-256",
    },
    passwordKey,
    256,
  );
  return Buffer.from(bits).toString("hex");
}

export async function hashPassword(password: string) {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const salt = Buffer.from(saltBytes).toString("hex");
  const hash = await derivePassword(password, salt);
  return { hash, salt, iterations: PASSWORD_ITERATIONS };
}

export function constantTimeEqual(a: string, b: string) {
  const hashA = createHash("sha256").update(a).digest();
  const hashB = createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

function normalizedIp(value: string | null | undefined) {
  const address = value?.trim().toLowerCase() ?? "";
  if (address.startsWith("::ffff:") && isIP(address.slice(7)) === 4) return address.slice(7);
  return isIP(address) ? address : null;
}

function forwardedClientIp(
  header: string | null,
  trustedProxies: ReadonlySet<string>,
): string | null {
  if (!header) return null;
  const entries = header.split(",").map((entry) => entry.trim());
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const ip = normalizedIp(entries[index]);
    if (!ip) return null;
    if (!trustedProxies.has(ip)) return ip;
  }
  return null;
}

export function rateLimitClientAddress(
  request: Request,
  environment: Record<string, string | undefined>,
  clientAddress: string | undefined,
) {
  const directAddress = clientAddress?.trim() || "unknown";
  if (environment.TRUST_PROXY !== "true") return directAddress;

  const peerAddress = normalizedIp(clientAddress);
  if (!peerAddress) return directAddress;
  const trustedProxies = new Set(
    (environment.TRUSTED_PROXY_ADDRESSES ?? "")
      .split(",")
      .map((value) => normalizedIp(value) ?? "")
      .filter(Boolean),
  );
  if (!trustedProxies.has(peerAddress)) return directAddress;

  // Prefer proxy-overwritten X-Real-IP, or the rightmost untrusted hop in X-Forwarded-For,
  // so clients cannot spoof the leftmost entry when an upstream proxy appends.
  const realIp = normalizedIp(request.headers.get("X-Real-IP"));
  if (realIp && !trustedProxies.has(realIp)) return realIp;
  return (
    forwardedClientIp(request.headers.get("X-Forwarded-For"), trustedProxies) ??
    realIp ??
    directAddress
  );
}

export function isSecureRequest(
  request: Request,
  environment: Record<string, string | undefined> = {},
  clientAddress?: string,
) {
  const configured = environment.COOKIE_SECURE?.trim().toLowerCase();
  if (configured === "true") return true;
  if (configured === "false") return false;
  if (new URL(request.url).protocol === "https:") return true;
  // TLS terminated by a reverse proxy: honour X-Forwarded-Proto only when the proxy is trusted.
  if (environment.TRUST_PROXY === "true") {
    const peerAddress = normalizedIp(clientAddress);
    if (!peerAddress) return false;
    const trustedProxies = new Set(
      (environment.TRUSTED_PROXY_ADDRESSES ?? "")
        .split(",")
        .map((value) => normalizedIp(value) ?? "")
        .filter(Boolean),
    );
    if (trustedProxies.has(peerAddress)) {
      return (
        request.headers.get("X-Forwarded-Proto")?.split(",")[0]?.trim().toLowerCase() === "https"
      );
    }
  }
  return false;
}

let publicOriginWarningShown = false;

export function getPublicOrigin(
  requestUrl: URL,
  environment: Record<string, string | undefined> = {},
) {
  const configuredUrl = environment.PUBLIC_URL?.trim();
  if (!configuredUrl) return requestUrl.origin;
  try {
    const publicUrl = new URL(configuredUrl);
    if (publicUrl.protocol !== "http:" && publicUrl.protocol !== "https:")
      throw new Error("PUBLIC_URL must use http or https");
    return publicUrl.origin;
  } catch (error) {
    // A malformed PUBLIC_URL must not turn every write request into a 500.
    if (!publicOriginWarningShown) {
      publicOriginWarningShown = true;
      console.warn("[config] PUBLIC_URL 无效，已回退为请求 origin", error);
    }
    return requestUrl.origin;
  }
}

export function json(payload: unknown, status = 200, headers: HeadersInit = {}) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/json; charset=utf-8");
  if (!responseHeaders.has("Cache-Control")) responseHeaders.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(payload), { status, headers: responseHeaders });
}

export function jsonError(
  status: number,
  code: string,
  message: string,
  headers: HeadersInit = {},
) {
  return json({ error: { code, message } }, status, headers);
}

export type ReadBodyResult =
  { ok: true; bytes: Uint8Array } | { ok: false; reason: "invalid" | "too-large" };

export async function readBodyBytes(request: Request, maxBytes: number): Promise<ReadBodyResult> {
  const contentLengthHeader = request.headers.get("Content-Length");
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (!Number.isInteger(contentLength) || contentLength < 0)
      return { ok: false, reason: "invalid" };
    if (contentLength > maxBytes) return { ok: false, reason: "too-large" };
  }

  const reader = request.body?.getReader();
  if (!reader) return { ok: true, bytes: new Uint8Array() };
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The request is already being rejected; cancellation failure is not actionable here.
        }
        return { ok: false, reason: "too-large" };
      }
      chunks.push(value);
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, bytes };
  } catch {
    return { ok: false, reason: "invalid" };
  } finally {
    reader.releaseLock();
  }
}

const JSON_CONTENT_TYPE_RE = /^application\/(?:[\w.+-]+\+)?json\s*(?:;.*)?$/iu;

export type ReadJsonResult<T> =
  { ok: true; value: T } | { ok: false; reason: "invalid" | "too-large" };

export function readJsonResult<T>(request: Request, maxBytes: number): Promise<ReadJsonResult<T>> {
  return readJsonResultImpl<T>(request, maxBytes);
}

async function readJsonResultImpl<T>(
  request: Request,
  maxBytes: number,
): Promise<ReadJsonResult<T>> {
  // Reject non-JSON bodies (defence in depth against cross-site form posts).
  // A missing Content-Type is still accepted so existing clients keep working.
  const contentType = request.headers.get("Content-Type")?.trim();
  if (contentType && !JSON_CONTENT_TYPE_RE.test(contentType))
    return { ok: false, reason: "invalid" };
  const body = await readBodyBytes(request, maxBytes);
  if (!body.ok) return body;

  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(body.bytes)) as T };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

export async function readJson<T>(request: Request, maxBytes: number): Promise<T | null> {
  const result = await readJsonResult<T>(request, maxBytes);
  return result.ok ? result.value : null;
}

export function parseSearchTerms(query: string) {
  const parts = query.trim().split(/\s+/).filter(Boolean);
  const tokens: string[] = [];
  const ftsTokens: string[] = [];
  const directTokens: string[] = [];

  for (const part of parts) {
    const cleaned = part.replaceAll('"', "").trim();
    if (!cleaned) continue;
    tokens.push(cleaned);
    if (Array.from(cleaned).length >= 3) {
      ftsTokens.push(cleaned);
    } else {
      directTokens.push(cleaned);
    }
  }

  return { tokens, ftsTokens, directTokens };
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

export const NOTE_SELECT = `
  n.id, n.title, n.content_markdown, n.notebook_id, b.name AS notebook_name,
  b.color AS notebook_color, n.is_favorite, n.deleted_at, n.version, n.created_at, n.updated_at,
  a.id AS thumbnail_asset_id, a.storage_path AS thumbnail_storage_path,
  a.original_name AS thumbnail_original_name, a.mime_type AS thumbnail_mime_type,
  a.byte_size AS thumbnail_byte_size, a.width AS thumbnail_width,
  a.height AS thumbnail_height, a.created_at AS thumbnail_created_at
`;

export const NOTE_LIST_SELECT = `
  n.id, n.title, substr(n.content_markdown, 1, ${NOTE_PREVIEW_SCAN_LIMIT}) AS content_markdown, n.notebook_id, b.name AS notebook_name,
  b.color AS notebook_color, n.is_favorite, n.deleted_at, n.version, n.created_at, n.updated_at,
  COALESCE((SELECT json_group_array(tag) FROM (SELECT tag FROM note_tags WHERE note_id = n.id ORDER BY position)), '[]') AS tags_json,
  a.id AS thumbnail_asset_id, a.storage_path AS thumbnail_storage_path,
  a.original_name AS thumbnail_original_name, a.mime_type AS thumbnail_mime_type,
  a.byte_size AS thumbnail_byte_size, a.width AS thumbnail_width,
  a.height AS thumbnail_height, a.created_at AS thumbnail_created_at
`;

export const NOTE_FROM = `
  notes n
  JOIN notebooks b ON b.id = n.notebook_id AND b.user_id = n.user_id
  LEFT JOIN image_assets a ON a.note_id = n.id AND a.user_id = n.user_id AND a.document_order = 0
`;

export function toNote(row: NoteRow, explicitTags?: string[]): NoteSummary {
  return {
    id: row.id,
    notebookId: row.notebook_id,
    notebookName: row.notebook_name,
    title: row.title,
    preview: formatPreview(row.content_markdown),
    tags: explicitTags ?? extractTags(row.content_markdown),
    thumbnail: thumbnailFromNoteRow(row),
    isFavorite: Boolean(row.is_favorite),
    deletedAt: row.deleted_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toFullNote(row: NoteRow): Note {
  return { ...toNote(row), contentMarkdown: row.content_markdown };
}

export function parseIndexedTags(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((tag): tag is string => typeof tag === "string")
      : [];
  } catch {
    return [];
  }
}

export function syncNoteTags(
  database: SqliteDatabase,
  userId: string,
  noteId: string,
  contentMarkdown: string,
) {
  const seen = new Set<string>();
  const tags: Array<{ normalized: string; tag: string }> = [];
  for (const tag of extractTags(contentMarkdown)) {
    const normalized = normalizeTag(tag);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    tags.push({ normalized, tag });
  }
  const existing = database
    .query(
      "SELECT tag_normalized, tag, position FROM note_tags WHERE note_id = ? AND user_id = ? ORDER BY position",
    )
    .all(noteId, userId) as Array<{ tag_normalized: string; tag: string; position: number }>;
  if (
    existing.length === tags.length &&
    tags.every(
      (tag, index) =>
        existing[index].tag_normalized === tag.normalized &&
        existing[index].tag === tag.tag &&
        existing[index].position === index,
    )
  )
    return;
  database.query("DELETE FROM note_tags WHERE note_id = ? AND user_id = ?").run(noteId, userId);
  const insert = database.query(
    "INSERT INTO note_tags (note_id, user_id, tag_normalized, tag, position) VALUES (?, ?, ?, ?, ?)",
  );
  tags.forEach((tag, position) => insert.run(noteId, userId, tag.normalized, tag.tag, position));
}

export function getNote(database: SqliteDatabase, userId: string, noteId: string) {
  return first<NoteRow>(
    database,
    `
    SELECT ${NOTE_SELECT}
    FROM ${NOTE_FROM}
    WHERE n.id = ? AND n.user_id = ?
  `,
    noteId,
    userId,
  );
}

export type TitleMatchRow = {
  id: string;
  title: string;
  version: number;
  notebook_name: string;
  content_markdown: string;
  created_at: number;
  updated_at: number;
};

// Shared title lookup so the REST and MCP layers cannot drift apart.
export function findNotesByTitlePattern(
  database: SqliteDatabase,
  userId: string,
  title: string,
  includeDeleted = false,
) {
  return all<TitleMatchRow>(
    database,
    `
    SELECT n.id, n.title, n.version, b.name AS notebook_name,
      substr(n.content_markdown, 1, ${NOTE_PREVIEW_SCAN_LIMIT}) AS content_markdown,
      n.created_at, n.updated_at
    FROM notes n JOIN notebooks b ON b.id = n.notebook_id AND b.user_id = n.user_id
    WHERE n.user_id = ? ${includeDeleted ? "" : "AND n.deleted_at IS NULL "}AND n.title LIKE ? ESCAPE '!'
    ORDER BY CASE WHEN n.title = ? COLLATE NOCASE THEN 0 ELSE 1 END, n.updated_at DESC, n.id DESC
    LIMIT 6
  `,
    userId,
    `%${escapeLikePattern(title)}%`,
    title,
  );
}
