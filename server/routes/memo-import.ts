import {
  first,
  json,
  jsonError,
  NOTE_BODY_MAX_BYTES,
  now,
  rateLimitClientAddress,
  readBodyBytes,
  type RouteContext,
  type SqliteDatabase,
} from "../core";
import { cleanupExpiredRateLimits, ensureEnvironmentUser, getAuthCredentials } from "./auth";
import { requireApiToken } from "../api-token";
import { publishWorkspaceChange } from "../realtime";
import {
  deletedImport,
  getImportRequest,
  importConflict,
  importContentHash,
  recordImportRequest,
} from "../import-idempotency";
import {
  createMemo,
  getMemo,
  invalidMemoAsset,
  memoContentError,
  memoFromRow,
  memoHasMissingNewAssets,
  validateMemoCreatedAtPayload,
} from "./memo-shared";

export const MEMO_IMPORT_RATE_LIMIT_WINDOW_SECONDS = 60;
export const MEMO_IMPORT_RATE_LIMIT_MAX_REQUESTS = 120;

const MEMO_IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,128}$/u;

function importRateLimit(
  database: SqliteDatabase,
  request: Request,
  environment: Record<string, string | undefined>,
  clientAddress: string | undefined,
) {
  const key =
    rateLimitClientAddress(request, environment, clientAddress).slice(0, 128) || "unknown";
  const timestamp = now();
  cleanupExpiredRateLimits(database, timestamp);
  const blocked = database
    .transaction(() => {
      const row = first<{ points: number; window_started_at: number }>(
        database,
        "SELECT points, window_started_at FROM rate_limits WHERE action = 'memo-import' AND key = ?",
        key,
      );
      if (!row || timestamp - row.window_started_at >= MEMO_IMPORT_RATE_LIMIT_WINDOW_SECONDS) {
        database
          .query(
            `INSERT INTO rate_limits (action, key, points, window_started_at, blocked_until, updated_at)
             VALUES ('memo-import', ?, 1, ?, 0, ?)
             ON CONFLICT(action, key) DO UPDATE SET points = 1, window_started_at = excluded.window_started_at, blocked_until = 0, updated_at = excluded.updated_at`,
          )
          .run(key, timestamp, timestamp);
        return null;
      }
      if (row.points >= MEMO_IMPORT_RATE_LIMIT_MAX_REQUESTS) {
        return Math.max(
          1,
          row.window_started_at + MEMO_IMPORT_RATE_LIMIT_WINDOW_SECONDS - timestamp,
        );
      }
      database
        .query(
          "UPDATE rate_limits SET points = points + 1, updated_at = ? WHERE action = 'memo-import' AND key = ?",
        )
        .run(timestamp, key);
      return null;
    })
    .immediate();
  return blocked === null
    ? null
    : jsonError(429, "TOO_MANY_MEMO_IMPORTS", "随记写入过于频繁，请稍后再试", {
        "Retry-After": String(blocked),
      });
}

async function deterministicMemoId(userId: string, key: string) {
  const hex = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`xiangying-memo-import:${userId}:${key}`),
  );
  const digest = Buffer.from(hex).toString("hex");
  const variant = ((Number.parseInt(digest[16]!, 16) & 0b0011) | 0b1000).toString(16);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

async function readImportBody(request: Request) {
  const body = await readBodyBytes(request, NOTE_BODY_MAX_BYTES);
  if (!body.ok) return { ok: false as const, reason: body.reason };
  try {
    return {
      ok: true as const,
      text: new TextDecoder("utf-8", { fatal: true }).decode(body.bytes),
    };
  } catch {
    return { ok: false as const, reason: "invalid" as const };
  }
}

export async function handleMemoImportRoute(ctx: RouteContext): Promise<Response | null> {
  const { request, method, segments, options } = ctx;
  if (segments[0] !== "memos" || segments[1] !== "import") return null;
  if (method !== "POST")
    return jsonError(405, "METHOD_NOT_ALLOWED", "快捷指令写入只支持 POST", { Allow: "POST" });
  const environment = options.environment ?? {};
  const tokenError = requireApiToken(request, environment, "xiangying-memo-import");
  if (tokenError) return tokenError;
  const credentials = getAuthCredentials(environment);
  if (!credentials)
    return jsonError(
      503,
      "AUTH_NOT_CONFIGURED",
      "请先配置 XIANGYING_USERNAME 和 XIANGYING_PASSWORD",
    );
  const rateError = importRateLimit(options.database, request, environment, options.clientAddress);
  if (rateError) return rateError;

  const mediaType = (request.headers.get("Content-Type") ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (
    mediaType &&
    mediaType !== "application/json" &&
    mediaType !== "text/markdown" &&
    mediaType !== "text/plain"
  )
    return jsonError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "只支持 application/json、text/markdown 或 text/plain",
    );
  const body = await readImportBody(request);
  if (!body.ok)
    return body.reason === "too-large"
      ? jsonError(413, "MEMO_TOO_LARGE", "随记正文超过大小限制")
      : jsonError(400, "INVALID_REQUEST_BODY", "请求体不是有效的 UTF-8 文本");
  const text = body.text;
  let contentMarkdown: unknown = text;
  let createdAt: unknown;
  if (mediaType === "application/json") {
    try {
      const payload = JSON.parse(text) as { contentMarkdown?: unknown; createdAt?: unknown } | null;
      if (!payload || typeof payload !== "object") throw new Error("invalid");
      contentMarkdown = payload.contentMarkdown;
      createdAt = payload.createdAt;
    } catch {
      return jsonError(400, "INVALID_JSON", "请求体不是有效的 JSON");
    }
  }
  const contentError = memoContentError(contentMarkdown);
  if (contentError) return contentError;
  const created = validateMemoCreatedAtPayload(createdAt);
  if (created === null) return jsonError(400, "INVALID_CREATED_AT", "创建时间无效");
  const user = await ensureEnvironmentUser(options.database, credentials, options.realtime);

  const idempotencyKey = request.headers.get("Idempotency-Key")?.trim() || null;
  if (idempotencyKey && !MEMO_IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey))
    return jsonError(400, "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key 格式无效");
  const memoId = idempotencyKey
    ? await deterministicMemoId(user.id, idempotencyKey)
    : crypto.randomUUID();
  const { database } = options;
  const markdown = contentMarkdown as string;
  const contentHash = idempotencyKey ? importContentHash(markdown) : null;
  const response = database
    .transaction(() => {
      const receipt = contentHash ? getImportRequest(database, user.id, "memo", memoId) : null;
      if (receipt && receipt.content_hash !== contentHash) return importConflict("memo");
      const existing = getMemo(database, user.id, memoId);
      if (existing) {
        if (!receipt && contentHash) {
          if (existing.content_markdown !== markdown) return importConflict("memo");
          recordImportRequest(database, user.id, "memo", memoId, contentHash);
        }
        return json({ memo: memoFromRow(existing) }, 200, { "Idempotent-Replayed": "true" });
      }
      if (receipt) return deletedImport("memo");

      if (memoHasMissingNewAssets(database, user.id, markdown)) return invalidMemoAsset();
      createMemo(database, user.id, markdown, memoId, created);
      if (contentHash) recordImportRequest(database, user.id, "memo", memoId, contentHash);
      const memo = getMemo(database, user.id, memoId);
      return json({ memo: memo ? memoFromRow(memo) : null }, 201);
    })
    .immediate();
  if (response.status === 201)
    publishWorkspaceChange(options, user.id, { resource: "memos" }, request);
  return response;
}
