import { SQLiteError } from "bun:sqlite";
import { normalizeTag, parseTagQuery } from "../../shared/tags";
import type { NoteSort, NoteSummary, NoteView } from "../../shared/types";
import {
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
  type SqlValue,
  toFullNote,
  toNote,
  type UserRow,
  validNoteAssetReferences,
  validText,
} from "../core";
import { NOTE_SEARCH_REVISION_KEY } from "../db";
import { publishWorkspaceChange } from "../realtime";
import { assetPathsForNotes, detachMemoReferencedAssets, removeAssetFiles } from "./assets";
import { insertKanbanCard, isValidKanbanStatus } from "./kanban";
import { handleNoteBacklinksRoute } from "./note-backlinks";
import { handleNoteBatchRoute } from "./note-batch";
import {
  buildOptimizedNoteListPlan,
  hasMatchingLinkTitles,
  decodeNoteListCursor,
  noteListOrder,
  respondNoteList,
  type SearchSort,
} from "./note-list";
import { createNote, syncNoteTasks, updateNote } from "./note-mutations";
export { createNote, updateNote, updateNoteInTransaction } from "./note-mutations";
import { handleTasksRoute } from "./tasks";

const NOTE_SORTS: NoteSort[] = ["updated", "created"];
const NOTE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function isPrimaryKeyConflict(error: unknown) {
  return error instanceof SQLiteError && error.code === "SQLITE_CONSTRAINT_PRIMARYKEY";
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

  const backlinksResponse = await handleNoteBacklinksRoute(ctx, user);
  if (backlinksResponse) return backlinksResponse;

  const batchResponse = await handleNoteBatchRoute(ctx, user, assetRoot);
  if (batchResponse) return batchResponse;

  if (resource !== "notes") return null;

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
    const from = NOTE_FROM;
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
    // Read the cursor revision, title matches and ranked rows from one snapshot.
    const searchResult = parsedSearch
      ? database.transaction(() => {
          const revision =
            sort === "relevance"
              ? first<{ value: string }>(
                  database,
                  "SELECT value FROM app_metadata WHERE key = ?",
                  NOTE_SEARCH_REVISION_KEY,
                )!.value
              : undefined;
          if (cursor && sort === "relevance" && cursor.revision !== revision) {
            return jsonError(409, "SEARCH_CURSOR_STALE", "笔记搜索索引已变化，请从第一页重新搜索");
          }
          const plan = buildOptimizedNoteListPlan({
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
            includeLinkTitles: hasMatchingLinkTitles(
              database,
              user.id,
              parsedSearch.ftsTokens,
              parsedSearch.directTokens,
            ),
          });
          if (!plan) return null;
          const resultRows = database.query(plan.sql).all(...plan.params) as (NoteRow & {
            tags_json: string;
            relevance_score: number;
            match_snippet?: string;
            search_total?: number;
          })[];
          return { resultRows, revision };
        })()
      : null;
    if (searchResult instanceof Response) return searchResult;
    if (searchResult) {
      const { resultRows, revision } = searchResult;
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
        revision,
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
    if (!validText(rawTitle, 200) || !validText(contentMarkdown, NOTE_CONTENT_MAX_LENGTH))
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
    if (!validText(rawTitle, 200) || !validText(contentMarkdown, NOTE_CONTENT_MAX_LENGTH))
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
    return json({ note: note ? (summaryResponse ? summarizeNote(note) : toFullNote(note)) : null });
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
