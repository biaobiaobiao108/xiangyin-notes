import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { Lexer } from "marked";
import { extractMarkdownDestinationReferences } from "../shared/markdown-lexer";
import { extractTags, normalizeTag } from "../shared/tags";
import type { ImageAssetSummary, Note, NoteSummary, NoteView } from "../shared/types";
import type { RealtimeHub } from "./realtime";
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
export const PASSWORD_ITERATIONS = 100_000;
export const NOTE_PAGE_SIZE = 100;
export const BACKLINK_REFERENCE_LIMIT = 100;
export const BACKLINK_MENTION_LIMIT = 100;
export const BACKLINK_CANDIDATE_LIMIT = 100;
export const BACKLINK_SCAN_CHAR_LIMIT = 8 * 1024 * 1024;
export const NOTE_PREVIEW_LIMIT = 180;
export const NOTE_PREVIEW_SCAN_LIMIT = NOTE_PREVIEW_LIMIT + 64;
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
      iterations: PASSWORD_ITERATIONS,
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
  const hashA = createHash("sha256").update(a).digest();
  const hashB = createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

function normalizedIp(value: string | undefined) {
  const address = value?.trim().toLowerCase() ?? "";
  if (address.startsWith("::ffff:") && isIP(address.slice(7)) === 4) return address.slice(7);
  return isIP(address) ? address : null;
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

  const forwarded = request.headers.get("X-Forwarded-For")?.split(",", 1)[0]?.trim();
  const realIp = request.headers.get("X-Real-IP")?.trim();
  return normalizedIp(forwarded) ?? normalizedIp(realIp) ?? directAddress;
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

export async function readJson<T>(request: Request, maxBytes: number): Promise<T | null> {
  // Reject non-JSON bodies (defence in depth against cross-site form posts).
  // A missing Content-Type is still accepted so existing clients keep working.
  const contentType = request.headers.get("Content-Type")?.trim();
  if (contentType && !JSON_CONTENT_TYPE_RE.test(contentType)) return null;
  const body = await readBodyBytes(request, maxBytes);
  if (!body.ok) return null;

  try {
    return JSON.parse(new TextDecoder().decode(body.bytes)) as T;
  } catch {
    return null;
  }
}

const NON_BREAKING_SPACE_PATTERN = /\u00a0|&nbsp;|&#0*160;|&#[xX]0*[aA]0;/gu;
const SPACE_BEFORE_PUNCTUATION_PATTERN = / ([,.;:!?。！？、，；：])/gu;
const WIKI_LINK_PREVIEW_PATTERN = /\[\[([^\[\]\r\n]*)\]\]|【【([^【】\r\n]*)】】/gu;
const TASK_LIST_ITEM_PATTERN =
  /^(?:[ \t]{0,3}>[ \t]?)*[ \t]*(?:(?:[-+*]|\d+[.)])[ \t]+)?(?:\[[ xX ]?\]|【[ \u3000xX]?】)(?:[ \t]|$)/u;
const CALLOUT_START_PATTERN = /^[ \t]*>[ \t]*\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/iu;
const HORIZONTAL_RULE_PATTERN = /^[ \t]*(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/u;
const TAG_ONLY_LINE_PATTERN = /^[ \t]*#[\p{L}\p{N}_-]+(?:[\t ]+#[\p{L}\p{N}_-]+)*[ \t]*$/u;
const HEADING_PATTERN = /^[ \t]*#{1,6}[ \t\u3000]/u;
const LIST_ITEM_PREFIX_PATTERN = /^[ \t]*(?:[-+*]|\d+[.)])[ \t\u3000]+/u;
const BLOCKQUOTE_PREFIX_PATTERN = /^[ \t]*>[ \t]?/u;

type PreviewInlineToken = {
  type: string;
  raw: string;
  text?: string;
  tokens?: PreviewInlineToken[];
};

/**
 * Flattens a marked inline AST to plain text for note previews.
 * Images contribute nothing (neither alt text nor the asset URL), raw HTML tags
 * are dropped, and markup is reduced to its text content.
 */
function plainTextFromInlineTokens(tokens: PreviewInlineToken[]): string {
  let text = "";
  for (const token of tokens) {
    if (token.type === "image" || token.type === "html") continue;
    const children = token.tokens;
    if (children && children.length > 0) {
      text += plainTextFromInlineTokens(children);
      continue;
    }
    if (token.type === "br") {
      text += " ";
      continue;
    }
    text += token.text ?? token.raw;
  }
  return text;
}

/**
 * Builds the one-line-ish plain text preview shown in note lists.
 *
 * Uses a positive semantic whitelist model: only readable body lines (paragraphs,
 * headings, and bullet/ordered list items) are extracted into previews. All other
 * rich structures (task lists, tables, code blocks, callouts, horizontal rules,
 * tag-only lines) are excluded by default, while scanning line by line so that
 * work stays bounded for long notes.
 */
export function formatPreview(markdown: string) {
  const output: string[] = [];
  let outputLength = 0;
  const paragraph: string[] = [];
  let paragraphLength = 0;
  let codeFence: { marker: "`" | "~"; length: number } | null = null;
  let stopped = false;

  const appendLine = (text: string) => {
    const content = text.trim();
    if (!content) return true;

    const separatorLength = output.length > 0 ? 1 : 0;
    const availableLength = NOTE_PREVIEW_LIMIT - outputLength - separatorLength;
    if (availableLength <= 0) {
      stopped = true;
      return false;
    }

    const clippedContent = content.slice(0, availableLength);
    if (!clippedContent) return true;

    output.push(clippedContent);
    outputLength += separatorLength + clippedContent.length;
    if (clippedContent.length < content.length) {
      stopped = true;
      return false;
    }
    return true;
  };

  const flushParagraph = () => {
    if (paragraphLength === 0) return true;
    const text = paragraph.join("");
    paragraph.length = 0;
    paragraphLength = 0;
    return appendLine(text);
  };

  const readPlainText = (rawText: string, maximumLength: number) => {
    if (maximumLength <= 0 || !rawText) return "";
    const text = plainTextFromInlineTokens(new Lexer({ gfm: true }).inlineTokens(rawText))
      .replace(/^(?:\[[ xX ]?\]|【[ \u3000xX]?】)[ \t\u3000]*/u, "")
      .replace(
        WIKI_LINK_PREVIEW_PATTERN,
        (_match, wiki: string | undefined, fullWidth: string | undefined) => {
          // 双链只显示可读部分：有别名用别名，否则用目标标题。
          const body = wiki ?? fullWidth ?? "";
          const separator = body.search(/[|｜]/u);
          return separator === -1 ? body : body.slice(separator + 1);
        },
      )
      .replace(NON_BREAKING_SPACE_PATTERN, " ")
      .replace(/[ \t]+/gu, " ")
      .replace(SPACE_BEFORE_PUNCTUATION_PATTERN, "$1");
    return (text.length > maximumLength ? text.slice(0, maximumLength) : text).trim();
  };

  const readLine = (start: number, bounded = true) => {
    const newlineIndex = markdown.indexOf("\n", start);
    const fullEnd = newlineIndex === -1 ? markdown.length : newlineIndex;
    const end = bounded ? Math.min(fullEnd, start + NOTE_PREVIEW_SCAN_LIMIT) : fullEnd;
    const contentEnd = end > start && markdown[end - 1] === "\r" ? end - 1 : end;
    return {
      start,
      end: contentEnd,
      next: newlineIndex === -1 ? markdown.length : newlineIndex + 1,
      truncated: end < fullEnd,
    };
  };

  const isTableDelimiter = (line: { start: number; end: number }) => {
    const text = markdown.slice(line.start, line.end);
    if (!text.includes("|") || text.length >= NOTE_PREVIEW_SCAN_LIMIT) return false;
    const cells = text
      .trim()
      .replace(/^\||\|$/gu, "")
      .split("|");
    return cells.length > 0 && cells.every((cell) => /^\s*:?-{1,}:?\s*$/u.test(cell));
  };

  let cursor = 0;
  while (cursor < markdown.length && !stopped) {
    const line = readLine(cursor, !codeFence);
    const lineStr = markdown.slice(line.start, line.end);
    const trimmed = lineStr.trim();

    // 1. 围栏代码块
    const fenceMatch = /^[ \t]{0,3}(`{3,}|~{3,})/u.exec(lineStr);
    if (codeFence) {
      if (
        fenceMatch &&
        fenceMatch[1]![0] === codeFence.marker &&
        fenceMatch[1]!.length >= codeFence.length
      ) {
        codeFence = null;
      }
      cursor = line.truncated ? markdown.length : line.next;
      continue;
    }
    if (fenceMatch) {
      flushParagraph();
      codeFence = { marker: fenceMatch[1]![0] as "`" | "~", length: fenceMatch[1]!.length };
      cursor = line.truncated ? markdown.length : line.next;
      continue;
    }

    // 2. 空行
    if (!trimmed) {
      flushParagraph();
      cursor = line.truncated ? markdown.length : line.next;
      continue;
    }

    // 3. 缩进代码（>= 4 个空格或制表符开头）
    if (/^(?: {4,}|\t)/u.test(lineStr)) {
      flushParagraph();
      cursor = line.truncated ? markdown.length : line.next;
      continue;
    }

    // 4. 富结构黑名单排除（除正向白名单外全部排除）
    // 4.1 表格行（当前行含 | 且下一行为分隔线时跳过整个表格）
    if (
      lineStr.includes("|") &&
      line.next < markdown.length &&
      isTableDelimiter(readLine(line.next))
    ) {
      flushParagraph();
      cursor = readLine(line.next).next;
      while (cursor < markdown.length) {
        const row = readLine(cursor, false);
        if (!markdown.slice(row.start, row.end).includes("|")) break;
        cursor = row.next;
      }
      continue;
    }
    // 4.2 分割线
    if (HORIZONTAL_RULE_PATTERN.test(lineStr)) {
      flushParagraph();
      cursor = line.truncated ? markdown.length : line.next;
      continue;
    }
    // 4.3 纯标签行
    if (TAG_ONLY_LINE_PATTERN.test(lineStr)) {
      flushParagraph();
      cursor = line.truncated ? markdown.length : line.next;
      continue;
    }
    // 4.4 待办任务项
    if (TASK_LIST_ITEM_PATTERN.test(lineStr)) {
      flushParagraph();
      cursor = line.truncated ? markdown.length : line.next;
      continue;
    }
    // 4.5 Callout 提示块，跳过连续引用行
    if (CALLOUT_START_PATTERN.test(lineStr)) {
      flushParagraph();
      cursor = line.next;
      while (cursor < markdown.length) {
        const nextLine = readLine(cursor, false);
        const nextStr = markdown.slice(nextLine.start, nextLine.end);
        if (!/^[ \t]*>/u.test(nextStr)) break;
        cursor = nextLine.next;
      }
      continue;
    }

    // 5. 正向语义白名单提取（标题、普通列表项、普通引用、普通正文）
    const available = NOTE_PREVIEW_LIMIT - outputLength - (output.length > 0 ? 1 : 0);

    // 5.1 标题
    if (HEADING_PATTERN.test(lineStr)) {
      flushParagraph();
      const body = lineStr.replace(/^[ \t]*#{1,6}[ \t\u3000]+/u, "");
      appendLine(readPlainText(body, available));
      cursor = line.truncated ? markdown.length : line.next;
      continue;
    }

    // 5.2 普通列表项（已在 4.4 排除待办复选框）
    if (LIST_ITEM_PREFIX_PATTERN.test(lineStr)) {
      flushParagraph();
      const body = lineStr.replace(LIST_ITEM_PREFIX_PATTERN, "");
      appendLine(readPlainText(body, available));
      cursor = line.truncated ? markdown.length : line.next;
      continue;
    }

    // 5.3 普通引用行
    if (BLOCKQUOTE_PREFIX_PATTERN.test(lineStr)) {
      flushParagraph();
      const body = lineStr.replace(BLOCKQUOTE_PREFIX_PATTERN, "");
      appendLine(readPlainText(body, available));
      cursor = line.truncated ? markdown.length : line.next;
      continue;
    }

    // 5.4 普通正文段落
    const paraAvail = available - paragraphLength - (paragraphLength > 0 ? 1 : 0);
    if (paraAvail <= 0) {
      stopped = true;
      break;
    }
    const text = readPlainText(lineStr, paraAvail);
    if (text) {
      if (paragraphLength > 0) {
        paragraph.push("\n");
        paragraphLength += 1;
      }
      paragraph.push(text);
      paragraphLength += text.length;
      if (paragraphLength >= paraAvail) stopped = true;
    }

    cursor = line.truncated ? markdown.length : line.next;
  }

  flushParagraph();
  return output.join("\n").slice(0, NOTE_PREVIEW_LIMIT);
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
    if (Array.from(cleaned).length >= 3) {
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

export function toImageAsset(
  row: Pick<
    ImageAssetRow,
    "id" | "original_name" | "mime_type" | "byte_size" | "width" | "height" | "created_at"
  >,
): ImageAssetSummary {
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
  if (
    !row.thumbnail_asset_id ||
    !row.thumbnail_original_name ||
    !row.thumbnail_mime_type ||
    row.thumbnail_byte_size === null ||
    row.thumbnail_width === null ||
    row.thumbnail_height === null ||
    row.thumbnail_created_at === null
  )
    return null;
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
    return Array.isArray(parsed)
      ? parsed.filter((tag): tag is string => typeof tag === "string")
      : [];
  } catch {
    return [];
  }
}

export class InvalidNoteAssetsError extends Error {
  constructor() {
    super("invalid-note-assets");
  }
}

export function syncNoteTags(
  database: SqliteDatabase,
  userId: string,
  noteId: string,
  contentMarkdown: string,
) {
  database.query("DELETE FROM note_tags WHERE note_id = ? AND user_id = ?").run(noteId, userId);
  const insert = database.query(
    "INSERT INTO note_tags (note_id, user_id, tag_normalized, tag, position) VALUES (?, ?, ?, ?, ?)",
  );
  const seen = new Set<string>();
  let position = 0;
  for (const tag of extractTags(contentMarkdown)) {
    const normalized = normalizeTag(tag);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    insert.run(noteId, userId, normalized, tag, position++);
  }
}

export const ASSET_REFERENCE_PATTERN =
  /^\/api\/assets\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?=[?#]|$)/iu;
export const PRIVATE_ASSET_SOURCE_PATTERN =
  /^\/api\/assets\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?=[?#]|$)/iu;

function extractNoteAssetReferences(markdown: string) {
  const imageSources: string[] = [];
  const assetIds = new Set<string>();
  const imageAssetIds = new Set<string>();

  for (const reference of extractMarkdownDestinationReferences(markdown)) {
    if (reference.type === "image") imageSources.push(reference.destination);
    const id = ASSET_REFERENCE_PATTERN.exec(reference.destination)?.[1]?.toLowerCase();
    if (id) {
      assetIds.add(id);
      if (reference.type === "image") imageAssetIds.add(id);
    }
  }

  return { imageSources, assetIds: [...assetIds], imageAssetIds: [...imageAssetIds] };
}

export function noteImageSources(markdown: string) {
  return extractNoteAssetReferences(markdown).imageSources;
}

export function noteAssetIds(markdown: string) {
  return extractNoteAssetReferences(markdown).assetIds;
}

export function validNoteImageSource(source: string) {
  if (PRIVATE_ASSET_SOURCE_PATTERN.test(source)) return true;
  try {
    const url = new URL(source);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function validNoteAssetReferences(
  database: SqliteDatabase,
  userId: string,
  noteId: string | null,
  contentMarkdown: string,
) {
  const references = extractNoteAssetReferences(contentMarkdown);
  if (references.imageSources.some((source) => !validNoteImageSource(source))) return false;
  const ids = references.assetIds;
  if (!ids.length) return true;
  const assets = all<Pick<ImageAssetRow, "id" | "note_id">>(
    database,
    `SELECT id, note_id FROM image_assets WHERE user_id = ? AND id IN (${ids.map(() => "?").join(",")})`,
    userId,
    ...ids,
  );
  const assetsById = new Map(assets.map((asset) => [asset.id.toLowerCase(), asset]));
  return (
    assets.length === ids.length &&
    ids.every((id) => {
      const asset = assetsById.get(id);
      return Boolean(asset) && (asset?.note_id === null || asset?.note_id === noteId);
    })
  );
}

export function syncNoteAssetReferences(
  database: SqliteDatabase,
  userId: string,
  noteId: string,
  contentMarkdown: string,
) {
  const references = extractNoteAssetReferences(contentMarkdown);
  const ids = references.assetIds;
  const imageDocumentOrder = new Map(references.imageAssetIds.map((id, index) => [id, index]));
  const detachedAssetCondition = ids.length
    ? `id NOT IN (${ids.map(() => "?").join(",")})`
    : "1 = 1";
  database
    .query(
      `
    UPDATE image_assets
    SET note_id = NULL, document_order = NULL
    WHERE note_id = ?
      AND user_id = ?
      AND ${detachedAssetCondition}
  `,
    )
    .run(noteId, userId, ...ids);
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

  database
    .query("UPDATE image_assets SET document_order = NULL WHERE note_id = ? AND user_id = ?")
    .run(noteId, userId);
  for (const id of ids) {
    database
      .query("UPDATE image_assets SET note_id = ?, document_order = ? WHERE id = ? AND user_id = ?")
      .run(noteId, imageDocumentOrder.get(id) ?? null, id, userId);
  }
  return true;
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
    FROM notes n JOIN notebooks b ON b.id = n.notebook_id
    WHERE n.user_id = ? ${includeDeleted ? "" : "AND n.deleted_at IS NULL "}AND n.title LIKE ? ESCAPE '!'
    ORDER BY CASE WHEN n.title = ? COLLATE NOCASE THEN 0 ELSE 1 END, n.updated_at DESC, n.id DESC
    LIMIT 6
  `,
    userId,
    `%${escapeLikePattern(title)}%`,
    title,
  );
}
