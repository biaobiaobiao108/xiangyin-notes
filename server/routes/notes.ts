import { normalizeTag, parseTagQuery } from "../../shared/tags";
import type {
  NoteBacklinksResponse,
  NoteLinkSummary,
  NoteSort,
  NoteSummary,
  NoteView,
  UnlinkedMention,
} from "../../shared/types";
import {
  extractContextSnippet,
  extractWikiLinks,
  findUnlinkedMentionsInMarkdown,
  linkMentionInMarkdown,
  normalizeLinkTitle,
  replaceWikiLinkTarget,
} from "../../shared/wiki-links";
import {
  all,
  BACKLINK_CANDIDATE_LIMIT,
  BACKLINK_MENTION_LIMIT,
  BACKLINK_REFERENCE_LIMIT,
  BACKLINK_SCAN_CHAR_LIMIT,
  escapeLikePattern,
  digestHex,
  first,
  getNote,
  InvalidNoteAssetsError,
  json,
  jsonError,
  NOTE_BODY_MAX_BYTES,
  NOTE_CONTENT_MAX_BYTES,
  NOTE_CONTENT_MAX_LENGTH,
  NOTE_FROM,
  NOTE_SELECT,
  NOTE_LIST_SELECT,
  NOTE_PAGE_SIZE,
  NOTE_VIEWS,
  type NoteRow,
  normalizeNoteTitle,
  now,
  parseSearchTerms,
  readJson,
  type RouteContext,
  type SqliteDatabase,
  type SqlValue,
  parseIndexedTags,
  toFullNote,
  toNote,
  type UserRow,
  validNoteAssetReferences,
  validNoteContent,
  validText,
} from "../core";
import { findActiveNoteIdByTitle, resolveNoteLinksForTitles } from "../note-links";
import {
  createNote,
  NoteRenameContentTooLargeError,
  syncNoteTasks,
  updateNote,
  updateNoteInTransaction,
  NOTE_RENAME_SOURCE_BATCH_SIZE,
} from "./note-mutations";
export {
  createNote,
  updateNote,
  updateNoteInTransaction,
  NOTE_RENAME_SOURCE_BATCH_SIZE,
} from "./note-mutations";
import { assetPathsForNotes, assetPathsForTrash, removeAssetFiles } from "./assets";
import { searchContains, searchSnippet } from "../search-text";
import { publishWorkspaceChange } from "../realtime";
import { extractMarkdownTasks, findMarkdownTaskMarker } from "../../shared/tasks";

const NOTE_BATCH_LIMIT = 500;
const NOTE_BATCH_BODY_MAX_BYTES = 64 * 1024;
const TASK_PAGE_SIZE = 100;
const TASK_PAGE_MAX_SIZE = 200;
const NOTE_SORTS: NoteSort[] = ["updated", "created", "title"];
const NOTE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

type TaskCursor = { sortCreatedAt: number; noteId: string; ordinal: number };

function decodeTaskCursor(value: string | null): TaskCursor | null | false {
  if (value === null) return null;
  if (value.length > 1024) return false;
  try {
    const cursor = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<TaskCursor>;
    if (
      !Number.isSafeInteger(cursor.sortCreatedAt) ||
      typeof cursor.noteId !== "string" ||
      !NOTE_ID_PATTERN.test(cursor.noteId) ||
      !Number.isSafeInteger(cursor.ordinal) ||
      (cursor.ordinal as number) < 0
    )
      return false;
    return cursor as TaskCursor;
  } catch {
    return false;
  }
}

function encodeTaskCursor(cursor: TaskCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}
type SearchSort = NoteSort | "relevance";
type NoteListCursor = {
  sort: SearchSort;
  value: number | string;
  id: string;
  scope?: string;
};

function encodeNoteListCursor(cursor: NoteListCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeNoteListCursor(value: string | null, sort: SearchSort) {
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

function noteListOrder(sort: NoteSort) {
  if (sort === "created") return "n.created_at DESC, n.id DESC";
  if (sort === "title") return "n.title COLLATE NOCASE ASC, n.id ASC";
  return "n.updated_at DESC, n.id DESC";
}

type OptimizedNoteListPlan = {
  sql: string;
  params: SqlValue[];
  countSql: string | null;
  countParams: SqlValue[];
};

function buildOptimizedNoteListPlan(input: {
  userId: string;
  view: NoteView;
  sort: SearchSort;
  notebookIds: string[];
  ftsTokens: string[];
  normalizedTagFilters: string[];
  tagMode: "all" | "any";
  pageLimit: number;
  cursor: { value: number | string; id: string } | null;
  includeTotal: boolean;
}): OptimizedNoteListPlan | null {
  const {
    userId,
    view,
    sort,
    notebookIds,
    ftsTokens,
    normalizedTagFilters,
    tagMode,
    pageLimit,
    cursor,
    includeTotal,
  } = input;
  if (ftsTokens.length === 0) return null;

  const activeConditions = view === "trash" ? ["deleted_at IS NOT NULL"] : ["deleted_at IS NULL"];
  const activeParams: SqlValue[] = [userId];
  if (view === "favorites") activeConditions.push("is_favorite = 1");
  for (const notebookId of notebookIds) {
    activeConditions.push("notebook_id = ?");
    activeParams.push(notebookId);
  }
  const isRanked = sort === "relevance";
  const activeIndex =
    sort === "title"
      ? "idx_notes_user_deleted_title_nocase"
      : sort === "created"
        ? "idx_notes_user_deleted_created"
        : "idx_notes_user_deleted_updated_id";
  const activeColumns =
    sort === "title"
      ? "rowid, id, user_id, title"
      : sort === "created"
        ? "rowid, id, user_id, created_at"
        : sort === "updated"
          ? "rowid, id, user_id, updated_at"
          : "rowid, id, user_id";
  const activeCte = `active AS MATERIALIZED (
    SELECT ${activeColumns}
    FROM notes INDEXED BY ${activeIndex}
    WHERE user_id = ? AND ${activeConditions.join(" AND ")}
  )`;

  const tagConditions = normalizedTagFilters.map(
    () => `EXISTS (
      SELECT 1 FROM note_tags t
      WHERE t.note_id = active.id
        AND t.user_id = active.user_id
        AND t.tag_normalized = ?
    )`,
  );
  const tagWhere = tagConditions.length
    ? `(${tagConditions.join(tagMode === "any" ? " OR " : " AND ")})`
    : "";
  const tagParams: SqlValue[] = [...normalizedTagFilters];
  const ftsQuery = ftsTokens.map((part) => `"${part.replaceAll('"', '""')}"`).join(" AND ");

  const sortColumn = sort === "created" ? "created_at" : sort === "title" ? "title" : "updated_at";
  const rankedCte = isRanked
    ? `ranked AS MATERIALIZED (
      SELECT notes_fts.rowid AS note_rowid, active.id AS note_id,
        bm25(notes_fts, 8.0, 1.0) AS score
      FROM notes_fts
      JOIN active ON active.rowid = notes_fts.rowid
      WHERE notes_fts MATCH ?
        ${tagWhere ? `AND ${tagWhere}` : ""}
    )`
    : "";
  const candidatesCte = isRanked
    ? ""
    : `candidates AS MATERIALIZED (
        SELECT notes_fts.rowid AS note_rowid, active.id AS note_id,
          active.${sortColumn} AS sort_value
        FROM notes_fts JOIN active ON active.rowid = notes_fts.rowid
        WHERE notes_fts MATCH ?
          ${tagWhere ? `AND ${tagWhere}` : ""}
      )`;
  const candidateCte = isRanked ? rankedCte : candidatesCte;

  const topCte = isRanked
    ? `top AS MATERIALIZED (
        SELECT note_rowid, note_id, score
        FROM ranked
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

  const withParts = [activeCte, candidateCte, topCte];
  const sourceParams: SqlValue[] = [ftsQuery, ...tagParams];
  const cursorParams: SqlValue[] = cursor
    ? isRanked || sort === "title"
      ? [cursor.value, cursor.value, cursor.id]
      : [cursor.value, cursor.id]
    : [];
  const detailOrder = isRanked
    ? "top.score ASC, n.id ASC"
    : sort === "title"
      ? "top.sort_value COLLATE NOCASE ASC, n.id ASC"
      : "top.sort_value DESC, n.id DESC";
  const relevanceSelect = isRanked ? "top.score AS relevance_score" : "0 AS relevance_score";
  const sql = `WITH ${withParts.join(",\n")}
    SELECT ${NOTE_LIST_SELECT}, ${relevanceSelect}
    FROM top
    JOIN notes n ON n.rowid = top.note_rowid
    JOIN notebooks b ON b.id = n.notebook_id
    LEFT JOIN image_assets a ON a.note_id = n.id AND a.document_order = 0
    ORDER BY ${detailOrder}`;
  const params: SqlValue[] = [...activeParams, ...sourceParams, ...cursorParams, pageLimit + 1];

  let countSql: string | null = null;
  let countParams: SqlValue[] = [];
  if (includeTotal) {
    countSql = `WITH ${activeCte}
      SELECT COUNT(*) AS count
      FROM notes_fts
      JOIN active ON active.rowid = notes_fts.rowid
      WHERE notes_fts MATCH ?
        ${tagWhere ? `AND ${tagWhere}` : ""}`;
    countParams = [...activeParams, ftsQuery, ...tagParams];
  }

  return { sql, params, countSql, countParams };
}

async function loadSearchContents(
  database: SqliteDatabase,
  userId: string,
  rows: Array<Pick<NoteRow, "id">>,
) {
  if (!rows.length) return new Map<string, string>();
  const contents = await all<{ id: string; content_markdown: string }>(
    database,
    `SELECT id, content_markdown FROM notes WHERE user_id = ? AND id IN (${rows.map(() => "?").join(", ")})`,
    userId,
    ...rows.map((row) => row.id),
  );
  return new Map(contents.map((row) => [row.id, row.content_markdown]));
}

function respondNoteList(
  rows: (NoteRow & { tags_json: string; relevance_score: number; match_snippet?: string })[],
  pageLimit: number,
  sort: SearchSort,
  scope: string | undefined,
  searchTokens: string[],
  normalizedTagFilters: string[],
  includeMatch: boolean,
  includeTotal: boolean,
  total: number | null,
  fullContents: Map<string, string>,
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
    const snippet =
      field === "content" && searchTokens.length
        ? searchSnippet(
            fullContents.get(row.id) ?? row.content_markdown,
            JSON.stringify(searchTokens),
          )
        : undefined;
    return {
      ...note,
      match: {
        field,
        ...(snippet ? { snippet } : {}),
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

type BatchNoteEntry = {
  id: string;
  version: number;
};

type BatchNoteState = {
  id: string;
  title: string;
  deleted_at: number | null;
  version: number;
  notebook_id: string;
  created_at: number;
  content_markdown: string;
};

class BatchNoteConflictError extends Error {
  constructor(readonly conflictIds: string[]) {
    super("batch-note-conflict");
    this.name = "BatchNoteConflictError";
  }
}

function parseBatchNoteEntries(payload: unknown): BatchNoteEntry[] | null {
  if (
    !payload ||
    typeof payload !== "object" ||
    !Array.isArray((payload as { notes?: unknown }).notes)
  )
    return null;
  const rawNotes = (payload as { notes: unknown[] }).notes;
  if (rawNotes.length === 0 || rawNotes.length > NOTE_BATCH_LIMIT) return null;

  const entries: BatchNoteEntry[] = [];
  const seen = new Set<string>();
  for (const rawNote of rawNotes) {
    if (!rawNote || typeof rawNote !== "object") return null;
    const id = (rawNote as { id?: unknown }).id;
    const version = (rawNote as { version?: unknown }).version;
    if (
      typeof id !== "string" ||
      !id ||
      seen.has(id) ||
      !Number.isSafeInteger(version) ||
      (version as number) < 1
    )
      return null;
    seen.add(id);
    entries.push({ id, version: version as number });
  }
  return entries;
}

async function getBatchNoteStates(
  database: SqliteDatabase,
  userId: string,
  entries: BatchNoteEntry[],
) {
  const placeholders = entries.map(() => "?").join(",");
  return await all<BatchNoteState>(
    database,
    `SELECT id, title, deleted_at, version, notebook_id, created_at, content_markdown FROM notes WHERE user_id = ? AND id IN (${placeholders})`,
    userId,
    ...entries.map((entry) => entry.id),
  );
}

function assertBatchNoteStates(
  rows: BatchNoteState[],
  entries: BatchNoteEntry[],
  mode: "trash" | "restore" | "permanent",
) {
  const states = new Map(rows.map((row) => [row.id, row]));
  const conflictIds = entries
    .filter((entry) => {
      const row = states.get(entry.id);
      return (
        !row ||
        row.version !== entry.version ||
        (mode === "trash" ? row.deleted_at !== null : row.deleted_at === null)
      );
    })
    .map((entry) => entry.id);
  if (conflictIds.length) throw new BatchNoteConflictError(conflictIds);
}

function batchConflictResponse(error: BatchNoteConflictError) {
  // AGENTS.md requires every version conflict to surface as 409 VERSION_CONFLICT.
  return json(
    {
      error: {
        code: "VERSION_CONFLICT",
        message: "选中的笔记已发生变化，请重新选择后重试",
        conflictIds: error.conflictIds,
      },
    },
    409,
  );
}

export async function handleNotesRoute(
  ctx: RouteContext,
  user: UserRow,
  summarizeNote: (note: NoteRow) => unknown = toNote,
): Promise<Response | null> {
  const { request, url, method, segments, options } = ctx;
  const { database } = options;
  const resource = segments[0] ?? "";
  const id = segments[1] ?? "";
  const subresource = segments[2] ?? "";

  if (resource === "tasks" && !id && method === "GET") {
    const status = url.searchParams.get("status") ?? "open";
    if (status !== "open" && status !== "done" && status !== "all")
      return jsonError(400, "INVALID_ARGUMENT", "status 必须为 open、done 或 all");

    const limitValue = url.searchParams.get("limit");
    const limit = limitValue === null ? TASK_PAGE_SIZE : Number(limitValue);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > TASK_PAGE_MAX_SIZE)
      return jsonError(
        400,
        "INVALID_ARGUMENT",
        `limit 必须为 1 到 ${TASK_PAGE_MAX_SIZE} 之间的整数`,
      );
    const cursor = decodeTaskCursor(url.searchParams.get("cursor"));
    if (cursor === false) return jsonError(400, "INVALID_ARGUMENT", "任务分页游标无效");

    const notebookId = url.searchParams.get("notebookId");
    if (notebookId) {
      const notebook = await first(
        database,
        "SELECT id FROM notebooks WHERE id = ? AND user_id = ?",
        notebookId,
        user.id,
      );
      if (!notebook) return jsonError(404, "NOT_FOUND", "笔记本不存在");
    }

    const filters = ["t.user_id = ?", "n.deleted_at IS NULL"];
    const values: Array<string | number> = [user.id];
    if (notebookId) {
      filters.push("t.notebook_id = ?");
      values.push(notebookId);
    }
    if (status !== "all") {
      filters.push("t.done = ?");
      values.push(status === "done" ? 1 : 0);
    }
    if (cursor) {
      filters.push("(t.sort_created_at, t.note_id, t.ordinal) > (?, ?, ?)");
      values.push(cursor.sortCreatedAt, cursor.noteId, cursor.ordinal);
    }

    const rows = await all<{
      note_id: string;
      note_title: string;
      notebook_id: string;
      notebook_name: string;
      version: number;
      text: string;
      done: number;
      ordinal: number;
      depth: number;
      sort_created_at: number;
    }>(
      database,
      `
        SELECT t.note_id, n.title AS note_title, t.notebook_id, b.name AS notebook_name,
          n.version, t.text, t.done, t.ordinal, t.depth, t.sort_created_at
        FROM note_tasks t
        JOIN notes n ON n.id = t.note_id AND n.user_id = t.user_id
        JOIN notebooks b ON b.id = t.notebook_id AND b.user_id = t.user_id
        WHERE ${filters.join(" AND ")}
        ORDER BY t.sort_created_at ASC, t.note_id ASC, t.ordinal ASC
        LIMIT ?
      `,
      ...values,
      limit + 1,
    );
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const tasks = pageRows.map((task) => ({
      noteId: task.note_id,
      noteTitle: task.note_title,
      notebookId: task.notebook_id,
      notebookName: task.notebook_name,
      version: task.version,
      text: task.text,
      done: task.done === 1,
      ordinal: task.ordinal,
      depth: task.depth,
    }));
    const last = pageRows.at(-1);
    const nextCursor =
      hasMore && last
        ? encodeTaskCursor({
            sortCreatedAt: last.sort_created_at,
            noteId: last.note_id,
            ordinal: last.ordinal,
          })
        : null;

    let total: number | undefined;
    if (!cursor) {
      const countFilters = ["user_id = ?"];
      const countValues: Array<string | number> = [user.id];
      if (notebookId) {
        countFilters.push("notebook_id = ?");
        countValues.push(notebookId);
      }
      if (status !== "all") {
        countFilters.push("done = ?");
        countValues.push(status === "done" ? 1 : 0);
      }
      const count = await first<{ total: number }>(
        database,
        `
          SELECT COALESCE(SUM(task_count), 0) AS total
          FROM note_task_counts
          WHERE ${countFilters.join(" AND ")}
        `,
        ...countValues,
      );
      total = Number(count?.total ?? 0);
    }
    return json({ tasks, total, nextCursor });
  }

  if (resource === "tasks" && id === "toggle" && method === "POST") {
    const payload = await readJson<{
      noteId?: unknown;
      version?: unknown;
      ordinal?: unknown;
      text?: unknown;
      completed?: unknown;
    }>(request, 64 * 1024);
    if (
      !payload ||
      typeof payload.noteId !== "string" ||
      !NOTE_ID_PATTERN.test(payload.noteId) ||
      !Number.isSafeInteger(payload.version) ||
      (payload.version as number) < 1 ||
      !Number.isSafeInteger(payload.ordinal) ||
      (payload.ordinal as number) < 0 ||
      typeof payload.text !== "string" ||
      payload.text.length > 10000 ||
      typeof payload.completed !== "boolean"
    )
      return jsonError(400, "INVALID_ARGUMENT", "任务定位信息无效");

    const current = await getNote(database, user.id, payload.noteId);
    if (!current || current.deleted_at !== null) return jsonError(404, "NOT_FOUND", "笔记不存在");
    if (current.version !== payload.version)
      return jsonError(409, "VERSION_CONFLICT", "笔记已发生变化，请刷新任务列表后重试");

    const task = extractMarkdownTasks(current.content_markdown)[payload.ordinal as number];
    if (!task || task.text !== payload.text || task.completed !== payload.completed)
      return jsonError(409, "VERSION_CONFLICT", "任务已发生变化，请刷新任务列表后重试");

    const marker = findMarkdownTaskMarker(current.content_markdown, task.ordinal);
    if (!marker || marker.checked !== task.completed)
      return jsonError(409, "VERSION_CONFLICT", "无法安全定位任务，请刷新任务列表后重试");

    const replacement = task.completed ? "[ ]" : "[x]";
    const contentMarkdown =
      current.content_markdown.slice(0, marker.start) +
      replacement +
      current.content_markdown.slice(marker.end);
    if (
      !(await updateNote(
        database,
        current,
        user.id,
        current.title,
        contentMarkdown,
        current.notebook_id,
        current.is_favorite,
        current.deleted_at,
      ))
    )
      return jsonError(409, "VERSION_CONFLICT", "笔记已发生变化，请刷新任务列表后重试");

    const updated = await getNote(database, user.id, payload.noteId);
    publishWorkspaceChange(
      options,
      user.id,
      { resource: "notes", noteId: payload.noteId },
      request,
    );
    return updated
      ? json({ note: toFullNote(updated) })
      : jsonError(404, "NOT_FOUND", "笔记不存在");
  }

  if (resource === "wiki-notes" && id === "suggestions" && method === "GET") {
    const query = normalizeLinkTitle(url.searchParams.get("query")?.slice(0, 80) ?? "");
    if (!query) return json({ matches: [], exactMatch: false });

    const exactMatch = Boolean(
      await first(
        database,
        "SELECT id FROM notes WHERE user_id = ? AND deleted_at IS NULL AND title_normalized = ? LIMIT 1",
        user.id,
        query,
      ),
    );
    const matches = (
      await all<{ title: string; notebook_name: string }>(
        database,
        `
        SELECT n.title, b.name AS notebook_name
        FROM notes n
        JOIN notebooks b ON b.id = n.notebook_id AND b.user_id = n.user_id
        WHERE n.user_id = ? AND n.deleted_at IS NULL
          AND instr(n.title_normalized, ?) > 0
          AND n.id = (
            SELECT matched.id
            FROM notes matched
            WHERE matched.user_id = n.user_id
              AND matched.deleted_at IS NULL
              AND matched.title_normalized = n.title_normalized
            ORDER BY matched.updated_at DESC, matched.id
            LIMIT 1
          )
        ORDER BY
          CASE
            WHEN n.title_normalized = ? THEN 0
            WHEN n.title_normalized LIKE ? ESCAPE '!' THEN 1
            ELSE 2
          END,
          length(n.title), n.updated_at DESC, n.title_normalized, n.id
        LIMIT 6
      `,
        user.id,
        query,
        query,
        `${escapeLikePattern(query)}%`,
      )
    ).map((row) => ({ title: row.title, notebookName: row.notebook_name }));

    return json({ matches, exactMatch });
  }

  // Empty trash
  if (
    method === "DELETE" &&
    (url.pathname === "/api/trash" || (resource === "notes" && id === "trash"))
  ) {
    const assetPaths = await assetPathsForTrash(database, user.id);
    const trashedNotes = await all<{
      id: string;
      notebook_id: string;
      created_at: number;
    }>(
      database,
      "SELECT id, notebook_id, created_at FROM notes WHERE user_id = ? AND deleted_at IS NOT NULL",
      user.id,
    );
    for (const note of trashedNotes) {
      await syncNoteTasks(database, user.id, note.id, note.notebook_id, note.created_at, "");
    }
    const deletedCount = trashedNotes.length;
    await database
      .query("DELETE FROM notes WHERE user_id = ? AND deleted_at IS NOT NULL")
      .run(user.id);
    if (deletedCount > 0) publishWorkspaceChange(options, user.id, { resource: "notes" }, request);
    if (options.assets) await removeAssetFiles(options.assets, assetPaths);
    return json({ ok: true, deletedCount });
  }

  // Ensure wiki-notes target
  if (resource === "wiki-notes" && id === "ensure" && method === "POST") {
    const payload = await readJson<{ title?: unknown; notebookId?: unknown }>(request, 64 * 1024);
    if (
      !payload ||
      !validText(payload.title, 200) ||
      !(payload.title as string).trim() ||
      typeof payload.notebookId !== "string"
    ) {
      return jsonError(400, "INVALID_WIKI_TARGET", "双向链接目标无效");
    }
    const title = (payload.title as string).trim();
    if (
      !(await first(
        database,
        "SELECT id FROM notebooks WHERE id = ? AND user_id = ?",
        payload.notebookId,
        user.id,
      ))
    ) {
      return jsonError(404, "NOTEBOOK_NOT_FOUND", "笔记本不存在");
    }
    const existingId = await findActiveNoteIdByTitle(database, user.id, title);
    const existing = existingId ? await getNote(database, user.id, existingId) : null;
    const ensured = existing
      ? { note: toFullNote(existing), created: false as const }
      : await (async () => {
          const noteId = await createNote(
            database,
            user.id,
            payload.notebookId as string,
            title,
            "",
          );
          const note = await getNote(database, user.id, noteId);
          return note ? { note: toFullNote(note), created: true as const, noteId } : null;
        })();
    if (!ensured) return jsonError(500, "NOTE_CREATE_FAILED", "笔记创建失败");
    // 新笔记会改变列表成员，广播不带 noteId，让其他客户端整表刷新。
    if (ensured.created) publishWorkspaceChange(options, user.id, { resource: "notes" }, request);
    return ensured.created
      ? json({ note: ensured.note, created: true }, 201)
      : json({ note: ensured.note, created: false });
  }

  if (resource !== "notes") return null;

  // Batch move to trash or permanent deletion. Both operations validate every
  // selected note in one transaction so a stale selection cannot partially apply.
  if (id === "batch" && (method === "PATCH" || method === "DELETE")) {
    const payload = await readJson<{ notes?: unknown; deleted?: unknown }>(
      request,
      NOTE_BATCH_BODY_MAX_BYTES,
    );
    if (
      method === "PATCH" &&
      payload?.deleted !== undefined &&
      typeof payload.deleted !== "boolean"
    ) {
      return jsonError(400, "INVALID_BATCH_NOTES", "批量回收站状态无效");
    }
    const entries = parseBatchNoteEntries(payload);
    if (!entries) return jsonError(400, "INVALID_BATCH_NOTES", "批量操作的笔记参数无效");

    if (method === "PATCH") {
      if (payload?.deleted === false) {
        let restored: { restoredIds: string[] };
        try {
          const rows = await getBatchNoteStates(database, user.id, entries);
          assertBatchNoteStates(rows, entries, "restore");
          const restoredAt = now();
          const rowsById = new Map(rows.map((row) => [row.id, row]));
          for (const entry of entries) {
            const note = rowsById.get(entry.id)!;
            await syncNoteTasks(
              database,
              user.id,
              note.id,
              note.notebook_id,
              note.created_at,
              note.content_markdown,
            );
          }
          const expected = entries.map(() => "(?, ?)").join(", ");
          const values: SqlValue[] = entries.flatMap((entry) => [entry.id, entry.version]);
          values.push(restoredAt, user.id, user.id, entries.length);
          const updated = await database
            .query(
              `
            WITH expected(id, version) AS (VALUES ${expected})
            UPDATE notes SET deleted_at = NULL, version = version + 1, updated_at = ?
            WHERE user_id = ? AND deleted_at IS NOT NULL
              AND EXISTS (SELECT 1 FROM expected e WHERE e.id = notes.id AND e.version = notes.version)
              AND (SELECT COUNT(*) FROM notes n JOIN expected e ON e.id = n.id AND e.version = n.version WHERE n.user_id = ? AND n.deleted_at IS NOT NULL) = ?
            RETURNING id
          `,
            )
            .all<{ id: string }>(...values);
          if (updated.length !== entries.length)
            throw new BatchNoteConflictError(entries.map((entry) => entry.id));
          await resolveNoteLinksForTitles(
            database,
            user.id,
            rows.map((row) => row.title),
          );
          restored = { restoredIds: entries.map((entry) => entry.id) };
        } catch (error) {
          if (error instanceof BatchNoteConflictError) return batchConflictResponse(error);
          throw error;
        }
        publishWorkspaceChange(options, user.id, { resource: "notes" }, request);
        return json({ ok: true, restoredIds: restored.restoredIds });
      }

      let moved: { deletedIds: string[] };
      try {
        const rows = await getBatchNoteStates(database, user.id, entries);
        assertBatchNoteStates(rows, entries, "trash");
        const deletedAt = now();
        const rowsById = new Map(rows.map((row) => [row.id, row]));
        for (const entry of entries) {
          const note = rowsById.get(entry.id)!;
          await syncNoteTasks(database, user.id, note.id, note.notebook_id, note.created_at, "");
        }
        const expected = entries.map(() => "(?, ?)").join(", ");
        const values: SqlValue[] = entries.flatMap((entry) => [entry.id, entry.version]);
        values.push(deletedAt, deletedAt, user.id, user.id, entries.length);
        const updated = await database
          .query(
            `
          WITH expected(id, version) AS (VALUES ${expected})
          UPDATE notes SET deleted_at = ?, version = version + 1, updated_at = ?
          WHERE user_id = ? AND deleted_at IS NULL
            AND EXISTS (SELECT 1 FROM expected e WHERE e.id = notes.id AND e.version = notes.version)
            AND (SELECT COUNT(*) FROM notes n JOIN expected e ON e.id = n.id AND e.version = n.version WHERE n.user_id = ? AND n.deleted_at IS NULL) = ?
          RETURNING id
        `,
          )
          .all<{ id: string }>(...values);
        if (updated.length !== entries.length)
          throw new BatchNoteConflictError(entries.map((entry) => entry.id));
        await resolveNoteLinksForTitles(
          database,
          user.id,
          rows.map((row) => row.title),
        );
        moved = { deletedIds: entries.map((entry) => entry.id) };
      } catch (error) {
        if (error instanceof BatchNoteConflictError) return batchConflictResponse(error);
        throw error;
      }
      publishWorkspaceChange(options, user.id, { resource: "notes" }, request);
      return json({ ok: true, deletedIds: moved.deletedIds });
    }

    let deleted: { deletedIds: string[]; assetPaths: string[] };
    try {
      const rows = await getBatchNoteStates(database, user.id, entries);
      assertBatchNoteStates(rows, entries, "permanent");
      const deletedIds = entries.map((entry) => entry.id);
      const assetPaths = await assetPathsForNotes(database, user.id, deletedIds);
      for (const note of rows) {
        await syncNoteTasks(database, user.id, note.id, note.notebook_id, note.created_at, "");
      }
      const deleteStatements: { sql: string; values: SqlValue[] }[] = [];
      for (const noteId of deletedIds) {
        deleteStatements.push({
          sql: "DELETE FROM note_links WHERE user_id = ? AND source_note_id = ?",
          values: [user.id, noteId],
        });
      }
      const expected = entries.map(() => "(?, ?)").join(", ");
      const values: SqlValue[] = entries.flatMap((entry) => [entry.id, entry.version]);
      values.push(user.id, user.id, entries.length);
      const deletedRows = await database
        .query(
          `
        WITH expected(id, version) AS (VALUES ${expected})
        DELETE FROM notes
        WHERE user_id = ? AND deleted_at IS NOT NULL
          AND EXISTS (SELECT 1 FROM expected e WHERE e.id = notes.id AND e.version = notes.version)
          AND (SELECT COUNT(*) FROM notes n JOIN expected e ON e.id = n.id AND e.version = n.version WHERE n.user_id = ? AND n.deleted_at IS NOT NULL) = ?
        RETURNING id
      `,
        )
        .all<{ id: string }>(...values);
      if (deletedRows.length !== entries.length)
        throw new BatchNoteConflictError(entries.map((entry) => entry.id));
      if (deleteStatements.length > 0) await database.batch(deleteStatements);
      deleted = { deletedIds, assetPaths };
    } catch (error) {
      if (error instanceof BatchNoteConflictError) return batchConflictResponse(error);
      throw error;
    }
    publishWorkspaceChange(options, user.id, { resource: "notes" }, request);
    if (options.assets) await removeAssetFiles(options.assets, deleted.assetPaths);
    return json({ ok: true, deletedIds: deleted.deletedIds });
  }

  // List notes
  if (!id && method === "GET") {
    const view = url.searchParams.get("view") ?? "all";
    if (!NOTE_VIEWS.includes(view as NoteView))
      return jsonError(400, "INVALID_VIEW", "不支持的笔记视图");
    const query = url.searchParams.get("query")?.slice(0, 80) ?? "";
    const notebookId = url.searchParams.get("notebookId");
    const rawTag = url.searchParams.get("tag")?.trim() ?? "";
    const rawTags = url.searchParams.getAll("tags");
    if (rawTags.length > 20)
      return jsonError(400, "INVALID_ARGUMENT", "标签筛选最多包含 20 个标签");
    const parsedTags = rawTags.map((tag) => parseTagQuery(tag.startsWith("#") ? tag : `#${tag}`));
    const invalidTags = rawTags.filter((_, index) => !parsedTags[index]);
    if (invalidTags.length)
      return json(
        {
          error: {
            code: "INVALID_ARGUMENT",
            field: "tags",
            invalidTags,
            message: "字段 tags 包含无效标签",
          },
        },
        400,
      );
    const tagMode = url.searchParams.get("tagMode") ?? "all";
    if (tagMode !== "all" && tagMode !== "any")
      return jsonError(400, "INVALID_ARGUMENT", "tagMode 必须为 all 或 any");
    const explicitTagQuery = rawTag
      ? parseTagQuery(rawTag.startsWith("#") ? rawTag : `#${rawTag}`)
      : null;
    if (rawTag && !explicitTagQuery) {
      return json(
        {
          error: {
            code: "INVALID_ARGUMENT",
            field: "tag",
            invalidTags: [rawTag],
            message:
              "字段 tag 格式无效；标签只能包含中文、字母、数字、下划线或连字符，最多 40 个 UTF-16 code units",
          },
        },
        400,
      );
    }
    const tagQuery = parseTagQuery(query);
    const tagFilters = [
      ...new Set(
        [tagQuery, explicitTagQuery, ...parsedTags].filter((tag): tag is string => Boolean(tag)),
      ),
    ];
    const normalizedTagFilters = [...new Set(tagFilters.map(normalizeTag))];
    const conditions = ["n.user_id = ?"];
    const params: SqlValue[] = [user.id];
    let from = NOTE_FROM;
    const rawSort = url.searchParams.get("sort") ?? "updated";
    if (rawSort !== "relevance" && !NOTE_SORTS.includes(rawSort as NoteSort))
      return jsonError(400, "INVALID_SORT", "不支持的笔记排序方式");
    const sort: SearchSort =
      rawSort === "relevance" && !query.trim() ? "updated" : (rawSort as SearchSort);
    const includeTotal = url.searchParams.get("includeTotal") !== "0";
    const includeMatch = url.searchParams.get("includeMatch") === "1";
    let rankingCte = "";
    const rankingParams: SqlValue[] = [];
    let scoreExpression = "0";
    const parsedSearch = query && !tagQuery ? parseSearchTerms(query) : null;
    const searchTokens = parsedSearch?.tokens ?? [];
    const directTokens = parsedSearch?.directTokens ?? [];
    const filterNotebookIds: string[] = [];

    if (view === "trash") conditions.push("n.deleted_at IS NOT NULL");
    else conditions.push("n.deleted_at IS NULL");
    if (view === "inbox") {
      const inbox = await first<{ id: string }>(
        database,
        "SELECT id FROM notebooks WHERE user_id = ? AND is_system = 1 LIMIT 1",
        user.id,
      );
      conditions.push("n.notebook_id = ?");
      const inboxId = inbox?.id ?? "";
      params.push(inboxId);
      filterNotebookIds.push(inboxId);
    }
    if (view === "favorites") conditions.push("n.is_favorite = 1");
    if (notebookId) {
      conditions.push("n.notebook_id = ?");
      params.push(notebookId);
      filterNotebookIds.push(notebookId);
    }
    if (parsedSearch) {
      const { tokens, ftsTokens, directTokens } = parsedSearch;
      if (tokens.length === 0) return json({ notes: [], total: 0 });

      if (ftsTokens.length > 0) {
        const ftsQuery = ftsTokens.map((part) => `"${part.replaceAll('"', '""')}"`).join(" AND ");
        if (sort === "relevance") {
          rankingCte = `WITH search_rank AS MATERIALIZED (
            SELECT notes_fts.rowid, bm25(notes_fts, 8.0, 1.0) AS score
            FROM notes_fts JOIN notes search_owner ON search_owner.rowid = notes_fts.rowid
            WHERE search_owner.user_id = ? AND notes_fts MATCH ?
          )`;
          rankingParams.push(user.id, ftsQuery);
          from += " JOIN search_rank ON search_rank.rowid = n.rowid";
          scoreExpression = "search_rank.score";
        } else {
          conditions.push("n.rowid IN (SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?)");
          params.push(ftsQuery);
        }
      }
    }
    const scope =
      sort === "relevance"
        ? await digestHex(
            JSON.stringify([user.id, query, notebookId, view, normalizedTagFilters, tagMode]),
          )
        : undefined;
    const cursor = decodeNoteListCursor(url.searchParams.get("cursor"), sort);
    if (url.searchParams.get("cursor") && !cursor)
      return jsonError(400, "INVALID_CURSOR", "笔记列表游标无效");
    if (cursor && sort === "relevance" && cursor.scope !== scope)
      return jsonError(400, "INVALID_CURSOR", "笔记列表游标与搜索条件不一致");
    if (url.searchParams.has("offset")) return jsonError(400, "INVALID_OFFSET", "请使用游标分页");
    const rawLimit = url.searchParams.get("limit");
    const pageLimit = rawLimit === null ? NOTE_PAGE_SIZE : Number(rawLimit);
    if (!Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > NOTE_PAGE_SIZE)
      return jsonError(400, "INVALID_LIMIT", `每页数量必须介于 1 和 ${NOTE_PAGE_SIZE} 之间`);
    if (normalizedTagFilters.length) {
      const tagConditions = normalizedTagFilters.map(
        () =>
          "EXISTS (SELECT 1 FROM note_tags t WHERE t.note_id = n.id AND t.user_id = n.user_id AND t.tag_normalized = ?)",
      );
      conditions.push(`(${tagConditions.join(tagMode === "any" ? " OR " : " AND ")})`);
      params.push(...normalizedTagFilters);
    }
    if (directTokens.length) {
      const candidates = (await database
        .query(
          `
          ${rankingCte}
          SELECT ${NOTE_SELECT}, ${scoreExpression} AS relevance_score,
            COALESCE((SELECT json_group_array(tag) FROM (
              SELECT tag FROM note_tags WHERE note_id = n.id ORDER BY position
            )), '[]') AS tags_json
          FROM ${from}
          WHERE ${conditions.join(" AND ")}
        `,
        )
        .all(...rankingParams, ...params)) as Array<
        NoteRow & { tags_json: string; relevance_score: number }
      >;
      const matched = candidates
        .filter((row) =>
          directTokens.every(
            (token) =>
              searchContains(row.title, token) || searchContains(row.content_markdown, token),
          ),
        )
        .map((row) => ({
          ...row,
          relevance_score: rankingCte
            ? Number(row.relevance_score)
            : directTokens.reduce(
                (score, token) => score + (searchContains(row.title, token) ? -8 : -1),
                0,
              ),
        }));
      const compareTitle = (left: string, right: string) => {
        const normalizedLeft = left.toLowerCase();
        const normalizedRight = right.toLowerCase();
        return normalizedLeft < normalizedRight ? -1 : normalizedLeft > normalizedRight ? 1 : 0;
      };
      matched.sort((left, right) => {
        if (sort === "relevance")
          return left.relevance_score - right.relevance_score || left.id.localeCompare(right.id);
        if (sort === "title")
          return compareTitle(left.title, right.title) || left.id.localeCompare(right.id);
        const leftValue = sort === "created" ? left.created_at : left.updated_at;
        const rightValue = sort === "created" ? right.created_at : right.updated_at;
        return rightValue - leftValue || right.id.localeCompare(left.id);
      });
      const total = matched.length;
      const afterCursor = cursor
        ? matched.filter((row) => {
            if (sort === "relevance")
              return (
                row.relevance_score > Number(cursor.value) ||
                (row.relevance_score === Number(cursor.value) && row.id > cursor.id)
              );
            if (sort === "title")
              return (
                compareTitle(row.title, String(cursor.value)) > 0 ||
                (compareTitle(row.title, String(cursor.value)) === 0 && row.id > cursor.id)
              );
            const value = sort === "created" ? row.created_at : row.updated_at;
            const cursorValue = Number(cursor.value);
            return value < cursorValue || (value === cursorValue && row.id < cursor.id);
          })
        : matched;
      const pageRows = afterCursor.slice(0, pageLimit + 1);
      return respondNoteList(
        pageRows,
        pageLimit,
        sort,
        scope,
        searchTokens,
        normalizedTagFilters,
        includeMatch,
        includeTotal,
        total,
        new Map(pageRows.map((row) => [row.id, row.content_markdown])),
      );
    }
    const totalWhere = conditions.join(" AND ") || "1";
    const totalParams = [...params];
    if (cursor) {
      if (sort === "relevance") {
        if (typeof cursor.value !== "number" || !Number.isFinite(cursor.value))
          return jsonError(400, "INVALID_CURSOR", "笔记列表游标无效");
        conditions.push(`(${scoreExpression} > ? OR (${scoreExpression} = ? AND n.id > ?))`);
        params.push(cursor.value, cursor.value, cursor.id);
      } else if (sort === "title") {
        if (typeof cursor.value !== "string")
          return jsonError(400, "INVALID_CURSOR", "笔记列表游标无效");
        conditions.push(
          "(n.title COLLATE NOCASE > ? OR (n.title COLLATE NOCASE = ? AND n.id > ?))",
        );
        params.push(cursor.value, cursor.value, cursor.id);
      } else {
        if (typeof cursor.value !== "number" || !Number.isSafeInteger(cursor.value))
          return jsonError(400, "INVALID_CURSOR", "笔记列表游标无效");
        const column = sort === "created" ? "n.created_at" : "n.updated_at";
        conditions.push(`(${column}, n.id) < (?, ?)`);
        params.push(cursor.value, cursor.id);
      }
    }
    const optimizedPlan =
      parsedSearch && parsedSearch.ftsTokens.length > 0 && directTokens.length === 0
        ? buildOptimizedNoteListPlan({
            userId: user.id,
            view: view as NoteView,
            sort,
            notebookIds: filterNotebookIds,
            ftsTokens: parsedSearch.ftsTokens,
            normalizedTagFilters,
            tagMode,
            pageLimit,
            cursor: cursor ? { value: cursor.value, id: cursor.id } : null,
            includeTotal,
          })
        : null;
    if (optimizedPlan) {
      const totalRow = optimizedPlan.countSql
        ? await first<{ count: number }>(
            database,
            optimizedPlan.countSql,
            ...optimizedPlan.countParams,
          )
        : null;
      const rows = (await database
        .query(optimizedPlan.sql)
        .all(...optimizedPlan.params)) as (NoteRow & {
        tags_json: string;
        relevance_score: number;
      })[];
      const fullContents = includeMatch
        ? await loadSearchContents(database, user.id, rows)
        : new Map<string, string>();
      return respondNoteList(
        rows,
        pageLimit,
        sort,
        scope,
        searchTokens,
        normalizedTagFilters,
        includeMatch,
        includeTotal,
        totalRow ? Number(totalRow.count) : null,
        fullContents,
      );
    }
    const where = conditions.join(" AND ") || "1";
    const totalRow = includeTotal
      ? await first<{ count: number }>(
          database,
          `${rankingCte} SELECT COUNT(*) AS count FROM ${from} WHERE ${totalWhere}`,
          ...[...rankingParams, ...totalParams],
        )
      : null;
    const listStatement = database.query(`
      ${rankingCte} SELECT ${NOTE_LIST_SELECT}, ${scoreExpression} AS relevance_score
      FROM ${from} WHERE ${where} ORDER BY ${sort === "relevance" ? `${scoreExpression} ASC, n.id ASC` : noteListOrder(sort)} LIMIT ?
    `);
    const rows = (await listStatement.all(
      ...rankingParams,
      ...params,
      pageLimit + 1,
    )) as (NoteRow & { tags_json: string; relevance_score: number })[];
    const fullContents = includeMatch
      ? await loadSearchContents(database, user.id, rows)
      : new Map<string, string>();
    return respondNoteList(
      rows,
      pageLimit,
      sort,
      scope,
      searchTokens,
      normalizedTagFilters,
      includeMatch,
      includeTotal,
      includeTotal ? Number(totalRow?.count ?? 0) : null,
      fullContents,
    );
  }

  // Create note
  if (!id && method === "POST") {
    const payload = await readJson<{
      id?: unknown;
      title?: unknown;
      contentMarkdown?: unknown;
      notebookId?: unknown;
    }>(request, NOTE_BODY_MAX_BYTES);
    if (!payload) return jsonError(400, "INVALID_JSON", "请求体无效或超出大小限制");
    const rawTitle = payload?.title === undefined ? "未命名笔记" : payload.title;
    const contentMarkdown = payload?.contentMarkdown === undefined ? "" : payload.contentMarkdown;
    if (typeof rawTitle !== "string" || typeof contentMarkdown !== "string")
      return jsonError(400, "INVALID_NOTE", "笔记标题或正文格式无效");
    if (!validText(rawTitle, 200) || !validNoteContent(contentMarkdown))
      return jsonError(
        413,
        "NOTE_TOO_LARGE",
        `笔记正文最多 ${NOTE_CONTENT_MAX_LENGTH.toLocaleString("en-US")} 个 UTF-16 code units 且不超过 ${NOTE_CONTENT_MAX_BYTES.toLocaleString("en-US")} 个 UTF-8 字节`,
      );
    const title = normalizeNoteTitle(rawTitle as string);
    const defaultNotebook =
      typeof payload?.notebookId === "string"
        ? null
        : await first<{ id: string }>(
            database,
            "SELECT id FROM notebooks WHERE user_id = ? AND is_system = 1 LIMIT 1",
            user.id,
          );
    const notebookId =
      typeof payload?.notebookId === "string" ? payload.notebookId : defaultNotebook?.id;
    if (!notebookId) return jsonError(400, "NO_NOTEBOOK", "没有可用的收件箱");
    if (
      !(await first(
        database,
        "SELECT id FROM notebooks WHERE id = ? AND user_id = ?",
        notebookId,
        user.id,
      ))
    )
      return jsonError(404, "NOTEBOOK_NOT_FOUND", "笔记本不存在");
    if (!(await validNoteAssetReferences(database, user.id, null, contentMarkdown as string)))
      return jsonError(400, "INVALID_ASSET", "图片引用无效、不受支持或附件当前不可用");
    const requestedId = payload?.id === undefined ? undefined : payload.id;
    if (requestedId !== undefined) {
      if (typeof requestedId !== "string" || !NOTE_ID_PATTERN.test(requestedId)) {
        return jsonError(400, "INVALID_NOTE", "笔记 ID 必须是 UUID");
      }
      if (await first(database, "SELECT 1 FROM notes WHERE id = ?", requestedId)) {
        return jsonError(409, "NOTE_EXISTS", "指定 ID 的笔记已存在");
      }
    }
    const noteId = await createNote(
      database,
      user.id,
      notebookId,
      title,
      contentMarkdown as string,
      requestedId,
    );
    const note = await getNote(database, user.id, noteId);
    // 新笔记会改变列表成员，广播不带 noteId，让其他客户端整表刷新。
    publishWorkspaceChange(options, user.id, { resource: "notes" }, request);
    const summaryResponse = url.searchParams.get("response") === "summary";
    return json(
      { note: note ? (summaryResponse ? summarizeNote(note) : toFullNote(note)) : null },
      201,
    );
  }

  // Backlinks
  if (id && subresource === "backlinks" && method === "GET") {
    const note = await getNote(database, user.id, id);
    if (!note) return jsonError(404, "NOTE_NOT_FOUND", "笔记不存在");

    const linkedRows = await all<{
      link_id: string;
      source_note_id: string;
      source_title: string;
      link_snippet: string | null;
      source_content_char_count: number;
      source_updated_at: number;
      notebook_name: string;
      target_title: string;
      target_note_id: string | null;
    }>(
      database,
      `
      SELECT nl.id AS link_id, nl.source_note_id, n.title AS source_title,
        nl.snippet AS link_snippet,
        length(n.content_markdown) AS source_content_char_count,
        n.updated_at AS source_updated_at, nb.name AS notebook_name, nl.target_title, nl.target_note_id
      FROM note_links nl
      JOIN notes n ON nl.source_note_id = n.id AND n.user_id = nl.user_id
      JOIN notebooks nb ON n.notebook_id = nb.id
      WHERE nl.user_id = ? AND nl.target_note_id = ? AND nl.source_note_id != ? AND n.deleted_at IS NULL
      ORDER BY n.updated_at DESC
      LIMIT ?
    `,
      user.id,
      note.id,
      note.id,
      BACKLINK_REFERENCE_LIMIT + 1,
    );
    let linkedContentStatement: ReturnType<SqliteDatabase["query"]> | null = null;
    const linkedReferences: NoteLinkSummary[] = [];
    let truncated = false;
    let scanBudgetExhausted = false;
    let scannedChars = 0;
    for (const row of linkedRows) {
      if (linkedReferences.length >= BACKLINK_REFERENCE_LIMIT) {
        truncated = true;
        break;
      }
      let snippet = row.link_snippet?.trim() || "";
      if (!snippet) {
        // Fallback for legacy records without stored snippet
        if (row.source_content_char_count > BACKLINK_SCAN_CHAR_LIMIT - scannedChars) {
          truncated = true;
          scanBudgetExhausted = true;
          break;
        }
        if (!linkedContentStatement) {
          linkedContentStatement = database.query(
            "SELECT content_markdown FROM notes WHERE id = ? AND user_id = ?",
          );
        }
        const source = (await linkedContentStatement.get(row.source_note_id, user.id)) as {
          content_markdown: string;
        } | null;
        if (!source) continue;
        scannedChars += source.content_markdown.length;
        if (scannedChars > BACKLINK_SCAN_CHAR_LIMIT) {
          truncated = true;
          scanBudgetExhausted = true;
          break;
        }
        const links = extractWikiLinks(source.content_markdown);
        const matched = links.find(
          (l) =>
            normalizeLinkTitle(l.target) === normalizeLinkTitle(row.target_title) ||
            normalizeLinkTitle(l.target) === normalizeLinkTitle(note.title),
        );
        snippet = matched
          ? extractContextSnippet(source.content_markdown, matched.start, matched.end)
          : source.content_markdown.slice(0, 100);
      }
      linkedReferences.push({
        id: row.link_id,
        sourceNoteId: row.source_note_id,
        sourceNoteTitle: row.source_title,
        sourceNotebookName: row.notebook_name,
        targetTitle: row.target_title,
        targetNoteId: row.target_note_id,
        snippet,
        updatedAt: row.source_updated_at,
      });
    }

    const unlinkedMentions: UnlinkedMention[] = [];
    const trimmedTitle = note.title.trim();
    if (trimmedTitle.length >= 2 && !scanBudgetExhausted) {
      const { ftsTokens } = parseSearchTerms(trimmedTitle);
      const useFts = trimmedTitle.length >= 3 && ftsTokens.length > 0;
      let candidateFrom = "notes n JOIN notebooks nb ON n.notebook_id = nb.id";
      const candidateConditions = ["n.user_id = ?", "n.deleted_at IS NULL", "n.id != ?"];
      const candidateParams: SqlValue[] = [user.id, note.id];

      if (useFts) {
        candidateConditions.push(
          "EXISTS (SELECT 1 FROM notes_fts WHERE notes_fts.rowid = n.rowid AND notes_fts MATCH ?)",
        );
        candidateParams.push(ftsTokens.map((p) => `"${p.replaceAll('"', '""')}"`).join(" AND "));
      }

      const candidateSql = `
        SELECT n.id, n.title, length(n.content_markdown) AS content_char_count,
          nb.name AS notebook_name, n.version, n.updated_at
          ${useFts ? "" : ", n.content_markdown"}
        FROM ${candidateFrom}
        WHERE ${candidateConditions.join(" AND ")}
        ORDER BY n.updated_at DESC
        ${useFts ? "LIMIT ?" : ""}
      `;
      if (useFts) candidateParams.push(BACKLINK_CANDIDATE_LIMIT + 1);
      const candidateRows = (await database.query(candidateSql).all(...candidateParams)) as Array<{
        id: string;
        title: string;
        content_char_count: number;
        notebook_name: string;
        version: number;
        updated_at: number;
        content_markdown?: string;
      }>;
      const candidateContentStatement = database.query(
        "SELECT content_markdown FROM notes WHERE id = ? AND user_id = ?",
      );
      let candidateCount = 0;
      mentionLoop: for (const candidate of candidateRows) {
        if (!useFts && !searchContains(candidate.content_markdown ?? "", trimmedTitle)) continue;
        candidateCount += 1;
        if (candidateCount > BACKLINK_CANDIDATE_LIMIT) {
          truncated = true;
          break;
        }
        if (candidate.content_char_count > BACKLINK_SCAN_CHAR_LIMIT - scannedChars) {
          truncated = true;
          break;
        }
        const source = candidate.content_markdown
          ? { content_markdown: candidate.content_markdown }
          : ((await candidateContentStatement.get(candidate.id, user.id)) as {
              content_markdown: string;
            } | null);
        if (!source) continue;
        scannedChars += source.content_markdown.length;
        if (scannedChars > BACKLINK_SCAN_CHAR_LIMIT) {
          truncated = true;
          break;
        }
        const mentions = findUnlinkedMentionsInMarkdown(source.content_markdown, note.title);
        for (const m of mentions) {
          if (unlinkedMentions.length >= BACKLINK_MENTION_LIMIT) {
            truncated = true;
            break mentionLoop;
          }
          unlinkedMentions.push({
            sourceNoteId: candidate.id,
            sourceNoteTitle: candidate.title,
            sourceNotebookName: candidate.notebook_name,
            snippet: m.snippet,
            matchIndex: m.start,
            matchText: m.matchText,
            sourceVersion: candidate.version,
            updatedAt: candidate.updated_at,
          });
        }
      }
    }

    const payload: NoteBacklinksResponse = { linkedReferences, unlinkedMentions, truncated };
    return json(payload);
  }

  // Link mention
  if (id && subresource === "link-mention" && method === "POST") {
    const targetNote = await getNote(database, user.id, id);
    if (!targetNote) return jsonError(404, "NOTE_NOT_FOUND", "目标笔记不存在");
    if (targetNote.deleted_at !== null)
      return jsonError(409, "NOTE_IN_TRASH", "回收站中的笔记只读，请先恢复笔记后再修改");

    const payload = await readJson<{
      sourceNoteId?: unknown;
      sourceVersion?: unknown;
      matchStart?: unknown;
      matchEnd?: unknown;
      matchText?: unknown;
    }>(request, 10_000);
    if (
      !payload ||
      typeof payload.sourceNoteId !== "string" ||
      !Number.isInteger(payload.sourceVersion) ||
      !Number.isInteger(payload.matchStart) ||
      !Number.isInteger(payload.matchEnd) ||
      !validText(payload.matchText, 200) ||
      !payload.matchText
    ) {
      return jsonError(400, "INVALID_MENTION_PAYLOAD", "提及参数无效");
    }

    const sourceNote = await getNote(database, user.id, payload.sourceNoteId);
    if (!sourceNote) return jsonError(404, "SOURCE_NOTE_NOT_FOUND", "来源笔记不存在");
    if (sourceNote.deleted_at !== null)
      return jsonError(409, "NOTE_IN_TRASH", "回收站中的笔记只读，请先恢复笔记后再修改");
    if (sourceNote.version !== payload.sourceVersion)
      return jsonError(409, "MENTION_STALE", "来源笔记已更新，请重新选择提及");

    const matchStart = payload.matchStart as number;
    const matchEnd = payload.matchEnd as number;
    if (matchStart < 0 || matchEnd > sourceNote.content_markdown.length || matchStart >= matchEnd) {
      return jsonError(400, "INVALID_MENTION_RANGE", "提及范围无效");
    }
    const currentMatch = sourceNote.content_markdown.slice(matchStart, matchEnd);
    const isCurrentMention =
      currentMatch === payload.matchText &&
      normalizeLinkTitle(currentMatch) === normalizeLinkTitle(targetNote.title) &&
      findUnlinkedMentionsInMarkdown(sourceNote.content_markdown, targetNote.title).some(
        (mention) => mention.start === matchStart && mention.end === matchEnd,
      );
    if (!isCurrentMention) return jsonError(409, "MENTION_STALE", "提及位置已变化，请重新选择");

    const newContent = linkMentionInMarkdown(
      sourceNote.content_markdown,
      matchStart,
      matchEnd,
      targetNote.title,
    );
    if (!validNoteContent(newContent))
      return jsonError(413, "NOTE_TOO_LARGE", "笔记标题或正文超出长度限制");
    if (
      !(await updateNote(
        database,
        sourceNote,
        user.id,
        sourceNote.title,
        newContent,
        sourceNote.notebook_id,
        sourceNote.is_favorite,
        sourceNote.deleted_at,
      ))
    ) {
      return jsonError(409, "VERSION_CONFLICT", "来源笔记已被更新，请重试");
    }
    publishWorkspaceChange(options, user.id, { resource: "notes", noteId: sourceNote.id }, request);

    return json({ ok: true });
  }

  // Get single note
  if (id && !subresource && method === "GET") {
    const note = await getNote(database, user.id, id);
    if (!note) return jsonError(404, "NOTE_NOT_FOUND", "笔记不存在");
    // A summary is enough to patch one list row after a realtime change.
    return json({
      note: url.searchParams.get("response") === "summary" ? summarizeNote(note) : toFullNote(note),
    });
  }

  // Patch note
  if (id && !subresource && method === "PATCH") {
    const current = await getNote(database, user.id, id);
    if (!current) return jsonError(404, "NOTE_NOT_FOUND", "笔记不存在");
    const payload = await readJson<{
      version?: unknown;
      title?: unknown;
      contentMarkdown?: unknown;
      notebookId?: unknown;
      isFavorite?: unknown;
      deleted?: unknown;
    }>(request, NOTE_BODY_MAX_BYTES);
    if (!payload || !Number.isInteger(payload.version))
      return jsonError(400, "VERSION_REQUIRED", "保存笔记必须携带版本号");
    if (payload.version !== current.version)
      return json(
        {
          error: {
            code: "VERSION_CONFLICT",
            message: "这篇笔记已在别处更新",
            current: toFullNote(current),
          },
        },
        409,
      );
    if (current.deleted_at !== null) {
      const hasOtherChanges =
        payload.title !== undefined ||
        payload.contentMarkdown !== undefined ||
        payload.notebookId !== undefined ||
        payload.isFavorite !== undefined;
      const isRestoreOnly = payload.deleted === false && !hasOtherChanges;
      const isRepeatedDeleteOnly = payload.deleted === true && !hasOtherChanges;
      if (!isRestoreOnly && !isRepeatedDeleteOnly) {
        return jsonError(409, "NOTE_IN_TRASH", "回收站中的笔记只读，请先恢复笔记后再修改");
      }
    }
    const rawTitle = payload.title === undefined ? current.title : payload.title;
    const contentMarkdown =
      payload.contentMarkdown === undefined ? current.content_markdown : payload.contentMarkdown;
    const notebookId = payload.notebookId === undefined ? current.notebook_id : payload.notebookId;
    if (payload.isFavorite !== undefined && typeof payload.isFavorite !== "boolean")
      return jsonError(400, "INVALID_NOTE", "收藏状态无效");
    if (payload.deleted !== undefined && typeof payload.deleted !== "boolean")
      return jsonError(400, "INVALID_NOTE", "回收站状态无效");
    const isFavorite =
      payload.isFavorite === undefined ? current.is_favorite : payload.isFavorite ? 1 : 0;
    const isDeleted = current.deleted_at !== null;
    const deletedAt =
      payload.deleted === undefined || payload.deleted === isDeleted
        ? current.deleted_at
        : payload.deleted
          ? now()
          : null;
    if (
      typeof rawTitle !== "string" ||
      typeof contentMarkdown !== "string" ||
      typeof notebookId !== "string"
    )
      return jsonError(400, "INVALID_NOTE", "笔记标题、正文或笔记本格式无效");
    if (!validText(rawTitle, 200) || !validNoteContent(contentMarkdown))
      return jsonError(
        413,
        "NOTE_TOO_LARGE",
        `笔记正文最多 ${NOTE_CONTENT_MAX_LENGTH.toLocaleString("en-US")} 个 UTF-16 code units 且不超过 ${NOTE_CONTENT_MAX_BYTES.toLocaleString("en-US")} 个 UTF-8 字节`,
      );
    const title = normalizeNoteTitle(rawTitle as string);
    if (
      !(await first(
        database,
        "SELECT id FROM notebooks WHERE id = ? AND user_id = ?",
        notebookId,
        user.id,
      ))
    )
      return jsonError(404, "NOTEBOOK_NOT_FOUND", "笔记本不存在");
    const contentChanged = current.content_markdown !== contentMarkdown;
    if (
      contentChanged &&
      !(await validNoteAssetReferences(database, user.id, current.id, contentMarkdown as string))
    )
      return jsonError(400, "INVALID_ASSET", "图片引用无效、不受支持或附件当前不可用");
    const summaryResponse = url.searchParams.get("response") === "summary";
    const hasChanges =
      current.title !== title ||
      contentChanged ||
      current.notebook_id !== notebookId ||
      current.is_favorite !== isFavorite ||
      current.deleted_at !== deletedAt;
    if (!hasChanges)
      return json({ note: summaryResponse ? summarizeNote(current) : toFullNote(current) });
    let updated: boolean;
    try {
      updated = await updateNote(
        database,
        current,
        user.id,
        title,
        contentMarkdown as string,
        notebookId,
        isFavorite,
        deletedAt,
      );
    } catch (error) {
      if (error instanceof InvalidNoteAssetsError)
        return jsonError(400, "INVALID_ASSET", "图片引用无效、不受支持或附件当前不可用");
      if (error instanceof NoteRenameContentTooLargeError)
        return jsonError(
          413,
          "NOTE_TOO_LARGE",
          "重命名会使引用这篇笔记的正文超出长度限制，请缩短标题或减少双向链接后重试",
        );
      throw error;
    }
    if (!updated) {
      const latest = await getNote(database, user.id, current.id);
      return json(
        {
          error: {
            code: "VERSION_CONFLICT",
            message: "这篇笔记已在别处更新",
            current: latest ? toFullNote(latest) : null,
          },
        },
        409,
      );
    }
    const note = await getNote(database, user.id, current.id);
    publishWorkspaceChange(
      options,
      user.id,
      { resource: "notes", ...(current.title === title ? { noteId: current.id } : {}) },
      request,
    );
    return json({ note: note ? (summaryResponse ? summarizeNote(note) : toFullNote(note)) : null });
  }

  // Delete note permanently
  if (id && !subresource && method === "DELETE") {
    const payload = await readJson<{ version?: unknown }>(request, 1024);
    if (!payload || !Number.isSafeInteger(payload.version) || (payload.version as number) < 1) {
      return jsonError(400, "VERSION_REQUIRED", "永久删除笔记必须携带版本号");
    }
    const note = await getNote(database, user.id, id);
    let result:
      | { kind: "missing" }
      | { kind: "conflict"; note: NoteRow | null }
      | { kind: "not-trashed" }
      | { kind: "deleted"; noteId: string; assetPaths: string[] };
    if (!note) result = { kind: "missing" };
    else if (note.version !== payload.version) result = { kind: "conflict", note };
    else if (note.deleted_at === null) result = { kind: "not-trashed" };
    else {
      const assetPaths = await assetPathsForNotes(database, user.id, [note.id]);
      await syncNoteTasks(database, user.id, note.id, note.notebook_id, note.created_at, "");
      const deleted = (await database
        .query(
          "DELETE FROM notes WHERE id = ? AND user_id = ? AND version = ? AND deleted_at IS NOT NULL RETURNING id",
        )
        .get(note.id, user.id, payload.version as number)) as { id: string } | null | undefined;
      result = deleted
        ? { kind: "deleted", noteId: note.id, assetPaths }
        : { kind: "conflict", note: (await getNote(database, user.id, id)) ?? null };
    }
    if (result.kind === "missing") return jsonError(404, "NOTE_NOT_FOUND", "笔记不存在");
    if (result.kind === "not-trashed")
      return jsonError(400, "NOTE_NOT_TRASHED", "只能永久删除回收站中的笔记");
    if (result.kind === "conflict") {
      return json(
        {
          error: {
            code: "VERSION_CONFLICT",
            message: "这篇笔记已在别处更新，请刷新后重试",
            current: result.note ? toFullNote(result.note) : null,
          },
        },
        409,
      );
    }
    publishWorkspaceChange(options, user.id, { resource: "notes", noteId: result.noteId }, request);
    if (options.assets) await removeAssetFiles(options.assets, result.assetPaths);
    return json({ ok: true });
  }

  return null;
}
