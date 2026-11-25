import { NOTE_BATCH_LIMIT } from "../../shared/types";
import { normalizeTag, parseTagQuery } from "../../shared/tags";
import { SQLiteError } from "bun:sqlite";
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
} from "../../shared/wiki-links";
import {
  all,
  BACKLINK_CANDIDATE_LIMIT,
  BACKLINK_MENTION_LIMIT,
  BACKLINK_REFERENCE_LIMIT,
  BACKLINK_SCAN_CHAR_LIMIT,
  escapeLikePattern,
  first,
  getNote,
  InvalidNoteAssetsError,
  json,
  jsonError,
  NOTE_BODY_MAX_BYTES,
  NOTE_CONTENT_MAX_LENGTH,
  NOTE_FROM,
  NOTE_LIST_SELECT,
  NOTE_PAGE_SIZE,
  NOTE_VIEWS,
  type NoteRow,
  normalizeNoteTitle,
  now,
  parseSearchTerms,
  readJson,
  readJsonResult,
  type RouteContext,
  type SqliteDatabase,
  type SqlValue,
  toFullNote,
  toNote,
  type UserRow,
  validNoteAssetReferences,
  validText,
} from "../core";
import { findActiveNoteIdByTitle, resolveNoteLinksForTitles } from "../note-links";
import {
  createNote,
  NoteRenameContentTooLargeError,
  NoteRenameLinkConflictError,
  syncNoteTasks,
  updateNote,
  updateNoteInTransaction,
} from "./note-mutations";
export {
  createNote,
  updateNote,
  updateNoteInTransaction,
  NOTE_RENAME_SOURCE_BATCH_SIZE,
} from "./note-mutations";
import {
  assetPathsForNotes,
  assetPathsForTrash,
  detachMemoReferencedAssets,
  removeAssetFiles,
} from "./assets";
import { buildFtsMatchQuery, searchTermNeedsCaseFolding } from "../search-text";
import { shortSearchToken } from "../note-search";
import { publishWorkspaceChange } from "../realtime";
import { handleTasksRoute } from "./tasks";
import { insertKanbanCard, isValidKanbanStatus } from "./kanban";

import {
  buildOptimizedNoteListPlan,
  decodeNoteListCursor,
  noteListOrder,
  respondNoteList,
  type SearchSort,
} from "./note-list";

const NOTE_BATCH_BODY_MAX_BYTES = 2 * 1024 * 1024;
const NOTE_SORTS: NoteSort[] = ["updated", "created"];
const NOTE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

class StaleMentionTargetError extends Error {}

function isPrimaryKeyConflict(error: unknown) {
  return error instanceof SQLiteError && error.code === "SQLITE_CONSTRAINT_PRIMARYKEY";
}

function searchContainsPredicate(
  column: "n.title" | "n.content_markdown" | "COALESCE(n.search_text, n.content_markdown)",
  term: string,
) {
  return searchTermNeedsCaseFolding(term)
    ? `search_contains(${column}, ?)`
    : `instr(${column}, ?) > 0`;
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

function getBatchNoteStates(database: SqliteDatabase, userId: string, entries: BatchNoteEntry[]) {
  return all<BatchNoteState>(
    database,
    `SELECT id, title, deleted_at, version, notebook_id, created_at
     FROM notes WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))`,
    userId,
    JSON.stringify(entries.map((entry) => entry.id)),
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
  assetRoot: string,
  summarizeNote: (note: NoteRow) => NoteSummary = toNote,
): Promise<Response | null> {
  const { request, url, method, segments, options } = ctx;
  const { database } = options;
  const resource = segments[0] ?? "";
  const id = segments[1] ?? "";
  const subresource = segments[2] ?? "";

  if (resource === "tasks") return handleTasksRoute(ctx, user);

  if (resource === "wiki-notes" && id === "suggestions" && method === "GET") {
    const query = normalizeLinkTitle(url.searchParams.get("query")?.slice(0, 80) ?? "");
    if (!query) return json({ matches: [], exactMatch: false });

    const exactMatch = Boolean(
      first(
        database,
        "SELECT id FROM notes WHERE user_id = ? AND deleted_at IS NULL AND title_normalized = ? LIMIT 1",
        user.id,
        query,
      ),
    );
    const matches = all<{ title: string; notebook_name: string }>(
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
    ).map((row) => ({ title: row.title, notebookName: row.notebook_name }));

    return json({ matches, exactMatch });
  }

  // Empty trash
  if (
    method === "DELETE" &&
    (url.pathname === "/api/trash" || (resource === "notes" && id === "trash"))
  ) {
    const emptyTrash = database.transaction(() => {
      const trashedNotes = all<{
        id: string;
        notebook_id: string;
        created_at: number;
      }>(
        database,
        "SELECT id, notebook_id, created_at FROM notes WHERE user_id = ? AND deleted_at IS NOT NULL",
        user.id,
      );
      detachMemoReferencedAssets(
        database,
        user.id,
        trashedNotes.map((note) => note.id),
      );
      const assetPaths = assetPathsForTrash(database, user.id);
      for (const note of trashedNotes)
        syncNoteTasks(database, user.id, note.id, note.notebook_id, note.created_at, "");
      const deletedCount = trashedNotes.length;
      database.query("DELETE FROM notes WHERE user_id = ? AND deleted_at IS NOT NULL").run(user.id);
      return { deletedCount, assetPaths };
    });
    const emptiedTrash = emptyTrash();
    if (emptiedTrash.deletedCount > 0)
      publishWorkspaceChange(options, user.id, { resource: "notebooks" }, request);
    await removeAssetFiles(assetRoot, emptiedTrash.assetPaths);
    return json({ ok: true, deletedCount: emptiedTrash.deletedCount });
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
      !first(
        database,
        "SELECT id FROM notebooks WHERE id = ? AND user_id = ?",
        payload.notebookId,
        user.id,
      )
    ) {
      return jsonError(404, "NOTEBOOK_NOT_FOUND", "笔记本不存在");
    }
    // The lookup and the insert must share one immediate transaction, otherwise two
    // concurrent requests could both miss and create duplicate notes with the same title.
    const ensureNote = database.transaction(() => {
      const existingId = findActiveNoteIdByTitle(database, user.id, title);
      if (existingId) {
        const existing = getNote(database, user.id, existingId);
        if (existing) return { note: toFullNote(existing), created: false as const };
      }
      const noteId = createNote(database, user.id, payload.notebookId as string, title, "");
      const note = getNote(database, user.id, noteId);
      return note ? { note: toFullNote(note), created: true as const, noteId } : null;
    });
    const ensured = ensureNote.immediate();
    if (!ensured) return jsonError(500, "NOTE_CREATE_FAILED", "笔记创建失败");
    // 新笔记会改变列表成员和笔记本计数。
    if (ensured.created)
      publishWorkspaceChange(options, user.id, { resource: "notebooks" }, request);
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
    if (Array.isArray(payload?.notes) && payload.notes.length > NOTE_BATCH_LIMIT)
      return jsonError(413, "TOO_MANY_BATCH_NOTES", `一次最多处理 ${NOTE_BATCH_LIMIT} 篇笔记`);
    const entries = parseBatchNoteEntries(payload);
    if (!entries) return jsonError(400, "INVALID_BATCH_NOTES", "批量操作的笔记参数无效");

    if (method === "PATCH") {
      if (payload?.deleted === false) {
        let restored: { restoredIds: string[] };
        try {
          restored = database
            .transaction(() => {
              const rows = getBatchNoteStates(database, user.id, entries);
              assertBatchNoteStates(rows, entries, "restore");
              const update = database.query(
                "UPDATE notes SET deleted_at = NULL, version = version + 1 WHERE id = ? AND user_id = ? AND version = ? AND deleted_at IS NOT NULL",
              );
              const readBody = database.query<{ content_markdown: string }, [string, string]>(
                "SELECT content_markdown FROM notes WHERE id = ? AND user_id = ?",
              );
              const rowsById = new Map(rows.map((row) => [row.id, row]));
              for (const entry of entries) {
                const note = rowsById.get(entry.id)!;
                syncNoteTasks(
                  database,
                  user.id,
                  note.id,
                  note.notebook_id,
                  note.created_at,
                  readBody.get(note.id, user.id)!.content_markdown,
                );
                if (!update.run(entry.id, user.id, entry.version).changes)
                  throw new BatchNoteConflictError([entry.id]);
              }
              resolveNoteLinksForTitles(
                database,
                user.id,
                rows.map((row) => row.title),
              );
              return { restoredIds: entries.map((entry) => entry.id) };
            })
            .immediate();
        } catch (error) {
          if (error instanceof BatchNoteConflictError) return batchConflictResponse(error);
          throw error;
        }
        publishWorkspaceChange(options, user.id, { resource: "notebooks" }, request);
        return json({ ok: true, restoredIds: restored.restoredIds });
      }

      let moved: { deletedIds: string[] };
      try {
        moved = database
          .transaction(() => {
            const rows = getBatchNoteStates(database, user.id, entries);
            assertBatchNoteStates(rows, entries, "trash");
            const deletedAt = now();
            const update = database.query(
              "UPDATE notes SET deleted_at = ?, version = version + 1 WHERE id = ? AND user_id = ? AND version = ? AND deleted_at IS NULL",
            );
            const rowsById = new Map(rows.map((row) => [row.id, row]));
            for (const entry of entries) {
              const note = rowsById.get(entry.id)!;
              syncNoteTasks(database, user.id, note.id, note.notebook_id, note.created_at, "");
              if (!update.run(deletedAt, entry.id, user.id, entry.version).changes)
                throw new BatchNoteConflictError([entry.id]);
            }
            resolveNoteLinksForTitles(
              database,
              user.id,
              rows.map((row) => row.title),
            );
            return { deletedIds: entries.map((entry) => entry.id) };
          })
          .immediate();
      } catch (error) {
        if (error instanceof BatchNoteConflictError) return batchConflictResponse(error);
        throw error;
      }
      publishWorkspaceChange(options, user.id, { resource: "notebooks" }, request);
      return json({ ok: true, deletedIds: moved.deletedIds });
    }

    let deleted: { deletedIds: string[]; assetPaths: string[] };
    try {
      deleted = database
        .transaction(() => {
          const rows = getBatchNoteStates(database, user.id, entries);
          assertBatchNoteStates(rows, entries, "permanent");
          const deletedIds = entries.map((entry) => entry.id);
          detachMemoReferencedAssets(database, user.id, deletedIds);
          const assetPaths = assetPathsForNotes(database, user.id, deletedIds);
          for (const note of rows)
            syncNoteTasks(database, user.id, note.id, note.notebook_id, note.created_at, "");
          const deleteLinks = database.query(
            "DELETE FROM note_links WHERE user_id = ? AND source_note_id = ?",
          );
          const deleteNote = database.query(
            "DELETE FROM notes WHERE id = ? AND user_id = ? AND version = ? AND deleted_at IS NOT NULL",
          );
          for (const entry of entries) {
            if (!deleteNote.run(entry.id, user.id, entry.version).changes)
              throw new BatchNoteConflictError([entry.id]);
            deleteLinks.run(user.id, entry.id);
          }
          return { deletedIds, assetPaths };
        })
        .immediate();
    } catch (error) {
      if (error instanceof BatchNoteConflictError) return batchConflictResponse(error);
      throw error;
    }
    publishWorkspaceChange(options, user.id, { resource: "notebooks" }, request);
    await removeAssetFiles(assetRoot, deleted.assetPaths);
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
    const parsedSearch = query && !tagQuery ? parseSearchTerms(query) : null;
    const searchTokens = parsedSearch?.tokens ?? [];
    const filterNotebookIds: string[] = [];

    if (view === "trash") conditions.push("n.deleted_at IS NOT NULL");
    else conditions.push("n.deleted_at IS NULL");
    if (view === "inbox") {
      const inbox = first<{ id: string }>(
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
      if (parsedSearch.tokens.length === 0) return json({ notes: [], total: 0 });
    }
    const scope =
      sort === "relevance"
        ? new Bun.CryptoHasher("sha256")
            .update(
              JSON.stringify([user.id, query, notebookId, view, normalizedTagFilters, tagMode]),
            )
            .digest("hex")
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
    const optimizedPlan = parsedSearch
      ? buildOptimizedNoteListPlan({
          userId: user.id,
          view: view as NoteView,
          sort,
          notebookIds: filterNotebookIds,
          searchTokens,
          ftsTokens: parsedSearch.ftsTokens,
          shortTokens: parsedSearch.directTokens,
          normalizedTagFilters,
          tagMode,
          pageLimit,
          cursor: cursor ? { value: cursor.value, id: cursor.id } : null,
          includeTotal,
          includeMatch,
        })
      : null;
    if (optimizedPlan) {
      const resultRows = database
        .query(optimizedPlan.sql)
        .all(...optimizedPlan.params) as (NoteRow & {
        tags_json: string;
        relevance_score: number;
        match_snippet?: string;
        search_total?: number;
      })[];
      const rows = resultRows.filter((row) => row.id !== null);
      return respondNoteList(
        rows,
        pageLimit,
        sort,
        scope,
        searchTokens,
        normalizedTagFilters,
        includeMatch,
        includeTotal,
        includeTotal ? Number(resultRows[0]?.search_total ?? 0) : null,
      );
    }
    const totalWhere = conditions.join(" AND ") || "1";
    const totalParams = [...params];
    if (cursor) {
      if (sort === "relevance") {
        if (typeof cursor.value !== "number" || !Number.isFinite(cursor.value))
          return jsonError(400, "INVALID_CURSOR", "笔记列表游标无效");
        conditions.push("(0 > ? OR (0 = ? AND n.id > ?))");
        params.push(cursor.value, cursor.value, cursor.id);
      } else {
        if (typeof cursor.value !== "number" || !Number.isSafeInteger(cursor.value))
          return jsonError(400, "INVALID_CURSOR", "笔记列表游标无效");
        const column = sort === "created" ? "n.created_at" : "n.updated_at";
        conditions.push(`(${column}, n.id) < (?, ?)`);
        params.push(cursor.value, cursor.id);
      }
    }
    const where = conditions.join(" AND ") || "1";
    const totalRow = includeTotal
      ? first<{ count: number }>(
          database,
          `SELECT COUNT(*) AS count FROM ${from} WHERE ${totalWhere}`,
          ...totalParams,
        )
      : null;
    const matchParams: SqlValue[] = [];
    let matchSelect = "";
    if (includeMatch && searchTokens.length) {
      matchSelect =
        ", search_snippet(COALESCE(n.search_text, n.content_markdown), ?) AS match_snippet";
      matchParams.push(JSON.stringify(searchTokens));
    }
    const listStatement = database.query(`
      SELECT ${NOTE_LIST_SELECT}, 0 AS relevance_score ${matchSelect}
      FROM ${from} WHERE ${where} ORDER BY ${sort === "relevance" ? "n.id ASC" : noteListOrder(sort)} LIMIT ?
    `);
    const rows = listStatement.all(...matchParams, ...params, pageLimit + 1) as (NoteRow & {
      tags_json: string;
      relevance_score: number;
      match_snippet?: string;
    })[];
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
    );
  }

  // Create note
  if (!id && method === "POST") {
    const payload = await readJson<{
      id?: unknown;
      title?: unknown;
      contentMarkdown?: unknown;
      notebookId?: unknown;
      kanbanStatus?: unknown;
    }>(request, NOTE_BODY_MAX_BYTES);
    if (!payload) return jsonError(400, "INVALID_JSON", "请求体无效或超出大小限制");
    const rawTitle = payload?.title === undefined ? "未命名笔记" : payload.title;
    const contentMarkdown = payload?.contentMarkdown === undefined ? "" : payload.contentMarkdown;
    if (typeof rawTitle !== "string" || typeof contentMarkdown !== "string")
      return jsonError(400, "INVALID_NOTE", "笔记标题或正文格式无效");
    if (!validText(rawTitle, 200) || !validText(contentMarkdown, 1_000_000))
      return jsonError(413, "NOTE_TOO_LARGE", "笔记标题或正文超出长度限制");
    const title = normalizeNoteTitle(rawTitle as string);
    const kanbanStatus = payload.kanbanStatus;
    if (kanbanStatus !== undefined && !isValidKanbanStatus(kanbanStatus))
      return jsonError(400, "INVALID_ARGUMENT", "看板状态无效");
    const notebookId =
      typeof payload?.notebookId === "string"
        ? payload.notebookId
        : first<{ id: string }>(
            database,
            "SELECT id FROM notebooks WHERE user_id = ? AND is_system = 1 LIMIT 1",
            user.id,
          )?.id;
    if (!notebookId) return jsonError(400, "NO_NOTEBOOK", "没有可用的收件箱");
    if (
      !first(database, "SELECT id FROM notebooks WHERE id = ? AND user_id = ?", notebookId, user.id)
    )
      return jsonError(404, "NOTEBOOK_NOT_FOUND", "笔记本不存在");
    if (!validNoteAssetReferences(database, user.id, null, contentMarkdown as string))
      return jsonError(400, "INVALID_ASSET", "图片引用无效、不受支持或附件当前不可用");
    const requestedId = payload?.id === undefined ? undefined : payload.id;
    if (requestedId !== undefined) {
      if (typeof requestedId !== "string" || !NOTE_ID_PATTERN.test(requestedId)) {
        return jsonError(400, "INVALID_NOTE", "笔记 ID 必须是 UUID");
      }
      if (first(database, "SELECT 1 FROM notes WHERE id = ?", requestedId)) {
        return jsonError(409, "NOTE_EXISTS", "指定 ID 的笔记已存在");
      }
    }
    let noteId: string;
    let card: ReturnType<typeof insertKanbanCard> | undefined;
    try {
      ({ noteId, card } = database
        .transaction(() => {
          const noteId = createNote(
            database,
            user.id,
            notebookId,
            title,
            contentMarkdown as string,
            requestedId,
          );
          const card =
            kanbanStatus === undefined
              ? undefined
              : insertKanbanCard(database, user.id, noteId, kanbanStatus);
          if (card === null) throw new Error("New note already has a Kanban card");
          return { noteId, card };
        })
        .immediate());
    } catch (error) {
      if (requestedId && isPrimaryKeyConflict(error))
        return jsonError(409, "NOTE_EXISTS", "指定 ID 的笔记已存在");
      throw error;
    }
    const note = getNote(database, user.id, noteId);
    // 新笔记会改变列表成员和笔记本计数。
    publishWorkspaceChange(options, user.id, { resource: "notebooks" }, request);
    const summaryResponse = url.searchParams.get("response") === "summary";
    return json(
      { note: note ? (summaryResponse ? summarizeNote(note) : toFullNote(note)) : null, card },
      201,
    );
  }

  // Backlinks
  if (id && subresource === "backlinks" && method === "GET") {
    const note = getNote(database, user.id, id);
    if (!note) return jsonError(404, "NOTE_NOT_FOUND", "笔记不存在");
    let linkedOffset = 0;
    let candidateOffset = 0;
    let mentionOffset = 0;
    const cursorValue = url.searchParams.get("cursor");
    if (cursorValue) {
      try {
        const cursor = JSON.parse(Buffer.from(cursorValue, "base64url").toString("utf8"));
        if (
          cursor.id !== id ||
          cursor.title !== note.title ||
          ![cursor.linked, cursor.candidate, cursor.mention].every(Number.isSafeInteger) ||
          cursor.linked < -1 ||
          cursor.candidate < -1 ||
          cursor.mention < 0 ||
          cursorValue.length > 2048
        )
          throw new Error("invalid cursor");
        linkedOffset = cursor.linked;
        candidateOffset = cursor.candidate;
        mentionOffset = cursor.mention;
      } catch {
        return jsonError(400, "INVALID_CURSOR", "反向链接分页游标无效");
      }
    }

    // 只物化最多 101 条元数据，正文仍按扫描预算逐篇读取。Bun 的缓存语句
    // 在 iterate() 提前 break 后可能无法再次执行，不能把截断游标留给后续请求。
    const linkedRows = database
      .query(
        `
      SELECT nl.id AS link_id, nl.source_note_id, n.title AS source_title,
        nl.snippet AS link_snippet,
        length(n.content_markdown) AS source_content_char_count,
        n.updated_at AS source_updated_at, nb.name AS notebook_name, nl.target_title, nl.target_note_id
      FROM note_links nl
      JOIN notes n ON nl.source_note_id = n.id AND n.user_id = nl.user_id
      JOIN notebooks nb ON n.notebook_id = nb.id AND nb.user_id = n.user_id
      WHERE nl.user_id = ? AND nl.target_note_id = ? AND nl.source_note_id != ? AND n.deleted_at IS NULL
      ORDER BY n.updated_at DESC, nl.id DESC
      LIMIT ? OFFSET ?
    `,
      )
      .all(
        user.id,
        note.id,
        note.id,
        linkedOffset < 0 ? 0 : BACKLINK_REFERENCE_LIMIT + 1,
        Math.max(0, linkedOffset),
      ) as Array<{
      link_id: string;
      source_note_id: string;
      source_title: string;
      link_snippet: string | null;
      source_content_char_count: number;
      source_updated_at: number;
      notebook_name: string;
      target_title: string;
      target_note_id: string | null;
    }>;
    let linkedContentStatement: ReturnType<SqliteDatabase["query"]> | null = null;
    const linkedReferences: NoteLinkSummary[] = [];
    let truncated = false;
    let scanBudgetExhausted = false;
    let scannedChars = 0;
    let linkedProcessed = 0;
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
        const source = linkedContentStatement.get(row.source_note_id, user.id) as {
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
      linkedProcessed++;
    }
    if (linkedOffset >= 0)
      linkedOffset = linkedProcessed < linkedRows.length ? linkedOffset + linkedProcessed : -1;

    const unlinkedMentions: UnlinkedMention[] = [];
    const trimmedTitle = note.title.trim();
    if (candidateOffset >= 0 && trimmedTitle.length >= 2 && !scanBudgetExhausted) {
      const { ftsTokens } = parseSearchTerms(trimmedTitle);
      const useFts = trimmedTitle.length >= 3 && ftsTokens.length > 0;
      const useShortIndex = !useFts && Array.from(trimmedTitle).length <= 2;
      let candidateFrom =
        "notes n JOIN notebooks nb ON n.notebook_id = nb.id AND nb.user_id = n.user_id";
      const candidateConditions = ["n.user_id = ?", "n.deleted_at IS NULL", "n.id != ?"];
      const candidateParams: SqlValue[] = [user.id, note.id];

      if (useFts) {
        candidateFrom += " JOIN notes_fts ON notes_fts.rowid = n.rowid";
        candidateConditions.push("notes_fts MATCH ?");
        candidateParams.push(buildFtsMatchQuery(ftsTokens));
      } else if (useShortIndex) {
        candidateFrom = `(
          SELECT rowid FROM notes_short_fts WHERE notes_short_fts MATCH ?
          UNION
          SELECT overflow_note.rowid FROM notes_short_overflow overflow
          JOIN notes overflow_note ON overflow_note.id = overflow.note_id
          WHERE overflow.user_id = ? AND search_contains(COALESCE(overflow_note.search_text, overflow_note.content_markdown), ?)
        ) short_match
        JOIN notes n ON n.rowid = short_match.rowid
        JOIN notebooks nb ON n.notebook_id = nb.id AND nb.user_id = n.user_id`;
        candidateConditions.push(
          searchContainsPredicate("COALESCE(n.search_text, n.content_markdown)", trimmedTitle),
        );
        candidateParams.unshift(shortSearchToken(trimmedTitle), user.id, trimmedTitle);
        candidateParams.push(trimmedTitle);
      } else {
        candidateConditions.push(
          searchContainsPredicate("COALESCE(n.search_text, n.content_markdown)", trimmedTitle),
        );
        candidateParams.push(trimmedTitle);
      }

      const candidateSql = `
        SELECT n.id, n.title, length(n.content_markdown) AS content_char_count,
          nb.name AS notebook_name, n.version, n.updated_at
        FROM ${candidateFrom}
        WHERE ${candidateConditions.join(" AND ")}
        ORDER BY n.updated_at DESC, n.id DESC
        LIMIT ? OFFSET ?
      `;
      candidateParams.push(BACKLINK_CANDIDATE_LIMIT + 1, candidateOffset);
      const candidateRows = database.query(candidateSql).all(...candidateParams) as Array<{
        id: string;
        title: string;
        content_char_count: number;
        notebook_name: string;
        version: number;
        updated_at: number;
      }>;
      const candidateContentStatement = database.query(
        "SELECT content_markdown FROM notes WHERE id = ? AND user_id = ?",
      );
      let candidateCount = 0;
      let candidateHasMore = false;
      let stoppedWithinCandidate = false;
      mentionLoop: for (const candidate of candidateRows) {
        candidateCount += 1;
        if (candidateCount > BACKLINK_CANDIDATE_LIMIT) {
          truncated = true;
          candidateHasMore = true;
          break;
        }
        if (candidate.content_char_count > BACKLINK_SCAN_CHAR_LIMIT - scannedChars) {
          truncated = true;
          candidateCount--;
          candidateHasMore = true;
          break;
        }
        const source = candidateContentStatement.get(candidate.id, user.id) as {
          content_markdown: string;
        } | null;
        if (!source) continue;
        scannedChars += source.content_markdown.length;
        if (scannedChars > BACKLINK_SCAN_CHAR_LIMIT) {
          truncated = true;
          candidateCount--;
          candidateHasMore = true;
          break;
        }
        const mentions = findUnlinkedMentionsInMarkdown(source.content_markdown, note.title);
        for (
          let mentionIndex = candidateCount === 1 ? mentionOffset : 0;
          mentionIndex < mentions.length;
          mentionIndex++
        ) {
          const m = mentions[mentionIndex]!;
          if (unlinkedMentions.length >= BACKLINK_MENTION_LIMIT) {
            truncated = true;
            candidateOffset += candidateCount - 1;
            mentionOffset = mentionIndex;
            candidateHasMore = true;
            stoppedWithinCandidate = true;
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
        mentionOffset = 0;
      }
      if (candidateHasMore && !stoppedWithinCandidate)
        candidateOffset += Math.min(candidateCount, BACKLINK_CANDIDATE_LIMIT);
      else if (!candidateHasMore) candidateOffset = -1;
    } else if (trimmedTitle.length < 2) {
      candidateOffset = -1;
    }

    const nextCursor =
      linkedOffset >= 0 || candidateOffset >= 0
        ? Buffer.from(
            JSON.stringify({
              id,
              title: note.title,
              linked: linkedOffset,
              candidate: candidateOffset,
              mention: mentionOffset,
            }),
          ).toString("base64url")
        : null;
    const payload: NoteBacklinksResponse = {
      linkedReferences,
      unlinkedMentions,
      truncated: truncated || Boolean(nextCursor),
      nextCursor,
    };
    return json(payload);
  }

  // Link mention
  if (id && subresource === "link-mention" && method === "POST") {
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

    const sourceNoteId = payload.sourceNoteId;
    const matchText = payload.matchText;
    const matchStart = payload.matchStart as number;
    const matchEnd = payload.matchEnd as number;

    let failure: Response | null;
    try {
      failure = database
        .transaction(() => {
          const targetNote = getNote(database, user.id, id);
          if (!targetNote) return jsonError(404, "NOTE_NOT_FOUND", "目标笔记不存在");
          const sourceNote = getNote(database, user.id, sourceNoteId);
          if (!sourceNote) return jsonError(404, "SOURCE_NOTE_NOT_FOUND", "来源笔记不存在");
          if (targetNote.deleted_at !== null || sourceNote.deleted_at !== null)
            return jsonError(409, "NOTE_IN_TRASH", "回收站中的笔记只读，请先恢复笔记后再修改");
          if (sourceNote.version !== payload.sourceVersion)
            return jsonError(409, "MENTION_STALE", "来源笔记已更新，请重新选择提及");

          const content = sourceNote.content_markdown;
          if (matchStart < 0 || matchEnd > content.length || matchStart >= matchEnd)
            return jsonError(400, "INVALID_MENTION_RANGE", "提及范围无效");
          const currentMatch = content.slice(matchStart, matchEnd);
          if (
            currentMatch !== matchText ||
            normalizeLinkTitle(currentMatch) !== normalizeLinkTitle(targetNote.title) ||
            !findUnlinkedMentionsInMarkdown(content, targetNote.title).some(
              (mention) => mention.start === matchStart && mention.end === matchEnd,
            )
          )
            return jsonError(409, "MENTION_STALE", "提及或目标标题已变化，请重新选择");

          const resolvesToTarget = () =>
            findActiveNoteIdByTitle(database, user.id, targetNote.title) === targetNote.id;
          if (!resolvesToTarget()) throw new StaleMentionTargetError();
          const newContent = linkMentionInMarkdown(content, matchStart, matchEnd, targetNote.title);
          if (!validText(newContent, NOTE_CONTENT_MAX_LENGTH))
            return jsonError(413, "NOTE_TOO_LARGE", "笔记标题或正文超出长度限制");
          if (
            !updateNoteInTransaction(
              database,
              sourceNote,
              user.id,
              sourceNote.title,
              newContent,
              sourceNote.notebook_id,
              sourceNote.is_favorite,
              sourceNote.deleted_at,
            )
          )
            return jsonError(409, "VERSION_CONFLICT", "来源笔记已被更新，请重试");
          // Saving the source can change which note wins a duplicate-title lookup.
          if (!resolvesToTarget()) throw new StaleMentionTargetError();
          return null;
        })
        .immediate();
    } catch (error) {
      if (!(error instanceof StaleMentionTargetError)) throw error;
      return jsonError(409, "MENTION_STALE", "同名笔记已使链接目标变化，请重新选择");
    }
    if (failure) return failure;
    publishWorkspaceChange(options, user.id, { resource: "notes", noteId: sourceNoteId }, request);

    return json({ ok: true });
  }

  // Get single note
  if (id && !subresource && method === "GET") {
    const note = getNote(database, user.id, id);
    if (!note) return jsonError(404, "NOTE_NOT_FOUND", "笔记不存在");
    // A summary is enough to patch one list row after a realtime change.
    return json({
      note: url.searchParams.get("response") === "summary" ? summarizeNote(note) : toFullNote(note),
    });
  }

  // Patch note
  if (id && !subresource && method === "PATCH") {
    const bodyResult = await readJsonResult<{
      version?: unknown;
      title?: unknown;
      contentMarkdown?: unknown;
      notebookId?: unknown;
      isFavorite?: unknown;
      deleted?: unknown;
    }>(request, NOTE_BODY_MAX_BYTES);
    if (!bodyResult.ok && bodyResult.reason === "too-large")
      return jsonError(413, "NOTE_TOO_LARGE", "笔记正文超过大小限制");
    const payload = bodyResult.ok ? bodyResult.value : null;
    const current = getNote(database, user.id, id);
    if (!current) return jsonError(404, "NOTE_NOT_FOUND", "笔记不存在");
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
    if (!validText(rawTitle, 200) || !validText(contentMarkdown, 1_000_000))
      return jsonError(413, "NOTE_TOO_LARGE", "笔记标题或正文超出长度限制");
    const title = normalizeNoteTitle(rawTitle as string);
    if (
      !first(database, "SELECT id FROM notebooks WHERE id = ? AND user_id = ?", notebookId, user.id)
    )
      return jsonError(404, "NOTEBOOK_NOT_FOUND", "笔记本不存在");
    const contentChanged = current.content_markdown !== contentMarkdown;
    if (
      contentChanged &&
      !validNoteAssetReferences(database, user.id, current.id, contentMarkdown as string)
    )
      return jsonError(400, "INVALID_ASSET", "图片引用无效、不受支持或附件当前不可用");
    const summaryResponse = url.searchParams.get("response") === "summary";
    const notebookCountsChanged =
      current.notebook_id !== notebookId || current.deleted_at !== deletedAt;
    const refreshList =
      notebookCountsChanged || current.is_favorite !== isFavorite || current.title !== title;
    if (!refreshList && !contentChanged)
      return json({ note: summaryResponse ? summarizeNote(current) : toFullNote(current) });
    let updated: ReturnType<typeof updateNote>;
    try {
      updated = updateNote(
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
      if (error instanceof NoteRenameLinkConflictError)
        return jsonError(
          409,
          "NOTE_RENAME_LINK_CONFLICT",
          "已有同名笔记，请使用其他标题以保留双向链接",
        );
      throw error;
    }
    if (!updated) {
      const latest = getNote(database, user.id, current.id);
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
    const note = getNote(database, user.id, current.id);
    publishWorkspaceChange(
      options,
      user.id,
      {
        resource: notebookCountsChanged ? "notebooks" : "notes",
        ...(refreshList ? {} : { noteId: current.id }),
      },
      request,
    );
    const rewrittenBody = note && note.content_markdown !== contentMarkdown;
    return json({
      note: note
        ? summaryResponse && !rewrittenBody
          ? summarizeNote(note)
          : toFullNote(note)
        : null,
      ...(rewrittenBody ? { previousTitle: current.title } : {}),
      ...(updated.linkedNotesRewritten ? { linkedNotesRewritten: true } : {}),
    });
  }

  // Delete note permanently
  if (id && !subresource && method === "DELETE") {
    const payload = await readJson<{ version?: unknown }>(request, 1024);
    if (!payload || !Number.isSafeInteger(payload.version) || (payload.version as number) < 1) {
      return jsonError(400, "VERSION_REQUIRED", "永久删除笔记必须携带版本号");
    }
    const result = database
      .transaction(() => {
        const note = getNote(database, user.id, id);
        if (!note) return { kind: "missing" as const };
        if (note.version !== payload.version) return { kind: "conflict" as const, note };
        if (note.deleted_at === null) return { kind: "not-trashed" as const };

        detachMemoReferencedAssets(database, user.id, [note.id]);
        const assetPaths = assetPathsForNotes(database, user.id, [note.id]);
        syncNoteTasks(database, user.id, note.id, note.notebook_id, note.created_at, "");
        const deleted = database
          .query(
            "DELETE FROM notes WHERE id = ? AND user_id = ? AND version = ? AND deleted_at IS NOT NULL",
          )
          .run(note.id, user.id, payload.version as number);
        if (!deleted.changes) {
          return { kind: "conflict" as const, note: getNote(database, user.id, id) };
        }
        return { kind: "deleted" as const, noteId: note.id, assetPaths };
      })
      .immediate();
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
    publishWorkspaceChange(
      options,
      user.id,
      { resource: "notebooks", noteId: result.noteId },
      request,
    );
    await removeAssetFiles(assetRoot, result.assetPaths);
    return json({ ok: true });
  }

  return null;
}
