import {
  constantTimeEqual,
  digestHex,
  first,
  getNote,
  json,
  jsonError,
  NOTE_BODY_MAX_BYTES,
  NOTE_CONTENT_MAX_LENGTH,
  now,
  readBodyBytes,
  type RouteContext,
  toNote,
  validNoteAssetReferences,
  validText,
} from "../core";
import { getAuthCredentials, ensureEnvironmentUser } from "./auth";
import { createNote } from "./notes";

const IMPORT_API_PATH = "/api/import";
export const IMPORT_RATE_LIMIT_WINDOW_SECONDS = 60;
export const IMPORT_RATE_LIMIT_MAX_REQUESTS = 30;
const IMPORT_RATE_LIMIT_MAX_ENTRIES = 2_000;

type ImportRateLimitEntry = {
  windowStartedAt: number;
  requests: number;
};

const importRateLimits = new Map<string, ImportRateLimitEntry>();
let nextImportRateLimitCleanupAt = 0;

function getApiToken(environment: Record<string, string | undefined>) {
  const token = environment.XIANGYING_API_TOKEN?.trim();
  return token || null;
}

function bearerToken(request: Request) {
  const header = request.headers.get("Authorization")?.trim();
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/iu.exec(header);
  return match?.[1] ?? null;
}

function requireApiToken(request: Request, environment: Record<string, string | undefined>) {
  const expectedToken = getApiToken(environment);
  if (!expectedToken) return jsonError(503, "API_AUTH_NOT_CONFIGURED", "请先配置 XIANGYING_API_TOKEN");

  const suppliedToken = bearerToken(request);
  if (!suppliedToken || !constantTimeEqual(suppliedToken, expectedToken)) {
    return jsonError(401, "INVALID_API_TOKEN", "API Token 无效或缺失", {
      "WWW-Authenticate": 'Bearer realm="xiangying-import"',
    });
  }
  return null;
}

function importClientKey(request: Request, environment: Record<string, string | undefined>, clientAddress: string | undefined) {
  let address = clientAddress?.trim() || "unknown";
  if (environment.TRUST_PROXY === "true") {
    const forwarded = request.headers.get("X-Forwarded-For")?.split(",", 1)[0]?.trim();
    address = forwarded || request.headers.get("X-Real-IP")?.trim() || address;
  }
  return address.slice(0, 128) || "unknown";
}

function checkImportRateLimit(request: Request, environment: Record<string, string | undefined>, clientAddress: string | undefined) {
  const timestamp = now();
  if (timestamp >= nextImportRateLimitCleanupAt) {
    for (const [key, entry] of importRateLimits) {
      if (timestamp - entry.windowStartedAt >= IMPORT_RATE_LIMIT_WINDOW_SECONDS) importRateLimits.delete(key);
    }
    nextImportRateLimitCleanupAt = timestamp + IMPORT_RATE_LIMIT_WINDOW_SECONDS;
  }

  const key = importClientKey(request, environment, clientAddress);
  let entry = importRateLimits.get(key);
  if (!entry || timestamp - entry.windowStartedAt >= IMPORT_RATE_LIMIT_WINDOW_SECONDS) {
    if (!entry && importRateLimits.size >= IMPORT_RATE_LIMIT_MAX_ENTRIES) {
      const oldestKey = importRateLimits.keys().next().value as string | undefined;
      if (oldestKey) importRateLimits.delete(oldestKey);
    }
    entry = { windowStartedAt: timestamp, requests: 0 };
    importRateLimits.set(key, entry);
  }

  if (entry.requests >= IMPORT_RATE_LIMIT_MAX_REQUESTS) {
    const retryAfter = Math.max(1, entry.windowStartedAt + IMPORT_RATE_LIMIT_WINDOW_SECONDS - timestamp);
    return jsonError(429, "TOO_MANY_IMPORTS", "导入请求过于频繁，请稍后再试", { "Retry-After": String(retryAfter) });
  }
  entry.requests += 1;
  return null;
}

type ReadTextBodyResult =
  | { ok: true; text: string }
  | { ok: false; reason: "invalid" | "too-large" };

async function readTextBody(request: Request, maxBytes: number): Promise<ReadTextBodyResult> {
  const body = await readBodyBytes(request, maxBytes);
  if (!body.ok) return body;
  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(body.bytes) };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

async function deterministicImportNoteId(userId: string, idempotencyKey: string) {
  return `import-${await digestHex(`xiangying-import:${userId}:${idempotencyKey}`)}`;
}

function replayIdempotentImport(database: RouteContext["options"]["database"], userId: string, noteId: string, contentMarkdown: string) {
  const existing = getNote(database, userId, noteId);
  if (!existing) return null;
  if (existing.content_markdown !== contentMarkdown) return jsonError(409, "IDEMPOTENCY_CONFLICT", "Idempotency-Key 已用于其他笔记内容");
  return json({ ok: true, note: toNote(existing) }, 200, { "Idempotent-Replayed": "true" });
}

function formatImportTitle(timestamp: number) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp * 1000));
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `快捷导入 ${value("year")}-${value("month")}-${value("day")} ${value("hour")}:${value("minute")}:${value("second")}`;
}

export async function handleImportRoute(ctx: RouteContext): Promise<Response | null> {
  const { request, url, method, options } = ctx;
  if (url.pathname !== IMPORT_API_PATH) return null;
  if (method !== "POST") return jsonError(405, "METHOD_NOT_ALLOWED", "导入接口只支持 POST", { Allow: "POST" });

  const environment = options.environment ?? {};
  const tokenError = requireApiToken(request, environment);
  if (tokenError) return tokenError;
  const rateLimitError = checkImportRateLimit(request, environment, options.clientAddress);
  if (rateLimitError) return rateLimitError;

  const credentials = getAuthCredentials(environment);
  if (!credentials) return jsonError(503, "AUTH_NOT_CONFIGURED", "请先配置 XIANGYING_USERNAME 和 XIANGYING_PASSWORD");

  const mediaType = (request.headers.get("Content-Type") ?? "").split(";", 1)[0].trim().toLowerCase();
  const isJson = mediaType === "application/json";
  const isMarkdown = mediaType === "text/markdown" || mediaType === "text/plain" || mediaType === "";
  if (!isJson && !isMarkdown) return jsonError(415, "UNSUPPORTED_MEDIA_TYPE", "只支持 application/json、text/markdown 或 text/plain");

  const idempotencyKey = request.headers.get("Idempotency-Key")?.trim() || null;
  if (idempotencyKey && (idempotencyKey.length > 128 || !/^[\x21-\x7E]+$/u.test(idempotencyKey))) {
    return jsonError(400, "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key 只能包含 128 个以内的可见 ASCII 字符");
  }

  const body = await readTextBody(request, NOTE_BODY_MAX_BYTES);
  if (!body.ok) {
    return body.reason === "too-large"
      ? jsonError(413, "NOTE_TOO_LARGE", "笔记正文超过大小限制")
      : jsonError(400, "INVALID_REQUEST_BODY", "请求体不是有效的 UTF-8 文本");
  }

  let contentMarkdown: string;
  if (isJson) {
    try {
      const payload = JSON.parse(body.text) as { contentMarkdown?: unknown } | null;
      if (!payload || typeof payload !== "object" || typeof payload.contentMarkdown !== "string") {
        return jsonError(400, "INVALID_IMPORT_PAYLOAD", "请求体必须包含字符串字段 contentMarkdown");
      }
      contentMarkdown = payload.contentMarkdown;
    } catch {
      return jsonError(400, "INVALID_JSON", "请求体不是有效的 JSON");
    }
  } else {
    contentMarkdown = body.text;
  }

  if (!validText(contentMarkdown, NOTE_CONTENT_MAX_LENGTH)) return jsonError(413, "NOTE_TOO_LARGE", "笔记正文超过 1000000 个字符限制");
  if (!contentMarkdown.trim()) return jsonError(400, "EMPTY_NOTE", "笔记正文不能为空");

  const user = await ensureEnvironmentUser(options.database, credentials);
  const inbox = first<{ id: string }>(options.database, "SELECT id FROM notebooks WHERE user_id = ? AND is_system = 1 LIMIT 1", user.id);
  if (!inbox) return jsonError(500, "NO_INBOX", "找不到收件箱");
  if (!validNoteAssetReferences(options.database, user.id, null, contentMarkdown)) return jsonError(400, "INVALID_ASSET", "笔记包含不支持的图片地址或无权访问的图片");

  const requestedId = idempotencyKey ? await deterministicImportNoteId(user.id, idempotencyKey) : undefined;
  if (requestedId) {
    const replay = replayIdempotentImport(options.database, user.id, requestedId, contentMarkdown);
    if (replay) return replay;
  }

  let noteId: string;
  try {
    noteId = createNote(options.database, user.id, inbox.id, formatImportTitle(Math.floor(Date.now() / 1000)), contentMarkdown, requestedId);
  } catch (error) {
    if (requestedId) {
      const replay = replayIdempotentImport(options.database, user.id, requestedId, contentMarkdown);
      if (replay) return replay;
    }
    if (error instanceof Error && error.message === "invalid-note-assets") return jsonError(400, "INVALID_ASSET", "笔记包含不支持的图片地址或无权访问的图片");
    throw error;
  }
  const note = getNote(options.database, user.id, noteId);
  return json({ ok: true, note: note ? toNote(note) : null }, 201);
}
