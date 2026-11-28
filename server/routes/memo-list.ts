import { all, json, jsonError, type RouteContext, type SqlValue, type UserRow } from "../core";
import { buildFtsMatchQuery } from "../search-text";
import { shortSearchToken } from "../note-search";
import { normalizeTag, parseTagQuery } from "../../shared/tags";
import type { MemoDayCount, MemoFacets, MemoTagCount } from "../../shared/types";
import {
  MEMO_ID_PATTERN,
  MEMO_SELECT,
  memoFromRow,
  type MemoRow,
  validateCreatedAt,
} from "./memo-shared";

export const MEMO_PAGE_SIZE = 30;
export const MEMO_PAGE_MAX_SIZE = 100;

const MEMO_CURSOR_MAX_LENGTH = 2048;
const MEMO_QUERY_MAX_LENGTH = 200;
const MEMO_QUERY_MAX_TERMS = 12;
const MEMO_QUERY_TERM_MAX_LENGTH = 64;
const MEMO_FACET_MAX_RANGE_MS = 370 * 24 * 60 * 60 * 1000;

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
};

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
  if (!query) return { terms: [] };
  if (query.length > MEMO_QUERY_MAX_LENGTH) return null;
  const terms = query.split(/\s+/u).filter(Boolean);
  if (
    terms.length === 0 ||
    terms.length > MEMO_QUERY_MAX_TERMS ||
    terms.some((term) => term.length > MEMO_QUERY_TERM_MAX_LENGTH)
  )
    return null;
  return { terms };
}

function parseMemoTag(value: string | null) {
  const raw = value?.trim() ?? "";
  if (!raw) return undefined;
  const parsed = parseTagQuery(raw.startsWith("#") ? raw : `#${raw}`);
  return parsed ? normalizeTag(parsed) : null;
}

function addMemoQueryFilter(filter: MemoFilter, query: ParsedMemoQuery) {
  for (const term of query.terms) {
    if (Array.from(term).length >= 3) {
      filter.where.push("m.rowid IN (SELECT rowid FROM memos_fts WHERE memos_fts MATCH ?)");
      filter.params.push(buildFtsMatchQuery([term]));
      continue;
    }
    filter.where.push(`(
      m.rowid IN (SELECT rowid FROM memos_short_fts WHERE memos_short_fts MATCH ?)
      OR EXISTS (
        SELECT 1 FROM memos_short_overflow so
        WHERE so.memo_id = m.id AND so.user_id = m.user_id AND search_contains(m.search_text, ?)
      )
    )`);
    filter.params.push(shortSearchToken(term), term);
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

export function listMemos(ctx: RouteContext, user: UserRow) {
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

export function memoFacets(ctx: RouteContext, user: UserRow) {
  const { url, options } = ctx;
  const from = parseTimestamp(url.searchParams.get("from"));
  const to = parseTimestamp(url.searchParams.get("to"));
  if (from === undefined || to === undefined || from === false || to === false || from >= to)
    return jsonError(400, "INVALID_DATE_RANGE", "日期范围必须是有效的毫秒时间戳区间");
  if (to - from > MEMO_FACET_MAX_RANGE_MS)
    return jsonError(400, "INVALID_DATE_RANGE", "日历统计范围不能超过一年");
  const query = parseMemoQuery(url.searchParams.get("query"));
  if (!query) return jsonError(400, "INVALID_QUERY", "搜索词无效或过长");
  const tag = parseMemoTag(url.searchParams.get("tag"));
  if (tag === null) return jsonError(400, "INVALID_TAG", "标签格式无效");
  const timeZone = parseTimeZone(url.searchParams.get("timeZone"));
  if (!timeZone) return jsonError(400, "INVALID_TIME_ZONE", "timeZone 必须是有效的 IANA 时区");

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const filter = buildMemoFilter(user.id, query, tag, from, to);
  const timestamps = options.database.query<{ created_at: number }, SqlValue[]>(
    `SELECT m.created_at FROM memos m WHERE ${filter.where.join(" AND ")}`,
  );
  const counts = new Map<string, number>();
  for (const { created_at } of timestamps.iterate(...filter.params)) {
    const parts = formatter.formatToParts(created_at);
    const year = parts.find((part) => part.type === "year")!.value;
    const month = parts.find((part) => part.type === "month")!.value;
    const day = parts.find((part) => part.type === "day")!.value;
    const date = `${year}-${month}-${day}`;
    counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  const days: MemoDayCount[] = Array.from(counts, ([date, count]) => ({ date, count })).sort(
    (left, right) => left.date.length - right.date.length || left.date.localeCompare(right.date),
  );
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
