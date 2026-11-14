import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  all,
  NOTE_CONTENT_MAX_LENGTH,
  NOTE_PREVIEW_LIMIT,
  NOTE_VIEWS,
  parseIndexedTags,
} from "./core";
import {
  noteTagsSchema,
  validMcpTags,
  invalidMcpTagsError,
  withPreviewLimit,
  withoutNotePreview,
  appendMarkdownTags,
  conciseWriteNote,
  routeError,
  noteWriteError,
  notesRoute,
  updateNoteRoute,
  noteByTitle,
  resolveNotebook,
  type McpToolContext,
} from "./mcp-helpers";

export function registerMcpNoteTools(
  server: McpServer,
  { options, user, responseValue }: McpToolContext,
) {
  server.registerTool(
    "search_notes",
    {
      title: "搜索笔记",
      description:
        "搜索标题或正文，按笔记本、多标签和视图筛选；返回有界摘要及命中线索，支持分页和排序。",
      inputSchema: z
        .object({
          query: z.string().max(80).optional().describe("搜索词；省略或留空时列出最近笔记"),
          tags: noteTagsSchema.max(20).optional(),
          tagMode: z.enum(["all", "any"]).optional(),
          sort: z.enum(["relevance", "updated_desc", "created_desc"]).optional(),
          notebookId: z.string().min(1).max(200).optional().describe("仅搜索指定笔记本"),
          notebookName: z.string().trim().min(1).max(40).optional(),
          view: z.enum(NOTE_VIEWS).optional().describe("笔记视图，默认 all；trash 搜索回收站"),
          cursor: z.string().max(2048).optional().describe("上一次搜索结果返回的 nextCursor"),
          limit: z
            .number()
            .int()
            .min(1)
            .max(100)
            .optional()
            .describe("每页数量，默认 20，最大 100"),
          previewLength: z
            .number()
            .int()
            .min(0)
            .max(NOTE_PREVIEW_LIMIT)
            .optional()
            .describe(`每篇笔记的摘要长度，默认 120，最大 ${NOTE_PREVIEW_LIMIT} 个 Unicode 字符`),
        })
        .strict(),
    },
    async ({
      query,
      tags,
      tagMode,
      sort,
      notebookId,
      notebookName,
      view,
      cursor,
      limit = 20,
      previewLength = 120,
    }) => {
      if (!user)
        return responseValue(
          { error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } },
          true,
        );
      const resolved = await resolveNotebook(options, user, { notebookId, notebookName });
      if (resolved.error) return responseValue({ error: resolved.error }, true);
      notebookId = resolved.notebook?.id;

      const url = new URL("/api/notes", "http://xiangying-notes.internal");
      if (tags && !validMcpTags(tags)) return invalidMcpTagsError(tags);
      for (const value of tags ?? []) url.searchParams.append("tags", value);
      if (tagMode) url.searchParams.set("tagMode", tagMode);
      url.searchParams.set(
        "sort",
        sort === "created_desc" ? "created" : sort === "updated_desc" ? "updated" : "relevance",
      );
      url.searchParams.set("includeMatch", "1");
      if (query) url.searchParams.set("query", query);
      if (notebookId) url.searchParams.set("notebookId", notebookId);
      if (view) url.searchParams.set("view", view);
      if (cursor) url.searchParams.set("cursor", cursor);
      // Counting every page doubles the query cost of a paginated search; hasMore
      // and nextCursor already describe whether more results exist.
      if (cursor) url.searchParams.set("includeTotal", "0");
      url.searchParams.set("limit", String(limit));
      const result = await notesRoute(
        options,
        user,
        "GET",
        ["notes"],
        `${url.pathname}${url.search}`,
      );
      if (result.status !== 200) return routeError(result);
      const notes = Array.isArray(result.body.notes)
        ? (result.body.notes as Record<string, unknown>[])
        : [];
      return responseValue({ ...result.body, notes: withPreviewLimit(notes, previewLength) });
    },
  );

  server.registerTool(
    "get_note",
    {
      title: "读取笔记",
      description:
        "按 ID 或精确标题读取；标题匹配忽略 ASCII 大小写并裁剪查询参数首尾空白，仅改变查询大小写或空白不能消歧。模糊查找用 search_notes，长笔记局部读取用 get_note_section；只取版本用 includeContent=false。歧义最多返回 5 个候选，matchCount 上限 6、可能为总数下限；truncated 表示候选未列全。",
      inputSchema: z
        .object({
          noteId: z.string().min(1).max(200).optional(),
          title: z.string().trim().min(1).max(200).optional(),
          notebookId: z.string().min(1).max(200).optional(),
          notebookName: z.string().trim().min(1).max(40).optional(),
          includeDeleted: z
            .boolean()
            .optional()
            .describe(
              "仅按 title 查找时是否包含回收站笔记，默认 false；按 noteId 读取回收站笔记不需要此参数",
            ),
          includeContent: z
            .boolean()
            .optional()
            .describe("是否回传完整正文，默认 true；只想拿 version 时传 false"),
        })
        .strict(),
    },
    async ({
      noteId,
      title,
      notebookId,
      notebookName,
      includeDeleted = false,
      includeContent = true,
    }) => {
      if (!user)
        return responseValue(
          { error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } },
          true,
        );
      if (Boolean(noteId) === Boolean(title)) {
        return responseValue(
          {
            error: {
              code: "INVALID_NOTE_SELECTOR",
              message: "请且仅提供 noteId 或 title 其中一个",
            },
          },
          true,
        );
      }
      if (title !== undefined) {
        const resolved = await resolveNotebook(options, user, { notebookId, notebookName });
        if (resolved.error) return responseValue({ error: resolved.error }, true);
        const match = await noteByTitle(
          options,
          user,
          title,
          includeDeleted,
          resolved.notebook?.id,
        );
        if ("error" in match) return responseValue(match, true);
        noteId = match.noteId;
      }
      const result = await notesRoute(
        options,
        user,
        "GET",
        ["notes", noteId as string],
        `/api/notes/${encodeURIComponent(noteId as string)}`,
      );
      if (result.status !== 200) return routeError(result);
      const body = includeContent ? withoutNotePreview(result.body) : result.body;
      if (includeContent) return responseValue(body);
      const note =
        body.note && typeof body.note === "object" && !Array.isArray(body.note)
          ? (body.note as Record<string, unknown>)
          : undefined;
      return responseValue({ ...body, ...(note ? { note: conciseWriteNote(note) } : {}) });
    },
  );

  server.registerTool(
    "get_notes_batch",
    {
      title: "批量读取笔记",
      description: "批量读取正文，保留总字符预算；各篇分别读取，不构成同一时刻的一致快照。",
      inputSchema: z
        .object({
          noteIds: z
            .array(z.string().min(1).max(200))
            .min(1)
            .max(50)
            .describe("要读取的笔记 ID，最多 50 个且不能重复"),
          limit: z
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .describe("本次最多返回的笔记数；省略时取 min(noteIds.length, 50)，最大 50"),
          maxTotalCharacters: z
            .number()
            .int()
            .min(1)
            .max(100_000)
            .optional()
            .describe("正文总 Unicode 字符预算，默认 20,000，最大 100,000"),
        })
        .strict(),
    },
    async ({ noteIds, limit, maxTotalCharacters = 20_000 }) => {
      // Passing 50 ids should return 50 notes by default instead of silently deferring 30.
      const effectiveLimit = limit ?? Math.min(noteIds.length, 50);
      if (!user)
        return responseValue(
          { error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } },
          true,
        );
      if (new Set(noteIds).size !== noteIds.length) {
        return responseValue(
          { error: { code: "DUPLICATE_NOTE_ID", message: "noteIds 中不能重复出现同一篇笔记" } },
          true,
        );
      }
      // One query for the whole batch: per-note reads would repeat the join and the
      // preview formatter for every id. Preview and thumbnail are not exposed here.
      const rows = all<{
        id: string;
        title: string;
        content_length: number;
        notebook_id: string;
        notebook_name: string;
        is_favorite: number;
        deleted_at: number | null;
        version: number;
        created_at: number;
        updated_at: number;
        tags_json: string;
      }>(
        options.database,
        `
      SELECT n.id, n.title, length(n.content_markdown) AS content_length,
        n.notebook_id, b.name AS notebook_name,
        n.is_favorite, n.deleted_at, n.version, n.created_at, n.updated_at,
        COALESCE((SELECT json_group_array(tag) FROM (SELECT tag FROM note_tags WHERE note_id = n.id ORDER BY position)), '[]') AS tags_json
      FROM notes n
      JOIN notebooks b ON b.id = n.notebook_id AND b.user_id = n.user_id
      WHERE n.user_id = ? AND n.id IN (${noteIds.map(() => "?").join(",")})
    `,
        user.id,
        ...noteIds,
      );
      const rowsById = new Map(rows.map((row) => [row.id, row]));
      const contentStatement = options.database.query(
        "SELECT content_markdown FROM notes WHERE id = ? AND user_id = ?",
      );

      const notes: Record<string, unknown>[] = [];
      const notFoundIds: string[] = [];
      const oversizedIds: string[] = [];
      let deferredCount = 0;
      let totalContentCharacters = 0;
      for (const noteId of noteIds) {
        // Ids beyond the effective limit stay unclassified so the caller can retry
        // them with a larger limit instead of treating them as missing.
        if (notes.length >= effectiveLimit) {
          deferredCount += 1;
          continue;
        }
        const row = rowsById.get(noteId);
        if (!row) {
          notFoundIds.push(noteId);
          continue;
        }
        const contentCharacters = row.content_length;
        if (totalContentCharacters + contentCharacters > maxTotalCharacters) {
          oversizedIds.push(noteId);
          continue;
        }
        const contentRow = contentStatement.get(noteId, user.id) as {
          content_markdown: string;
        } | null;
        if (!contentRow) {
          notFoundIds.push(noteId);
          continue;
        }
        const contentMarkdown = contentRow.content_markdown;
        notes.push({
          id: row.id,
          notebookId: row.notebook_id,
          notebookName: row.notebook_name,
          title: row.title,
          tags: parseIndexedTags(row.tags_json),
          isFavorite: Boolean(row.is_favorite),
          deletedAt: row.deleted_at,
          version: row.version,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          contentMarkdown,
        });
        totalContentCharacters += contentCharacters;
      }
      const returned = new Set(notes.map((note) => note.id as string));
      const notFound = new Set(notFoundIds);
      const remainingIds = noteIds.filter(
        (noteId) => !returned.has(noteId) && !notFound.has(noteId),
      );
      const checkedCount = noteIds.length - deferredCount;
      return responseValue({
        notes,
        notFoundIds,
        oversizedIds,
        remainingIds,
        checkedCount,
        uncheckedCount: noteIds.length - checkedCount,
        returnedCount: notes.length,
        totalContentCharacters,
        maxTotalCharacters,
        skippedForCharacterLimit: oversizedIds.length > 0,
      });
    },
  );

  server.registerTool(
    "create_note",
    {
      title: "创建笔记",
      description:
        "创建 Markdown 笔记并追加 tags，允许同名；省略笔记本放入收件箱。常规保存或需防重名时用 save_note。 图片仅接受 HTTPS 地址或当前用户可用于该笔记的已上传附件，MCP 不上传图片。",
      inputSchema: z
        .object({
          title: z.string().min(1).max(200),
          contentMarkdown: z
            .string()
            .max(NOTE_CONTENT_MAX_LENGTH)
            .optional()
            .describe(
              "可直接传入完整 Markdown 正文；普通笔记优先一次创建；只有客户端明确无法承载单次参数或服务端返回 MCP 请求体超过 4.5 MB 的错误时才分段；最多 1,000,000 个 UTF-16 code units",
            ),
          notebookId: z.string().min(1).max(200).optional(),
          notebookName: z.string().trim().min(1).max(40).optional(),
          tags: noteTagsSchema
            .optional()
            .describe(
              "要追加到正文的标签名，仅可含中文、字母、数字、下划线或连字符，不带 #；仅追加，不会覆盖已有标签（整体替换请用 manage_note action=set_tags）",
            ),
          includeContent: z
            .boolean()
            .optional()
            .describe("是否在成功结果中回传完整正文，默认 false"),
        })
        .strict(),
    },
    async ({
      title,
      contentMarkdown = "",
      notebookId,
      notebookName,
      tags = [],
      includeContent = false,
    }) => {
      if (!user)
        return responseValue(
          { error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } },
          true,
        );
      const resolved = await resolveNotebook(options, user, { notebookId, notebookName });
      if (resolved.error) return responseValue({ error: resolved.error }, true);
      notebookId = resolved.notebook?.id;

      if (!validMcpTags(tags)) return invalidMcpTagsError(tags);
      const payload = {
        title,
        contentMarkdown: appendMarkdownTags(contentMarkdown, tags),
        ...(notebookId === undefined ? {} : { notebookId }),
      };
      const result = await notesRoute(
        options,
        user,
        "POST",
        ["notes"],
        `/api/notes${includeContent ? "" : "?response=summary"}`,
        payload,
      );
      return result.status === 201
        ? responseValue(result.body, false, { writeResult: true, includeContent })
        : noteWriteError(result);
    },
  );

  server.registerTool(
    "update_note",
    {
      title: "更新笔记",
      description:
        "修改标题或覆盖完整正文；所有写入的版本参数统一 expectedVersion，不接受 version/baseVersion 别名；全文覆盖必须提供 expectedVersion，局部修改优先用片段或章节工具。 图片仅接受 HTTPS 地址或当前用户可用于该笔记的已上传附件，MCP 不上传图片。",
      inputSchema: z
        .object({
          noteId: z.string().min(1).max(200),
          expectedVersion: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("预期版本；仅改标题可省略，覆盖正文必须提供版本"),
          title: z.string().max(200).optional(),
          contentMarkdown: z
            .string()
            .max(NOTE_CONTENT_MAX_LENGTH)
            .optional()
            .describe(
              "完整替换 Markdown 正文；最多 1,000,000 个 UTF-16 code units（JavaScript string.length）",
            ),
          includeContent: z
            .boolean()
            .optional()
            .describe("是否在成功结果中回传完整正文，默认 false"),
        })
        .strict(),
    },
    async ({
      noteId,
      expectedVersion: version,
      title,
      contentMarkdown,
      includeContent = false,
    }) => {
      if (!user)
        return responseValue(
          { error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } },
          true,
        );
      if (title === undefined && contentMarkdown === undefined) {
        return responseValue(
          { error: { code: "EMPTY_UPDATE", message: "请至少提供一个要更新的字段" } },
          true,
        );
      }
      if (contentMarkdown !== undefined && version === undefined)
        return responseValue(
          {
            error: {
              code: "VERSION_REQUIRED",
              message: "全文覆盖必须提供读取时的 expectedVersion",
            },
          },
          true,
        );
      const result = await updateNoteRoute(options, user, {
        noteId,
        version,
        title,
        contentMarkdown,
        includeContent,
      });
      return result.status === 200
        ? responseValue(result.body, false, { writeResult: true, includeContent })
        : noteWriteError(result);
    },
  );
}
