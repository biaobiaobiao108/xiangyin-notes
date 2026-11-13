import {
  all,
  first,
  json,
  jsonError,
  NOTE_BODY_MAX_BYTES,
  NOTE_CONTENT_MAX_LENGTH,
  now,
  readBodyBytes,
  readJson,
  rateLimitClientAddress,
  type RouteContext,
  type SqliteDatabase,
  type SqlValue,
  type UserRow,
  validText,
} from "../core";
import { ensureEnvironmentUser, getAuthCredentials, cleanupExpiredRateLimits } from "./auth";
import { requireApiToken } from "../api-token";
import { publishWorkspaceChange } from "../realtime";
import { buildFtsMatchQuery, searchableTextFromMarkdown } from "../search-text";
import { extractTags, normalizeTag, parseTagQuery } from "../../shared/tags";
import type { Memo, MemoDayCount, MemoFacets, MemoTagCount } from "../../shared/types";

export const MEMO_PAGE_SIZE = 30;
export const MEMO_PAGE_MAX_SIZE = 100;
export const MEMO_IMPORT_RATE_LIMIT_WINDOW_SECONDS = 60;
export const MEMO_IMPORT_RATE_LIMIT_MAX_REQUESTS = 120;

const MEMO_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MEMO_CURSOR_MAX_LENGTH = 2048;
const MEMO_QUERY_MAX_LENGTH = 200;
const MEMO_QUERY_MAX_TERMS = 12;
const MEMO_QUERY_TERM_MAX_LENGTH = 64;
const MEMO_IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,128}$/u;

type MemoRow = {
  id: string;
  content_markdown: string;
  tags_json: string;
  version: number;
  created_at: number;
  updated_at: number;
};

type MemoListCursor = {
  createdAt: number;
  id: string;
  scope: string;
};

type MemoFilter = {
  where: string[];
  params: SqlValue[];
};

type ParsedMemoQuery = {
  terms: string[];
  ftsQuery: string;
};

const MEMO_SELECT = `
  m.id,
  m.content_markdown,
  m.version,
  m.created_at,
  m.updated_at,
  COALESCE((
    SELECT json_group_array(tag)
    FROM (
      SELECT tag FROM memo_tags
      WHERE memo_id = m.id AND user_id = m.user_id
      ORDER BY position
    )
  ), '[]') AS tags_json
`;

function parseMemoTags(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((tag): tag is string => typeof tag === "string")
      : [];
  } catch {
    return [];
  }
}

function memoFromRow(row: MemoRow): Memo {
  return {
    id: row.id,
    contentMarkdown: row.content_markdown,
    tags: parseMemoTags(row.tags_json),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getMemo(database: SqliteDatabase, userId: string, memoId: string) {
  return first<MemoRow>(
    database,
    `SELECT ${MEMO_SELECT} FROM memos m WHERE m.id = ? AND m.user_id = ?`,
    memoId,
    userId,
  );
}

function syncMemoTags(
  database: SqliteDatabase,
  userId: string,
  memoId: string,
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

  database.query("DELETE FROM memo_tags WHERE memo_id = ? AND user_id = ?").run(memoId, userId);
  const insert = database.query(
    "INSERT INTO memo_tags (memo_id, user_id, tag_normalized, tag, position) VALUES (?, ?, ?, ?, ?)",
  );
  tags.forEach((tag, position) => insert.run(memoId, userId, tag.normalized, tag.tag, position));
}

function validateContent(value: unknown) {
  return (
    typeof value === "string" && value.trim() !== "" && validText(value, NOTE_CONTENT_MAX_LENGTH)
  );
}

function validateCreatedAt(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 8.64e15;
}

function parseTimestamp(value: string | null) {
  if (value === null || value.trim() === "") return undefined;
  if (!/^\d+$/u.test(value)) return false;
  const timestamp = Number(value);
  return validateCreatedAt(timestamp) ? timestamp : false;
}

function parseLimit(value: string | null) {
  if (value === null || value.trim() === "") return MEMO_PAGE_SIZE;
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit >= 1 && limit <= MEMO_PAGE_MAX_SIZE ? limit : null;
}

function parseMemoQuery(value: string | null): ParsedMemoQuery | null {
  const query = value?.trim() ?? "";
  if (!query) return { terms: [], ftsQuery: "" };
  if (query.length > MEMO_QUERY_MAX_LENGTH) return null;
  const terms = query.split(/\s+/u).filter(Boolean);
  if (
    terms.length === 0 ||
    terms.length > MEMO_QUERY_MAX_TERMS ||
    terms.some((term) => term.length > MEMO_QUERY_TERM_MAX_LENGTH)
  )
    return null;
  return {
    terms,
    ftsQuery: terms.every((term) => Array.from(term).length >= 3) ? buildFtsMatchQuery(terms) : "",
  };
}

function parseMemoTag(value: string | null) {
  const raw = value?.trim() ?? "";
  if (!raw) return undefined;
  const parsed = parseTagQuery(raw.startsWith("#") ? raw : `#${raw}`);
  return parsed ? normalizeTag(parsed) : null;
}

function addMemoQueryFilter(filter: MemoFilter, query: ParsedMemoQuery) {
  if (query.ftsQuery) {
    filter.where.push("m.rowid IN (SELECT rowid FROM memos_fts WHERE memos_fts MATCH ?)");
    filter.params.push(query.ftsQuery);
    return;
  }
  for (const term of query.terms) {
    filter.where.push("search_contains(m.search_text, ?)");
    filter.params.push(term);
  }
}

function buildMemoFilter(
  userId: string,
  query: ParsedMemoQuery,
  tag: string | undefined,
  from?: number,
  to?: number,
) {
  const filter: MemoFilter = { where: ["m.user_id = ?"], params: [userId] };
  addMemoQueryFilter(filter, query);
  if (tag) {
    filter.where.push(
      `EXISTS (
        SELECT 1 FROM memo_tags mt
        WHERE mt.memo_id = m.id AND mt.user_id = m.user_id AND mt.tag_normalized = ?
      )`,
    );
    filter.params.push(tag);
  }
  if (from !== undefined) {
    filter.where.push("m.created_at >= ?");
    filter.params.push(from);
  }
  if (to !== undefined) {
    filter.where.push("m.created_at < ?");
    filter.params.push(to);
  }
  return filter;
}

function filterScope(query: string, tag: string | undefined, from?: number, to?: number) {
  return JSON.stringify({ query, tag: tag ?? "", from: from ?? null, to: to ?? null });
}

function decodeCursor(value: string | null, scope: string) {
  if (!value) return null;
  if (value.length > MEMO_CURSOR_MAX_LENGTH) return false;
  try {
    const cursor = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<MemoListCursor>;
    if (
      !Number.isSafeInteger(cursor.createdAt) ||
      (cursor.createdAt as number) < 0 ||
      typeof cursor.id !== "string" ||
      !MEMO_ID_PATTERN.test(cursor.id) ||
      cursor.scope !== scope
    )
      return false;
    return cursor as MemoListCursor;
  } catch {
    return false;
  }
}

function encodeCursor(cursor: MemoListCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function listMemos(ctx: RouteContext, user: UserRow) {
  const { url, options } = ctx;
  const limit = parseLimit(url.searchParams.get("limit"));
  if (limit === null) return jsonError(400, "INVALID_LIMIT", "limit 必须为 1 到 100 的整数");
  const query = parseMemoQuery(url.searchParams.get("query"));
  if (!query) return jsonError(400, "INVALID_QUERY", "搜索词无效或过长");
  const tag = parseMemoTag(url.searchParams.get("tag"));
  if (tag === null) return jsonError(400, "INVALID_TAG", "标签格式无效");
  const from = parseTimestamp(url.searchParams.get("from"));
  const to = parseTimestamp(url.searchParams.get("to"));
  if (from === false || to === false)
    return jsonError(400, "INVALID_DATE_RANGE", "时间范围必须是毫秒时间戳");
  if (from !== undefined && to !== undefined && from >= to)
    return jsonError(400, "INVALID_DATE_RANGE", "起始时间必须早于结束时间");

  const scope = filterScope(query.terms.join(" "), tag, from, to);
  const cursor = decodeCursor(url.searchParams.get("cursor"), scope);
  if (cursor === false) return jsonError(400, "INVALID_CURSOR", "分页游标无效");

  const filter = buildMemoFilter(user.id, query, tag, from, to);
  const cursorWhere = cursor ? "(m.created_at < ? OR (m.created_at = ? AND m.id < ?))" : "";
  const cursorParams: SqlValue[] = cursor ? [cursor.createdAt, cursor.createdAt, cursor.id] : [];
  const rows = all<MemoRow>(
    options.database,
    `
      SELECT ${MEMO_SELECT}
      FROM memos m
      WHERE ${filter.where.join(" AND ")}${cursorWhere ? ` AND ${cursorWhere}` : ""}
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT ?
    `,
    ...filter.params,
    ...cursorParams,
    limit + 1,
  );
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows[pageRows.length - 1];
  return json({
    memos: pageRows.map(memoFromRow),
    hasMore,
    nextCursor:
      hasMore && last ? encodeCursor({ createdAt: last.created_at, id: last.id, scope }) : null,
  });
}

function parseTimeZone(value: string | null) {
  const timeZone = value?.trim() || "UTC";
  if (timeZone.length > 64) return null;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
    return timeZone;
  } catch {
    return null;
  }
}

function memoFacets(ctx: RouteContext, user: UserRow) {
  const { url, options } = ctx;
  const from = parseTimestamp(url.searchParams.get("from"));
  const to = parseTimestamp(url.searchParams.get("to"));
  if (from === undefined || to === undefined || from === false || to === false || from >= to)
    return jsonError(400, "INVALID_DATE_RANGE", "日期范围必须是有效的毫秒时间戳区间");
  const query = parseMemoQuery(url.searchParams.get("query"));
  if (!query) return jsonError(400, "INVALID_QUERY", "搜索词无效或过长");
  const tag = parseMemoTag(url.searchParams.get("tag"));
  if (tag === null) return jsonError(400, "INVALID_TAG", "标签格式无效");
  const timeZone = parseTimeZone(url.searchParams.get("timeZone"));
  if (!timeZone) return jsonError(400, "INVALID_TIME_ZONE", "timeZone 必须是有效的 IANA 时区");

  const filter = buildMemoFilter(user.id, query, tag, from, to);
  const rows = all<{ created_at: number }>(
    options.database,
    `SELECT m.created_at FROM memos m WHERE ${filter.where.join(" AND ")}`,
    ...filter.params,
  );
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const counts = new Map<string, number>();
  for (const row of rows) {
    const parts = formatter.formatToParts(new Date(row.created_at));
    const value = (type: "year" | "month" | "day") =>
      parts.find((part) => part.type === type)?.value ?? "";
    const date = `${value("year")}-${value("month")}-${value("day")}`;
    counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  const days: MemoDayCount[] = [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => ({ date, count }));
  const tagRows = all<{ tag: string; count: number }>(
    options.database,
    `
      SELECT MIN(tag) AS tag, COUNT(*) AS count
      FROM memo_tags
      WHERE user_id = ?
      GROUP BY tag_normalized
      ORDER BY count DESC, tag COLLATE NOCASE ASC
    `,
    user.id,
  );
  const tags: MemoTagCount[] = tagRows.map((row) => ({ tag: row.tag, count: Number(row.count) }));
  return json({ days, tags } satisfies MemoFacets);
}

function createMemo(
  database: SqliteDatabase,
  userId: string,
  contentMarkdown: string,
  memoId: string,
  createdAt: number,
) {
  return database
    .transaction(() => {
      database
        .query(
          "INSERT INTO memos (id, user_id, content_markdown, search_text, version, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
        )
        .run(
          memoId,
          userId,
          contentMarkdown,
          searchableTextFromMarkdown(contentMarkdown),
          createdAt,
          createdAt,
        );
      syncMemoTags(database, userId, memoId, contentMarkdown);
    })
    .immediate();
}

function parseMemoId(value: unknown) {
  return value === undefined
    ? crypto.randomUUID()
    : typeof value === "string" && MEMO_ID_PATTERN.test(value)
      ? value
      : null;
}

function validateCreatedAtPayload(value: unknown) {
  if (value === undefined) return Date.now();
  return validateCreatedAt(value) ? value : null;
}

function memoMutation(ctx: RouteContext, user: UserRow, memoId: string) {
  const { request, method, options } = ctx;
  if (method === "PATCH") {
    return (async () => {
      const payload = await readJson<{ version?: unknown; contentMarkdown?: unknown }>(
        request,
        NOTE_BODY_MAX_BYTES,
      );
      if (!payload) return jsonError(400, "INVALID_JSON", "请求体无效或超出大小限制");
      if (!Number.isSafeInteger(payload.version) || (payload.version as number) < 1)
        return jsonError(400, "VERSION_REQUIRED", "更新随记必须携带版本号");
      if (!validateContent(payload.contentMarkdown))
        return jsonError(413, "MEMO_TOO_LARGE", "随记正文不能为空且不能超过长度限制");

      const result = options.database
        .transaction(() => {
          const current = getMemo(options.database, user.id, memoId);
          if (!current) return { kind: "missing" as const };
          if (current.version !== payload.version) return { kind: "conflict" as const, current };
          if (current.content_markdown === payload.contentMarkdown)
            return { kind: "unchanged" as const, current };
          const updatedAt = Math.max(current.created_at, Date.now());
          const updated = options.database
            .query(
              "UPDATE memos SET content_markdown = ?, search_text = ?, version = version + 1, updated_at = ? WHERE id = ? AND user_id = ? AND version = ?",
            )
            .run(
              payload.contentMarkdown as string,
              searchableTextFromMarkdown(payload.contentMarkdown as string),
              updatedAt,
              memoId,
              user.id,
              payload.version as number,
            );
          if (!updated.changes)
            return {
              kind: "conflict" as const,
              current: getMemo(options.database, user.id, memoId),
            };
          syncMemoTags(options.database, user.id, memoId, payload.contentMarkdown as string);
          return { kind: "updated" as const };
        })
        .immediate();
      if (result.kind === "missing") return jsonError(404, "MEMO_NOT_FOUND", "随记不存在");
      if (result.kind === "conflict") {
        return json(
          {
            error: {
              code: "VERSION_CONFLICT",
              message: "这条随记已在别处更新",
              current: result.current ? memoFromRow(result.current) : null,
            },
          },
          409,
        );
      }
      if (result.kind === "updated")
        publishWorkspaceChange(options, user.id, { resource: "memos" }, request);
      const memo = getMemo(options.database, user.id, memoId);
      return json({ memo: memo ? memoFromRow(memo) : null });
    })();
  }

  if (method === "DELETE") {
    return (async () => {
      const payload = await readJson<{ version?: unknown }>(request, 1024);
      if (!payload || !Number.isSafeInteger(payload.version) || (payload.version as number) < 1)
        return jsonError(400, "VERSION_REQUIRED", "删除随记必须携带版本号");
      const result = options.database
        .transaction(() => {
          const current = getMemo(options.database, user.id, memoId);
          if (!current) return { kind: "missing" as const };
          if (current.version !== payload.version) return { kind: "conflict" as const, current };
          const deleted = options.database
            .query("DELETE FROM memos WHERE id = ? AND user_id = ? AND version = ?")
            .run(memoId, user.id, payload.version as number);
          return deleted.changes
            ? { kind: "deleted" as const }
            : { kind: "conflict" as const, current: getMemo(options.database, user.id, memoId) };
        })
        .immediate();
      if (result.kind === "missing") return jsonError(404, "MEMO_NOT_FOUND", "随记不存在");
      if (result.kind === "conflict")
        return json(
          {
            error: {
              code: "VERSION_CONFLICT",
              message: "这条随记已在别处更新，请刷新后重试",
              current: result.current ? memoFromRow(result.current) : null,
            },
          },
          409,
        );
      publishWorkspaceChange(options, user.id, { resource: "memos" }, request);
      return json({ ok: true });
    })();
  }
  return null;
}

export function handleMemosRoute(
  ctx: RouteContext,
  user: UserRow,
): Response | Promise<Response> | null {
  const { method, segments } = ctx;
  if (segments[0] !== "memos") return null;

  if (segments.length === 2 && segments[1] === "facets" && method === "GET") {
    return memoFacets(ctx, user);
  }

  if (segments.length === 1) {
    if (method === "GET") return listMemos(ctx, user);
    if (method === "POST") {
      return (async () => {
        const payload = await readJson<{
          id?: unknown;
          contentMarkdown?: unknown;
          createdAt?: unknown;
        }>(ctx.request, NOTE_BODY_MAX_BYTES);
        if (!payload) return jsonError(400, "INVALID_JSON", "请求体无效或超出大小限制");
        const memoId = parseMemoId(payload.id);
        if (memoId === null) return jsonError(400, "INVALID_MEMO_ID", "随记 ID 必须是 UUID");
        const createdAt = validateCreatedAtPayload(payload.createdAt);
        if (createdAt === null) return jsonError(400, "INVALID_CREATED_AT", "创建时间无效");
        if (!validateContent(payload.contentMarkdown))
          return jsonError(413, "MEMO_TOO_LARGE", "随记正文不能为空且不能超过长度限制");
        if (first(ctx.options.database, "SELECT 1 FROM memos WHERE id = ?", memoId))
          return jsonError(409, "MEMO_EXISTS", "指定 ID 的随记已存在");
        createMemo(
          ctx.options.database,
          user.id,
          payload.contentMarkdown as string,
          memoId,
          createdAt,
        );
        publishWorkspaceChange(ctx.options, user.id, { resource: "memos" }, ctx.request);
        const memo = getMemo(ctx.options.database, user.id, memoId);
        return json({ memo: memo ? memoFromRow(memo) : null }, 201);
      })();
    }
    return jsonError(405, "METHOD_NOT_ALLOWED", "随记列表只支持 GET 或 POST", {
      Allow: "GET, POST",
    });
  }

  if (segments.length === 2) {
    const memoId = segments[1];
    if (!MEMO_ID_PATTERN.test(memoId)) return jsonError(400, "INVALID_MEMO_ID", "随记 ID 无效");
    return memoMutation(ctx, user, memoId);
  }
  return null;
}

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
  if (!validateContent(contentMarkdown))
    return jsonError(413, "MEMO_TOO_LARGE", "随记正文不能为空且不能超过长度限制");
  const created = validateCreatedAtPayload(createdAt);
  if (created === null) return jsonError(400, "INVALID_CREATED_AT", "创建时间无效");
  const user = await ensureEnvironmentUser(options.database, credentials);

  const idempotencyKey = request.headers.get("Idempotency-Key")?.trim() || null;
  if (idempotencyKey && !MEMO_IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey))
    return jsonError(400, "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key 格式无效");
  const memoId = idempotencyKey
    ? await deterministicMemoId(user.id, idempotencyKey)
    : crypto.randomUUID();
  const existing = getMemo(options.database, user.id, memoId);
  if (existing) {
    if (existing.content_markdown !== contentMarkdown)
      return jsonError(409, "IDEMPOTENCY_CONFLICT", "Idempotency-Key 已用于其他随记内容");
    return json({ memo: memoFromRow(existing) }, 200, { "Idempotent-Replayed": "true" });
  }

  createMemo(options.database, user.id, contentMarkdown as string, memoId, created);
  publishWorkspaceChange(options, user.id, { resource: "memos" }, request);
  const memo = getMemo(options.database, user.id, memoId);
  return json({ memo: memo ? memoFromRow(memo) : null }, 201);
}
