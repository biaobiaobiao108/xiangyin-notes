import { rm } from "node:fs/promises";
import { join } from "node:path";
import { extractTags, normalizeTag } from "../shared/tags";
import type { ImageAssetSummary, Note, NoteSummary, NoteView, Share } from "../shared/types";
import type { SqliteDatabase } from "./db";

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
};

export type AuthCredentials = {
  username: string;
  password: string;
};

export type UserRow = {
  id: string;
  username: string;
};

export type SessionRow = {
  token_hash: string;
  user_id: string;
  created_at: number;
  expires_at: number;
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

export type ShareRow = {
  id: string;
  note_id: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  snapshot_title: string;
  snapshot_content_markdown: string;
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
export const SHARE_TTL = 60 * 60 * 24 * 7;
export const PASSWORD_ITERATIONS = 100_000;
export const NOTE_PAGE_SIZE = 100;
export const BACKLINK_REFERENCE_LIMIT = 100;
export const BACKLINK_MENTION_LIMIT = 100;
export const BACKLINK_CANDIDATE_LIMIT = 100;
export const BACKLINK_SCAN_CHAR_LIMIT = 8 * 1024 * 1024;
export const NOTE_PREVIEW_LIMIT = 180;
export const NOTE_PREVIEW_SCAN_LIMIT = NOTE_PREVIEW_LIMIT + 64;
export const NOTE_BODY_MAX_BYTES = 4_500_000;
export const LOGIN_WINDOW_SECONDS = 15 * 60;
export const LOGIN_MAX_FAILURES = 8;
export const LOGIN_BLOCK_SECONDS = 15 * 60;
export const LOGIN_ATTEMPT_MAX_ENTRIES = 2_000;
export const LOGIN_ATTEMPT_CLEANUP_INTERVAL_SECONDS = 60;
export const SESSION_CLEANUP_INTERVAL_SECONDS = 60;
export const ORPHAN_ASSET_TTL_SECONDS = 24 * 60 * 60;
export const ORPHAN_ASSET_CLEANUP_INTERVAL_SECONDS = 60;
export const NOTE_VIEWS: NoteView[] = ["all", "inbox", "favorites", "shared", "trash"];

export const welcomeMarkdown = "## 欢迎来到象映笔记\n\n这是你的第一个笔记。按下 **Ctrl /** 可以打开命令菜单，开始记录你的想法。\n\n- 写下值得保留的东西\n- 用笔记本整理上下文\n- 随时生成一个 7 天有效的只读分享\n";

export const loginAttempts = new Map<string, RateLimitEntry>();

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

export async function derivePassword(password: string, saltHex: string) {
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
      iterations: 100_000,
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
  return { hash, salt };
}

export function constantTimeEqual(a: string, b: string) {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return crypto.timingSafeEqual(bufferA, bufferB);
}

export function clientIdentifier(request: Request, clientAddress?: string) {
  if (clientAddress?.trim()) return clientAddress.trim();
  const cfConnectingIp = request.headers.get("cf-connecting-ip")?.trim();
  if (cfConnectingIp) return cfConnectingIp;
  const xRealIp = request.headers.get("x-real-ip")?.trim();
  if (xRealIp) return xRealIp;
  return "local-client";
}

export function consumeRateLimit(key: string, limit: number, windowMs: number) {
  const currentTime = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || entry.resetAt <= currentTime) {
    loginAttempts.set(key, { count: 1, resetAt: currentTime + windowMs });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count += 1;
  return true;
}

export function isSecureRequest(request: Request, environment: Record<string, string | undefined> = {}) {
  const configured = environment.COOKIE_SECURE?.trim().toLowerCase();
  if (configured === "true") return true;
  if (configured === "false") return false;
  return new URL(request.url).protocol === "https:";
}

export function cookieHeader(token: string, isSecure: boolean) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL}`,
  ];
  if (isSecure) parts.push("Secure");
  return parts.join("; ");
}

export function clearCookieHeader(isSecure: boolean) {
  const parts = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (isSecure) parts.push("Secure");
  return parts.join("; ");
}

export function getPublicOrigin(requestUrl: URL, environment: Record<string, string | undefined> = {}) {
  const configuredUrl = environment.PUBLIC_URL?.trim();
  if (!configuredUrl) return requestUrl.origin;
  const publicUrl = new URL(configuredUrl);
  if (publicUrl.protocol !== "http:" && publicUrl.protocol !== "https:") throw new Error("PUBLIC_URL must use http or https");
  return publicUrl.origin;
}

export function json(payload: unknown, status = 200, headers: HeadersInit = {}) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/json; charset=utf-8");
  if (!responseHeaders.has("Cache-Control")) responseHeaders.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(payload), { status, headers: responseHeaders });
}

export function jsonError(status: number, code: string, message: string, headers: HeadersInit = {}) {
  return json({ error: { code, message } }, status, headers);
}

export async function readJson<T>(request: Request, maxBytes: number): Promise<T | null> {
  const contentLengthHeader = request.headers.get("Content-Length");
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (!Number.isInteger(contentLength) || contentLength < 0 || contentLength > maxBytes) return null;
  }

  const reader = request.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel();
        return null;
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }

  const raw = parts.join("");

  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function authenticateRequest(
  request: Request,
  database: SqliteDatabase,
  environment: Record<string, string | undefined> = {},
  clientAddress?: string,
): Promise<UserRow | null> {
  const cookie = request.headers.get("Cookie");
  if (!cookie) return null;

  const sessionMatch = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  const token = sessionMatch?.[1];
  if (!token) return null;

  const tokenHash = await digestHex(token);
  const currentTime = now();
  const session = first<SessionRow>(
    database,
    "SELECT user_id, expires_at FROM sessions WHERE token_hash = ? AND expires_at > ?",
    tokenHash,
    currentTime,
  );
  if (!session) return null;

  const user = first<UserRow>(database, "SELECT id, username FROM users WHERE id = ?", session.user_id);
  if (!user) return null;

  if (session.expires_at - currentTime < SESSION_TTL / 2) {
    database.query("UPDATE sessions SET expires_at = ? WHERE token_hash = ?").run(currentTime + SESSION_TTL, tokenHash);
  }

  return user;
}

export function formatPreview(markdown: string) {
  const output: string[] = [];
  let outputLength = 0;
  let inCodeFence = false;
  let pendingWhitespace = false;

  for (let index = 0; index < markdown.length && outputLength < NOTE_PREVIEW_LIMIT; index += 1) {
    if (
      (index === 0 || markdown[index - 1] === "\n") &&
      markdown.startsWith("```", index)
    ) {
      inCodeFence = !inCodeFence;
      const nextLine = markdown.indexOf("\n", index);
      index = nextLine === -1 ? markdown.length : nextLine;
      pendingWhitespace = true;
      continue;
    }

    if (inCodeFence) continue;

    if (markdown.startsWith("![", index)) {
      const closeBracket = markdown.indexOf("]", index + 2);
      if (closeBracket !== -1 && markdown[closeBracket + 1] === "(") {
        const closeParen = markdown.indexOf(")", closeBracket + 2);
        if (closeParen !== -1) {
          index = closeParen;
          pendingWhitespace = true;
          continue;
        }
      }
    }

    const character = markdown[index];
    if (character === "\r" || character === "\n" || character === "\t" || character === " ") {
      pendingWhitespace = outputLength > 0;
      continue;
    }

    if (
      character === "#" ||
      character === "*" ||
      character === "_" ||
      character === "`" ||
      character === "~" ||
      character === ">" ||
      character === "[" ||
      character === "]"
    ) {
      continue;
    }

    if (pendingWhitespace) {
      output.push(" ");
      outputLength += 1;
      if (outputLength >= NOTE_PREVIEW_LIMIT) break;
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

export function assetUrl(id: string) {
  return `/api/assets/${encodeURIComponent(id)}`;
}

export function toImageAsset(row: Pick<ImageAssetRow, "id" | "original_name" | "mime_type" | "byte_size" | "width" | "height" | "created_at">): ImageAssetSummary {
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

export function thumbnailFromNoteRow(row: NoteRow): ImageAssetSummary | null {
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
  JOIN notebooks b ON b.id = n.notebook_id
  LEFT JOIN image_assets a ON a.note_id = n.id AND a.document_order = 0
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
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === "string") : [];
  } catch {
    return [];
  }
}

export function toShare(row: { id: string; note_id: string; created_at: number; expires_at: number; revoked_at: number | null }): Share {
  return {
    id: row.id,
    noteId: row.note_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

export class InvalidNoteAssetsError extends Error {
  constructor() {
    super("invalid-note-assets");
  }
}

export function syncNoteTags(database: SqliteDatabase, userId: string, noteId: string, contentMarkdown: string) {
  database.query("DELETE FROM note_tags WHERE note_id = ? AND user_id = ?").run(noteId, userId);
  const insert = database.query("INSERT INTO note_tags (note_id, user_id, tag_normalized, tag, position) VALUES (?, ?, ?, ?, ?)");
  const seen = new Set<string>();
  let position = 0;
  for (const tag of extractTags(contentMarkdown)) {
    const normalized = normalizeTag(tag);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    insert.run(noteId, userId, normalized, tag, position++);
  }
}

export const ASSET_REFERENCE_PATTERN = /\/api\/assets\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?=[?#)\s]|$)/giu;
export const MARKDOWN_IMAGE_SOURCE_PATTERN = /!\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/gu;
export const PRIVATE_ASSET_SOURCE_PATTERN = /^\/api\/assets\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?=[?#]|$)/iu;

export function noteImageSources(markdown: string) {
  const sources: string[] = [];
  for (const match of markdown.matchAll(MARKDOWN_IMAGE_SOURCE_PATTERN)) {
    if (match[1]) sources.push(match[1]);
  }
  return sources;
}

export function noteAssetIds(markdown: string) {
  const ids = new Set<string>();
  for (const match of markdown.matchAll(ASSET_REFERENCE_PATTERN)) {
    if (match[1]) ids.add(match[1].toLowerCase());
  }
  return [...ids];
}

export function validNoteAssetReferences(
  database: SqliteDatabase,
  userId: string,
  noteId: string | null,
  contentMarkdown: string,
) {
  if (noteImageSources(contentMarkdown).some((source) => !PRIVATE_ASSET_SOURCE_PATTERN.test(source))) return false;
  const ids = noteAssetIds(contentMarkdown);
  if (!ids.length) return true;
  const assets = all<Pick<ImageAssetRow, "id" | "note_id">>(
    database,
    `SELECT id, note_id FROM image_assets WHERE user_id = ? AND id IN (${ids.map(() => "?").join(",")})`,
    userId,
    ...ids,
  );
  const assetsById = new Map(assets.map((asset) => [asset.id.toLowerCase(), asset]));
  return assets.length === ids.length && ids.every((id) => {
    const asset = assetsById.get(id);
    return Boolean(asset) && (asset?.note_id === null || asset?.note_id === noteId);
  });
}

export function syncNoteAssetReferences(
  database: SqliteDatabase,
  userId: string,
  noteId: string,
  contentMarkdown: string,
) {
  const ids = noteAssetIds(contentMarkdown);
  const detachedAssetCondition = ids.length ? `id NOT IN (${ids.map(() => "?").join(",")})` : "1 = 1";
  database.query(`
    UPDATE image_assets
    SET note_id = NULL, document_order = NULL
    WHERE note_id = ?
      AND ${detachedAssetCondition}
      AND NOT EXISTS (
        SELECT 1
        FROM shares s
        WHERE s.note_id = image_assets.note_id
          AND s.revoked_at IS NULL
          AND s.expires_at > ?
          AND instr(s.snapshot_content_markdown, image_assets.id) > 0
      )
  `).run(noteId, ...ids, now());
  const assets = ids.length
    ? all<ImageAssetRow>(
        database,
        `SELECT id, user_id, note_id, storage_path, original_name, mime_type, byte_size, width, height, document_order, created_at FROM image_assets WHERE user_id = ? AND id IN (${ids.map(() => "?").join(",")})`,
        userId,
        ...ids,
      )
    : [];
  const assetsById = new Map(assets.map((asset) => [asset.id.toLowerCase(), asset]));
  if (
    assets.length !== ids.length ||
    ids.some((id) => {
      const asset = assetsById.get(id);
      return !asset || (asset.note_id !== null && asset.note_id !== noteId);
    })
  ) {
    return false;
  }

  database.query("UPDATE image_assets SET document_order = NULL WHERE note_id = ?").run(noteId);
  for (const [documentOrder, id] of ids.entries()) {
    database.query("UPDATE image_assets SET note_id = ?, document_order = ? WHERE id = ? AND user_id = ?").run(noteId, documentOrder, id, userId);
  }
  return true;
}

export function rewriteAssetUrlsForShare(markdown: string, token: string) {
  ASSET_REFERENCE_PATTERN.lastIndex = 0;
  return markdown.replace(ASSET_REFERENCE_PATTERN, (_match, id: string) => `/api/share-assets/${token}/${id}`);
}

export function getNote(database: SqliteDatabase, userId: string, noteId: string) {
  return first<NoteRow>(database, `
    SELECT ${NOTE_SELECT}
    FROM ${NOTE_FROM}
    WHERE n.id = ? AND n.user_id = ?
  `, noteId, userId);
}
