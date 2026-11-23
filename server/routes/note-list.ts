import type { NoteSort, NoteSummary, NoteView } from "../../shared/types";
import { normalizeLinkTitle } from "../../shared/wiki-links";
import {
  json,
  NOTE_LIST_SELECT,
  parseIndexedTags,
  toNote,
  type NoteRow,
  type SqlValue,
} from "../core";
import { shortSearchToken } from "../note-search";
import { buildFtsMatchQuery, searchContains } from "../search-text";

export type SearchSort = NoteSort | "relevance";
type NoteListCursor = {
  sort: SearchSort;
  value: number | string;
  id: string;
  scope?: string;
};

function encodeNoteListCursor(cursor: NoteListCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeNoteListCursor(value: string | null, sort: SearchSort) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<NoteListCursor>;
    if (parsed.sort !== sort || typeof parsed.id !== "string" || !parsed.id) return null;
    if (typeof parsed.value !== "number" && typeof parsed.value !== "string") return null;
    return parsed as NoteListCursor;
  } catch {
    return null;
  }
}

export function noteListOrder(sort: NoteSort) {
  if (sort === "created") return "n.created_at DESC, n.id DESC";
  if (sort === "title") return "n.title COLLATE NOCASE ASC, n.id ASC";
  return "n.updated_at DESC, n.id DESC";
}

type OptimizedNoteListPlan = {
  sql: string;
  params: SqlValue[];
};

export function buildOptimizedNoteListPlan(input: {
  userId: string;
  view: NoteView;
  sort: SearchSort;
  notebookIds: string[];
  searchTokens: string[];
  ftsTokens: string[];
  shortTokens: string[];
  normalizedTagFilters: string[];
  tagMode: "all" | "any";
  pageLimit: number;
  cursor: { value: number | string; id: string } | null;
  includeTotal: boolean;
  includeMatch: boolean;
}): OptimizedNoteListPlan | null {
  const {
    userId,
    view,
    sort,
    notebookIds,
    searchTokens,
    ftsTokens,
    shortTokens,
    normalizedTagFilters,
    tagMode,
    pageLimit,
    cursor,
    includeTotal,
    includeMatch,
  } = input;
  if (searchTokens.length === 0) return null;

  const noteConditions = [
    "n.user_id = ?",
    ...(view === "trash" ? ["n.deleted_at IS NOT NULL"] : ["n.deleted_at IS NULL"]),
  ];
  const noteParams: SqlValue[] = [userId];
  if (view === "favorites") noteConditions.push("n.is_favorite = 1");
  for (const notebookId of notebookIds) {
    noteConditions.push("n.notebook_id = ?");
    noteParams.push(notebookId);
  }
  const isRanked = sort === "relevance";

  const tagConditions = normalizedTagFilters.map(
    () => `EXISTS (
      SELECT 1 FROM note_tags t
      WHERE t.note_id = n.id
        AND t.user_id = n.user_id
        AND t.tag_normalized = ?
    )`,
  );
  const tagWhere = tagConditions.length
    ? `(${tagConditions.join(tagMode === "any" ? " OR " : " AND ")})`
    : "";
  const tagParams: SqlValue[] = [...normalizedTagFilters];
  const ftsQuery = ftsTokens.length ? buildFtsMatchQuery(ftsTokens) : "";

  const shortCtes: string[] = [];
  const shortParams: SqlValue[] = [];
  shortTokens.forEach((term, index) => {
    shortCtes.push(`short_matches_${index} AS MATERIALIZED (
      SELECT rowid FROM notes_short_fts WHERE notes_short_fts MATCH ?
      UNION
      SELECT overflow_note.rowid FROM notes_short_overflow overflow
      JOIN notes overflow_note ON overflow_note.id = overflow.note_id
      WHERE overflow.user_id = ? AND search_contains(COALESCE(overflow_note.search_text, overflow_note.content_markdown), ?)
    )`);
    shortParams.push(shortSearchToken(term), userId, term);
  });
  const shortMatches = (indexes: number[]) =>
    indexes
      .map(
        (index) =>
          `EXISTS (SELECT 1 FROM short_matches_${index} short_match WHERE short_match.rowid = n.rowid)`,
      )
      .join(" AND ");

  const sortColumn = sort === "created" ? "created_at" : sort === "title" ? "title" : "updated_at";
  const shortScoreParams = shortTokens.map((term) => normalizeLinkTitle(term));
  const shortScore = shortTokens
    .map(() => "(CASE WHEN instr(n.title_normalized, ?) > 0 THEN -8.0 ELSE 0 END)")
    .join(" + ");
  const scoreExpression = isRanked
    ? [ftsTokens.length ? "bm25(notes_fts, 8.0, 1.0)" : "", shortScore ? `(${shortScore})` : ""]
        .filter(Boolean)
        .join(" + ")
    : "";
  const usesFts = ftsTokens.length > 0;
  const otherShortIndexes = shortTokens.map((_, index) => index).slice(usesFts ? 0 : 1);
  const conditions = [
    ...(usesFts ? ["notes_fts MATCH ?"] : []),
    ...noteConditions,
    ...(otherShortIndexes.length ? [shortMatches(otherShortIndexes)] : []),
    ...(tagWhere ? [tagWhere] : []),
  ];
  const candidateValue = isRanked
    ? `${scoreExpression || "0"} AS score`
    : `n.${sortColumn} AS sort_value`;
  const candidateFrom = usesFts
    ? "notes_fts JOIN notes n ON n.rowid = notes_fts.rowid"
    : "short_matches_0 short_source JOIN notes n ON n.rowid = short_source.rowid";
  const candidateCte = `candidates AS MATERIALIZED (
    SELECT n.rowid AS note_rowid, n.id AS note_id, ${candidateValue}
    FROM ${candidateFrom}
    WHERE ${conditions.join(" AND ")}
  )`;
  const topCte = isRanked
    ? `top AS MATERIALIZED (
        SELECT note_rowid, note_id, score
        FROM candidates
        ${cursor ? "WHERE (score > ? OR (score = ? AND note_id > ?))" : ""}
        ORDER BY score ASC, note_id ASC
        LIMIT ?
      )`
    : sort === "title"
      ? `top AS MATERIALIZED (
        SELECT note_rowid, note_id, sort_value
        FROM candidates
        ${
          cursor
            ? "WHERE (sort_value COLLATE NOCASE > ? OR (sort_value COLLATE NOCASE = ? AND note_id > ?))"
            : ""
        }
        ORDER BY sort_value COLLATE NOCASE ASC, note_id ASC
        LIMIT ?
      )`
      : `top AS MATERIALIZED (
        SELECT note_rowid, note_id, sort_value
        FROM candidates
        ${cursor ? "WHERE (sort_value, note_id) < (?, ?)" : ""}
        ORDER BY sort_value DESC, note_id DESC
        LIMIT ?
      )`;

  const withParts = [...shortCtes, candidateCte, topCte];
  const candidateParams: SqlValue[] = [
    ...(isRanked && shortTokens.length ? shortScoreParams : []),
    ...(usesFts ? [ftsQuery] : []),
    ...noteParams,
    ...tagParams,
  ];
  const cursorParams: SqlValue[] = cursor
    ? isRanked || sort === "title"
      ? [cursor.value, cursor.value, cursor.id]
      : [cursor.value, cursor.id]
    : [];
  // The totals LEFT JOIN can return a row with no note when the page is empty.
  const matchSelect = includeMatch
    ? `, CASE WHEN n.id IS NOT NULL
        THEN search_snippet(COALESCE(n.search_text, n.content_markdown), ?)
      END AS match_snippet`
    : "";
  const detailParams: SqlValue[] = includeMatch ? [JSON.stringify(searchTokens)] : [];
  const detailOrder = isRanked
    ? "top.score ASC, n.id ASC"
    : sort === "title"
      ? "top.sort_value COLLATE NOCASE ASC, n.id ASC"
      : "top.sort_value DESC, n.id DESC";
  const relevanceSelect = isRanked ? "top.score AS relevance_score" : "0 AS relevance_score";
  const sql = `WITH ${withParts.join(",\n")}
    SELECT ${NOTE_LIST_SELECT}, ${relevanceSelect} ${matchSelect}${includeTotal ? ", totals.total AS search_total" : ""}
    FROM ${includeTotal ? "(SELECT COUNT(*) AS total FROM candidates) totals LEFT JOIN top ON 1 = 1" : "top"}
    ${includeTotal ? "LEFT JOIN" : "JOIN"} notes n ON n.rowid = top.note_rowid
    ${includeTotal ? "LEFT JOIN" : "JOIN"} notebooks b ON b.id = n.notebook_id AND b.user_id = n.user_id
    LEFT JOIN image_assets a ON a.note_id = n.id AND a.user_id = n.user_id AND a.document_order = 0
    ORDER BY ${detailOrder}`;
  const params: SqlValue[] = [
    ...shortParams,
    ...candidateParams,
    ...cursorParams,
    pageLimit + 1,
    ...detailParams,
  ];

  return { sql, params };
}

export function respondNoteList(
  rows: (NoteRow & { tags_json: string; relevance_score: number; match_snippet?: string })[],
  pageLimit: number,
  sort: SearchSort,
  scope: string | undefined,
  searchTokens: string[],
  normalizedTagFilters: string[],
  includeMatch: boolean,
  includeTotal: boolean,
  total: number | null,
) {
  const hasMore = rows.length > pageLimit;
  const pageRows = hasMore ? rows.slice(0, pageLimit) : rows;
  const notes: NoteSummary[] = pageRows.map((row) => {
    const note = toNote(row, parseIndexedTags(row.tags_json));
    if (!includeMatch) return note;
    const titleMatched = searchTokens.some((token) => searchContains(row.title, token));
    const field = searchTokens.length
      ? titleMatched
        ? "title"
        : "content"
      : normalizedTagFilters.length
        ? "tag"
        : "content";
    return {
      ...note,
      match: {
        field,
        ...(field === "content" && row.match_snippet ? { snippet: row.match_snippet } : {}),
      },
    };
  });
  const lastRow = pageRows[pageRows.length - 1];
  const nextCursor =
    hasMore && lastRow
      ? encodeNoteListCursor({
          sort,
          value:
            sort === "relevance"
              ? lastRow.relevance_score
              : sort === "title"
                ? lastRow.title
                : sort === "created"
                  ? lastRow.created_at
                  : lastRow.updated_at,
          id: lastRow.id,
          ...(scope ? { scope } : {}),
        })
      : undefined;
  return json({
    notes,
    ...(includeTotal ? { total: total ?? 0 } : {}),
    ...(hasMore ? { hasMore: true, nextCursor } : {}),
  });
}
