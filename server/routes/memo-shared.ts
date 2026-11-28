import {
  all,
  first,
  jsonError,
  NOTE_CONTENT_MAX_LENGTH,
  noteAssetIds,
  type SqliteDatabase,
  validText,
} from "../core";
import { searchableTextFromMarkdown } from "../search-text";
import { syncMemoShortSearchTerms } from "../memo-search";
import { extractTags, normalizeTag } from "../../shared/tags";
import type { Memo } from "../../shared/types";

export const MEMO_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type MemoRow = {
  id: string;
  content_markdown: string;
  tags_json: string;
  version: number;
  created_at: number;
  updated_at: number;
};

export const MEMO_SELECT = `
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

export function memoFromRow(row: MemoRow): Memo {
  return {
    id: row.id,
    contentMarkdown: row.content_markdown,
    tags: parseMemoTags(row.tags_json),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getMemo(database: SqliteDatabase, userId: string, memoId: string) {
  return first<MemoRow>(
    database,
    `SELECT ${MEMO_SELECT} FROM memos m WHERE m.id = ? AND m.user_id = ?`,
    memoId,
    userId,
  );
}

export function syncMemoTags(
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

export function memoContentError(value: unknown) {
  if (typeof value !== "string" || value.trim() === "")
    return jsonError(400, "EMPTY_MEMO", "随记正文不能为空");
  if (!validText(value, NOTE_CONTENT_MAX_LENGTH))
    return jsonError(413, "MEMO_TOO_LARGE", "随记正文超过 1000000 个字符限制");
  return null;
}

export function memoHasMissingNewAssets(
  database: SqliteDatabase,
  userId: string,
  markdown: string,
  previousMarkdown?: string,
) {
  const ids = noteAssetIds(markdown);
  if (!ids.length) return false;
  const missing = all<{ id: string }>(
    database,
    `SELECT refs.value AS id FROM json_each(?) refs WHERE NOT EXISTS (
       SELECT 1 FROM image_assets a WHERE a.id = refs.value AND a.user_id = ?
     )`,
    JSON.stringify(ids),
    userId,
  );
  if (!missing.length) return false;
  // Existing broken references must not prevent editing or repairing an old memo.
  const previous = new Set(previousMarkdown ? noteAssetIds(previousMarkdown) : []);
  return missing.some(({ id }) => !previous.has(id));
}

export function invalidMemoAsset() {
  return jsonError(400, "INVALID_ASSET", "随记引用的附件不存在或当前不可用");
}

export function validateCreatedAt(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 8.64e15;
}

export function validateMemoCreatedAtPayload(value: unknown, timestamp = Date.now()) {
  if (value === undefined) return timestamp;
  return validateCreatedAt(value) ? value : null;
}

export function createMemo(
  database: SqliteDatabase,
  userId: string,
  contentMarkdown: string,
  memoId: string,
  createdAt: number,
) {
  return database
    .transaction(() => {
      const searchText = searchableTextFromMarkdown(contentMarkdown);
      database
        .query(
          "INSERT INTO memos (id, user_id, content_markdown, search_text, version, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
        )
        .run(memoId, userId, contentMarkdown, searchText, createdAt, createdAt);
      database
        .query("DELETE FROM memo_conversions WHERE user_id = ? AND memo_id = ?")
        .run(userId, memoId);
      syncMemoTags(database, userId, memoId, contentMarkdown);
      syncMemoShortSearchTerms(database, userId, memoId, searchText);
    })
    .immediate();
}
