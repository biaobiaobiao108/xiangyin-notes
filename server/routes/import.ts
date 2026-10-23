import {
  digestHex,
  first,
  getNote,
  json,
  jsonError,
  NOTE_BODY_MAX_BYTES,
  NOTE_CONTENT_MAX_LENGTH,
  now,
  readBodyBytes,
  rateLimitClientAddress,
  type RouteContext,
  type SqliteDatabase,
  toNote,
  validNoteAssetReferences,
  validText,
} from "../core";
import { requireApiToken } from "../api-token";
import { cleanupExpiredRateLimits, getAuthCredentials, ensureEnvironmentUser } from "./auth";
import { createNote } from "./notes";
import { publishWorkspaceChange } from "../realtime";

const IMPORT_API_PATH = "/api/import";
export const IMPORT_RATE_LIMIT_WINDOW_SECONDS = 60;
export const IMPORT_RATE_LIMIT_MAX_REQUESTS = 30;

function importClientKey(
  request: Request,
  environment: Record<string, string | undefined>,
  clientAddress: string | undefined,
) {
  const address = rateLimitClientAddress(request, environment, clientAddress);
  return address.slice(0, 128) || "unknown";
}

export function checkImportRateLimit(
  database: SqliteDatabase,
  request: Request,
  environment: Record<string, string | undefined>,
  clientAddress: string | undefined,
) {
  const key = importClientKey(request, environment, clientAddress);
  const timestamp = now();
  cleanupExpiredRateLimits(database, timestamp);

  const blocked = database.transaction((): { retryAfter: number } | null => {
    const row = database
      .query(
        "SELECT points, window_started_at FROM rate_limits WHERE action = 'import' AND key = ?",
      )
      .get(key) as { points: number; window_started_at: number } | null | undefined;

    if (!row || timestamp - row.window_started_at >= IMPORT_RATE_LIMIT_WINDOW_SECONDS) {
      database
        .query(
          `
        INSERT INTO rate_limits (action, key, points, window_started_at, blocked_until, updated_at)
        VALUES ('import', ?, 1, ?, 0, ?)
        ON CONFLICT(action, key) DO UPDATE SET
          points = 1,
          window_started_at = excluded.window_started_at,
          blocked_until = 0,
          updated_at = excluded.updated_at
      `,
        )
        .run(key, timestamp, timestamp);
      return null;
    }

    if (row.points >= IMPORT_RATE_LIMIT_MAX_REQUESTS) {
      const retryAfter = Math.max(
        1,
        row.window_started_at + IMPORT_RATE_LIMIT_WINDOW_SECONDS - timestamp,
      );
      return { retryAfter };
    }

    database
      .query(
        "UPDATE rate_limits SET points = points + 1, updated_at = ? WHERE action = 'import' AND key = ?",
      )
      .run(timestamp, key);
    return null;
  })();

  if (blocked) {
    return jsonError(429, "TOO_MANY_IMPORTS", "导入请求过于频繁，请稍后再试", {
      "Retry-After": String(blocked.retryAfter),
    });
  }
  return null;
}

type ReadTextBodyResult =
  { ok: true; text: string } | { ok: false; reason: "invalid" | "too-large" };

async function readTextBody(request: Request, maxBytes: number): Promise<ReadTextBodyResult> {
  const body = await readBodyBytes(request, maxBytes);
  if (!body.ok) return body;
  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(body.bytes) };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

const NOTE_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/**
 * Same Idempotency-Key must produce the same note id, and the result must satisfy
 * the UUID contract every other note id follows.
 */
async function deterministicImportNoteId(userId: string, idempotencyKey: string) {
  const hex = await digestHex(`xiangying-import:${userId}:${idempotencyKey}`);
  const variant = ((Number.parseInt(hex[16]!, 16) & 0b0011) | 0b1000).toString(16);
  const noteId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  if (!NOTE_UUID_PATTERN.test(noteId)) throw new Error("deterministic import id is not a UUID");
  return noteId;
}

function replayIdempotentImport(
  database: RouteContext["options"]["database"],
  userId: string,
  noteId: string,
  contentMarkdown: string,
) {
  const existing = getNote(database, userId, noteId);
  if (!existing) return null;
  if (existing.content_markdown !== contentMarkdown)
    return jsonError(409, "IDEMPOTENCY_CONFLICT", "Idempotency-Key 已用于其他笔记内容");
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
  if (method !== "POST")
    return jsonError(405, "METHOD_NOT_ALLOWED", "导入接口只支持 POST", { Allow: "POST" });

  const environment = options.environment ?? {};
  const tokenError = requireApiToken(request, environment, "xiangying-import");
  if (tokenError) return tokenError;
  const rateLimitError = checkImportRateLimit(
    options.database,
    request,
    environment,
    options.clientAddress,
  );
  if (rateLimitError) return rateLimitError;

  const credentials = getAuthCredentials(environment);
  if (!credentials)
    return jsonError(
      503,
      "AUTH_NOT_CONFIGURED",
      "请先配置 XIANGYING_USERNAME 和 XIANGYING_PASSWORD",
    );

  const mediaType = (request.headers.get("Content-Type") ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  const isJson = mediaType === "application/json";
  const isMarkdown =
    mediaType === "text/markdown" || mediaType === "text/plain" || mediaType === "";
  if (!isJson && !isMarkdown)
    return jsonError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "只支持 application/json、text/markdown 或 text/plain",
    );

  const idempotencyKey = request.headers.get("Idempotency-Key")?.trim() || null;
  if (idempotencyKey && (idempotencyKey.length > 128 || !/^[\x21-\x7E]+$/u.test(idempotencyKey))) {
    return jsonError(
      400,
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency-Key 只能包含 128 个以内的可见 ASCII 字符",
    );
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

  if (!validText(contentMarkdown, NOTE_CONTENT_MAX_LENGTH))
    return jsonError(413, "NOTE_TOO_LARGE", "笔记正文超过 1000000 个字符限制");
  if (!contentMarkdown.trim()) return jsonError(400, "EMPTY_NOTE", "笔记正文不能为空");

  const user = await ensureEnvironmentUser(options.database, credentials);
  const inbox = first<{ id: string }>(
    options.database,
    "SELECT id FROM notebooks WHERE user_id = ? AND is_system = 1 LIMIT 1",
    user.id,
  );
  if (!inbox) return jsonError(500, "NO_INBOX", "找不到收件箱");
  const requestedId = idempotencyKey
    ? await deterministicImportNoteId(user.id, idempotencyKey)
    : undefined;
  if (requestedId) {
    const replay = replayIdempotentImport(options.database, user.id, requestedId, contentMarkdown);
    if (replay) return replay;
  }
  // A replay's attachments are already bound to the original note. Validate
  // unattached assets only when this request is actually creating a new note.
  if (!validNoteAssetReferences(options.database, user.id, null, contentMarkdown))
    return jsonError(400, "INVALID_ASSET", "图片引用无效、不受支持或附件当前不可用");

  let noteId: string;
  try {
    noteId = createNote(
      options.database,
      user.id,
      inbox.id,
      formatImportTitle(Math.floor(Date.now() / 1000)),
      contentMarkdown,
      requestedId,
    );
  } catch (error) {
    if (requestedId) {
      const replay = replayIdempotentImport(
        options.database,
        user.id,
        requestedId,
        contentMarkdown,
      );
      if (replay) return replay;
    }
    if (error instanceof Error && error.message === "invalid-note-assets")
      return jsonError(400, "INVALID_ASSET", "图片引用无效、不受支持或附件当前不可用");
    throw error;
  }
  const note = getNote(options.database, user.id, noteId);
  // 导入会新增笔记，广播不带 noteId，让其他客户端整表刷新。
  publishWorkspaceChange(options, user.id, { resource: "notes" }, request);
  return json({ ok: true, note: note ? toNote(note) : null }, 201);
}
