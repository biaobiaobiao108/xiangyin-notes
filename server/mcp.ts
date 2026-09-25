import { createMcpHandler, McpServer, type AuthInfo, type McpHttpHandler, type McpRequestContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  constantTimeEqual,
  escapeLikePattern,
  getPublicOrigin,
  jsonError,
  NOTE_BODY_MAX_BYTES,
  NOTE_PREVIEW_LIMIT,
  type RouteContext,
  type ServerOptions,
  type SqliteDatabase,
  type UserRow,
} from "./core";
import { ensureEnvironmentUser, getAuthCredentials } from "./routes/auth";
import { assetRootFromEnv } from "./routes/assets";
import { handleNotebooksRoute, VALID_NOTEBOOK_ICONS } from "./routes/notebooks";
import { handleNotesRoute } from "./routes/notes";
import { extractTags, normalizeTag, removeTagsFromMarkdown } from "../shared/tags";

export const MCP_PATH = "/mcp";
const MCP_SERVER_INSTRUCTIONS = [
  "象映笔记：用于搜索、读取、新建、追加、锚点插入、更新和软删除笔记；可列出回收站并恢复笔记，也可以管理笔记本。",
  "工具参数必须是 JSON 对象。客户端会先校验参数；手写原始 JSON 时，字符串中的控制字符须按 JSON 规范转义（换行写作 \\n）。多行 Markdown 请通过客户端的结构化工具参数传入，JSON 解析后的正文会保留换行。",
  "需要分类时先调用 list_notebooks 获取笔记本 ID；可用 create_notebook 创建笔记本，再把 ID 传给 create_note。创建笔记时省略 notebookId 会放入收件箱。标签由正文中非代码区域的 #标签 标记；create_note 和 update_note 的 tags 参数会追加标签，update_note 与 batch_update_notes 的 removeTags 参数可移除标签；search_notes 可按标签筛选。",
  "查找内容时使用 search_notes，省略 query 可浏览最近更新的笔记；已删除笔记用 list_trash 查找，再用 update_note 设置 deleted=false 恢复。需要正文时调用 get_note，可按 ID 或标题读取。修改前先读取最新版本，并将 version 传给 update_note、append_to_note、insert_into_note 或 delete_note。遇到 VERSION_CONFLICT 时查看 error.current，合并后使用最新 version 重试。",
  "MCP 只传输文字和 Markdown，不提供图片数据或缩略图；保留正文中的图片引用。",
].join(" ");

const noteTagsSchema = z.array(z.string().trim().min(1).max(40).regex(/^[\p{L}\p{N}_-]+$/u)).max(50);

type RouteResult = {
  status: number;
  body: Record<string, unknown>;
};

const handlerByDatabase = new WeakMap<SqliteDatabase, McpHttpHandler>();

function asUser(value: unknown): UserRow | null {
  if (!value || typeof value !== "object") return null;
  const user = value as Partial<UserRow>;
  return typeof user.id === "string" && typeof user.username === "string"
    ? { id: user.id, username: user.username }
    : null;
}

function responseValue(value: Record<string, unknown>, isError = false, options: { writeResult?: boolean; includeContent?: boolean } = {}) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(withoutThumbnailMetadata(value, options)) }],
    ...(isError ? { isError: true } : {}),
  };
}

function withoutThumbnailMetadata(value: Record<string, unknown>, options: { writeResult?: boolean; includeContent?: boolean }) {
  const omitThumbnail = (note: unknown) => {
    if (!note || typeof note !== "object" || Array.isArray(note)) return note;
    const sanitized = { ...(note as Record<string, unknown>) };
    delete sanitized.thumbnail;
    if (options.writeResult) {
      delete sanitized.preview;
      if (!options.includeContent) delete sanitized.contentMarkdown;
    }
    return sanitized;
  };
  const { note, notes, error, ...rest } = value;
  return {
    ...rest,
    ...(note === undefined ? {} : { note: omitThumbnail(note) }),
    ...(Array.isArray(notes) ? { notes: notes.map(omitThumbnail) } : notes === undefined ? {} : { notes }),
    ...(error && typeof error === "object" && "current" in error
      ? { error: { ...error, current: omitThumbnail(error.current) } }
      : error === undefined ? {} : { error }),
  };
}

function appendMarkdownTags(markdown: string, tags: string[]) {
  const seen = new Set(extractTags(markdown).map(normalizeTag));
  const additions: string[] = [];
  for (const rawTag of tags) {
    const tag = rawTag.trim();
    const normalized = normalizeTag(tag);
    if (!tag || seen.has(normalized)) continue;
    seen.add(normalized);
    additions.push(`#${tag}`);
  }
  if (additions.length === 0) return markdown;
  const body = markdown.replace(/(\r\n|\n|\r)[\t ]+$/u, "$1");
  const endsWithLineBreak = /(?:\r\n|\n|\r)$/u.test(body);
  const separator = body.length > 0 && !endsWithLineBreak ? "\n" : "";
  return `${body}${separator}${additions.join(" ")}`;
}

function previewAtLength(value: unknown, previewLength: number) {
  if (typeof value !== "string") return value;
  const characters = Array.from(value);
  if (characters.length <= previewLength) return value;
  if (previewLength === 0) return "";
  return `${characters.slice(0, previewLength - 1).join("")}…`;
}

function withPreviewLimit(notes: Record<string, unknown>[], previewLength: number) {
  return notes.map((note) => ({ ...note, preview: previewAtLength(note.preview, previewLength) }));
}

function conciseWriteNote(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const note = value as Record<string, unknown>;
  return {
    id: note.id,
    title: note.title,
    notebookId: note.notebookId,
    notebookName: note.notebookName,
    tags: note.tags,
    isFavorite: note.isFavorite,
    deletedAt: note.deletedAt,
    version: note.version,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
}

async function routeResult(response: Response | null): Promise<RouteResult> {
  if (!response) return { status: 500, body: { error: { code: "MCP_ROUTE_NOT_FOUND", message: "笔记操作暂时不可用" } } };
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  return { status: response.status, body };
}

function routeError(result: RouteResult) {
  const error = result.body.error;
  const normalizedError = error && typeof error === "object"
    ? error as Record<string, unknown>
    : { code: "MCP_OPERATION_FAILED", message: "笔记操作失败" };
  return responseValue({ error: normalizedError }, true);
}

function createRouteContext(options: ServerOptions, method: string, pathname: string, segments: string[], payload?: unknown): RouteContext {
  const url = new URL(pathname, "http://xiangying-notes.internal");
  const request = new Request(url, {
    method,
    headers: payload === undefined ? undefined : { "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { request, url, method, segments, options };
}

async function notesRoute(options: ServerOptions, user: UserRow, method: string, segments: string[], urlPath: string, payload?: unknown) {
  const context = createRouteContext(options, method, urlPath, segments, payload);
  const assetRoot = options.assetRoot ?? assetRootFromEnv(options.environment);
  return routeResult(await handleNotesRoute(context, user, assetRoot));
}

async function notebooksRoute(options: ServerOptions, user: UserRow, method: "GET" | "POST" = "GET", payload?: unknown) {
  const context = createRouteContext(options, method, "/api/notebooks", ["notebooks"], payload);
  return routeResult(await handleNotebooksRoute(context, user));
}

type NoteUpdateInput = {
  noteId: string;
  version: number;
  title?: string;
  contentMarkdown?: string;
  notebookId?: string;
  isFavorite?: boolean;
  deleted?: boolean;
  tags?: string[];
  removeTags?: string[];
  includeContent?: boolean;
};

async function updateNoteRoute(options: ServerOptions, user: UserRow, input: NoteUpdateInput) {
  let contentMarkdown = input.contentMarkdown;
  if (input.tags?.length || input.removeTags?.length) {
    if (contentMarkdown === undefined) {
      const current = await notesRoute(options, user, "GET", ["notes", input.noteId], `/api/notes/${encodeURIComponent(input.noteId)}`);
      if (current.status !== 200) return current;
      const note = current.body.note as Record<string, unknown> | undefined;
      if (typeof note?.contentMarkdown !== "string") return { status: 500, body: { error: { code: "NOTE_READ_FAILED", message: "读取笔记正文失败" } } };
      contentMarkdown = note.contentMarkdown;
    }
    contentMarkdown = removeTagsFromMarkdown(contentMarkdown, input.removeTags ?? []);
    contentMarkdown = appendMarkdownTags(contentMarkdown, input.tags ?? []);
  }
  const payload = {
    version: input.version,
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(contentMarkdown === undefined ? {} : { contentMarkdown }),
    ...(input.notebookId === undefined ? {} : { notebookId: input.notebookId }),
    ...(input.isFavorite === undefined ? {} : { isFavorite: input.isFavorite }),
    ...(input.deleted === undefined ? {} : { deleted: input.deleted }),
  };
  const path = `/api/notes/${encodeURIComponent(input.noteId)}${input.includeContent ? "" : "?response=summary"}`;
  return notesRoute(options, user, "PATCH", ["notes", input.noteId], path, payload);
}

async function noteByTitle(options: ServerOptions, user: UserRow, requestedTitle: string) {
  const title = requestedTitle.trim();
  const rows = options.database.query(`
    SELECT n.id, n.title, b.name AS notebook_name
    FROM notes n JOIN notebooks b ON b.id = n.notebook_id
    WHERE n.user_id = ? AND n.deleted_at IS NULL AND n.title LIKE ? ESCAPE '!'
    ORDER BY CASE WHEN n.title = ? COLLATE NOCASE THEN 0 ELSE 1 END, n.updated_at DESC, n.id DESC
    LIMIT 6
  `).all(user.id, `%${escapeLikePattern(title)}%`, title) as { id: string; title: string; notebook_name: string }[];
  const normalizedTitle = title.normalize("NFKC").toLocaleLowerCase("zh-CN");
  const exactMatches = rows.filter((note) => note.title.normalize("NFKC").toLocaleLowerCase("zh-CN") === normalizedTitle);
  const matches = exactMatches.length > 0 ? exactMatches : rows;
  if (matches.length === 0) return { error: { code: "NOTE_NOT_FOUND", message: "找不到标题匹配的笔记" } };
  if (matches.length !== 1 || (exactMatches.length > 0 && rows.length === 6 && exactMatches.length === 6)) {
    return {
      error: {
        code: "AMBIGUOUS_TITLE",
        message: "标题匹配到多篇笔记，请使用 noteId 指定目标",
        matches: matches.slice(0, 5).map((note) => ({ id: note.id, title: note.title, notebookName: note.notebook_name })),
        truncated: matches.length > 5,
      },
    };
  }
  return { noteId: matches[0].id };
}

function mcpUser(context: McpRequestContext) {
  return asUser(context.authInfo?.extra?.user);
}

function createNoteMcpServer(options: ServerOptions, context: McpRequestContext) {
  const server = new McpServer({ name: "xiangying-notes", version: "0.1.0" }, {
    instructions: MCP_SERVER_INSTRUCTIONS,
  });
  const user = mcpUser(context);

  server.registerTool("list_notebooks", {
    title: "列出笔记本",
    description: "列出象映笔记中的笔记本，返回 ID、名称和笔记数量。",
    inputSchema: z.object({}),
  }, async () => {
    if (!user) return responseValue({ error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } }, true);
    const result = await notebooksRoute(options, user);
    return result.status === 200 ? responseValue(result.body) : routeError(result);
  });

  server.registerTool("create_notebook", {
    title: "创建笔记本",
    description: "创建一个用于分类笔记的新笔记本。返回新笔记本的 ID、名称、图标和颜色；省略颜色或图标时使用默认值。",
    inputSchema: z.object({
      name: z.string().trim().min(1).max(40).describe("笔记本名称，最多 40 个字符"),
      color: z.string().regex(/^#[0-9a-f]{6}$/iu).optional().describe("六位十六进制颜色，例如 #718077"),
      icon: z.enum(VALID_NOTEBOOK_ICONS).optional().describe("笔记本图标标识，例如 folder、book 或 bookmark"),
    }),
  }, async ({ name, color, icon }) => {
    if (!user) return responseValue({ error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } }, true);
    const payload = {
      name,
      ...(color === undefined ? {} : { color }),
      ...(icon === undefined ? {} : { icon }),
    };
    const result = await notebooksRoute(options, user, "POST", payload);
    return result.status === 201 ? responseValue(result.body) : routeError(result);
  });

  server.registerTool("search_notes", {
    title: "搜索笔记",
    description: "按标题或正文搜索笔记，可用 tag 精确筛选正文标签。省略 query 可列出最近更新的笔记；使用 nextCursor 读取下一页。默认每页 20 篇，preview 默认最多 120 个 Unicode 字符。结果不包含图片或缩略图。",
    inputSchema: z.object({
      query: z.string().max(80).optional().describe("搜索词；省略或留空时列出最近笔记"),
      tag: z.string().trim().min(1).max(40).regex(/^[#]?[\p{L}\p{N}_-]+$/u).optional().describe("按正文中的标签精确筛选，可带或不带 #"),
      notebookId: z.string().min(1).max(200).optional().describe("仅搜索指定笔记本"),
      cursor: z.string().max(2048).optional().describe("上一次搜索结果返回的 nextCursor"),
      limit: z.number().int().min(1).max(100).optional().describe("每页数量，默认 20，最大 100"),
      previewLength: z.number().int().min(0).max(NOTE_PREVIEW_LIMIT).optional().describe(`每篇笔记的摘要长度，默认 120，最大 ${NOTE_PREVIEW_LIMIT} 个 Unicode 字符`),
    }),
  }, async ({ query, tag, notebookId, cursor, limit = 20, previewLength = 120 }) => {
    if (!user) return responseValue({ error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } }, true);
    const url = new URL("/api/notes", "http://xiangying-notes.internal");
    if (query) url.searchParams.set("query", query);
    if (tag) url.searchParams.set("tag", tag.startsWith("#") ? tag.slice(1) : tag);
    if (notebookId) url.searchParams.set("notebookId", notebookId);
    if (cursor) url.searchParams.set("cursor", cursor);
    url.searchParams.set("limit", String(limit));
    const result = await notesRoute(options, user, "GET", ["notes"], `${url.pathname}${url.search}`);
    if (result.status !== 200) return routeError(result);
    const notes = Array.isArray(result.body.notes) ? result.body.notes as Record<string, unknown>[] : [];
    return responseValue({ ...result.body, notes: withPreviewLimit(notes, previewLength) });
  });

  server.registerTool("list_trash", {
    title: "列出回收站",
    description: "分页列出已移入回收站的笔记。返回的 noteId 与 version 可用于 update_note 设置 deleted=false 恢复笔记。每页默认 20 篇，摘要默认最多 120 个 Unicode 字符。",
    inputSchema: z.object({
      cursor: z.string().max(2048).optional().describe("上一页返回的 nextCursor"),
      limit: z.number().int().min(1).max(100).optional().describe("每页数量，默认 20，最大 100"),
      previewLength: z.number().int().min(0).max(NOTE_PREVIEW_LIMIT).optional().describe(`每篇笔记的摘要长度，默认 120，最大 ${NOTE_PREVIEW_LIMIT} 个 Unicode 字符`),
    }),
  }, async ({ cursor, limit = 20, previewLength = 120 }) => {
    if (!user) return responseValue({ error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } }, true);
    const url = new URL("/api/notes", "http://xiangying-notes.internal");
    url.searchParams.set("view", "trash");
    if (cursor) url.searchParams.set("cursor", cursor);
    url.searchParams.set("limit", String(limit));
    const result = await notesRoute(options, user, "GET", ["notes"], `${url.pathname}${url.search}`);
    if (result.status !== 200) return routeError(result);
    const notes = Array.isArray(result.body.notes) ? result.body.notes as Record<string, unknown>[] : [];
    return responseValue({ ...result.body, notes: withPreviewLimit(notes, previewLength) });
  });

  server.registerTool("get_note", {
    title: "读取笔记",
    description: "按 noteId 读取，或按 title 进行标题子串匹配读取。title 匹配唯一时返回笔记；匹配多篇时返回候选 ID，请缩小标题或使用 noteId。保留 Markdown 图片引用，但不提供图片内容或缩略图。更新前先读取 version。",
    inputSchema: z.object({
      noteId: z.string().min(1).max(200).optional(),
      title: z.string().trim().min(1).max(200).optional(),
    }),
  }, async ({ noteId, title }) => {
    if (!user) return responseValue({ error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } }, true);
    if (Boolean(noteId) === Boolean(title)) {
      return responseValue({ error: { code: "INVALID_NOTE_SELECTOR", message: "请且仅提供 noteId 或 title 其中一个" } }, true);
    }
    if (title !== undefined) {
      const match = await noteByTitle(options, user, title);
      if ("error" in match) return responseValue(match, true);
      noteId = match.noteId;
    }
    const result = await notesRoute(options, user, "GET", ["notes", noteId as string], `/api/notes/${encodeURIComponent(noteId as string)}`);
    return result.status === 200 ? responseValue(result.body) : routeError(result);
  });

  server.registerTool("create_note", {
    title: "创建笔记",
    description: "创建一篇 Markdown 笔记。contentMarkdown 支持多行 Markdown 文本，直接传入即可；若手写原始 JSON，其中的换行、制表符等控制字符必须转义。tags 会以 #标签 形式追加到正文。省略 notebookId 时放入收件箱。默认不回传正文；需要时设 includeContent=true。",
    inputSchema: z.object({
      title: z.string().min(1).max(200),
      contentMarkdown: z.string().max(1_000_000).optional(),
      notebookId: z.string().min(1).max(200).optional(),
      tags: noteTagsSchema.optional().describe("要追加到正文的标签名，不带 #"),
      includeContent: z.boolean().optional().describe("是否在成功结果中回传完整正文，默认 false"),
    }),
  }, async ({ title, contentMarkdown = "", notebookId, tags = [], includeContent = false }) => {
    if (!user) return responseValue({ error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } }, true);
    const payload = {
      title,
      contentMarkdown: appendMarkdownTags(contentMarkdown, tags),
      ...(notebookId === undefined ? {} : { notebookId }),
    };
    const result = await notesRoute(options, user, "POST", ["notes"], "/api/notes", payload);
    return result.status === 201 ? responseValue(result.body, false, { writeResult: true, includeContent }) : routeError(result);
  });

  server.registerTool("update_note", {
    title: "更新笔记",
    description: "更新笔记标题、Markdown 正文、所属笔记本、收藏或回收站状态。contentMarkdown 支持多行文本，直接传入即可；若手写原始 JSON，其中的换行、制表符等控制字符必须转义。tags 会以 #标签 形式追加到正文，removeTags 会从正文中移除匹配的标签标记。必须提供 get_note 返回的 version；遇到版本冲突时先读取当前内容并合并后再重试。传 deleted=false 可恢复笔记。默认不回传正文；需要时设 includeContent=true。",
    inputSchema: z.object({
      noteId: z.string().min(1).max(200),
      version: z.number().int().positive(),
      title: z.string().max(200).optional(),
      contentMarkdown: z.string().max(1_000_000).optional(),
      notebookId: z.string().min(1).max(200).optional(),
      isFavorite: z.boolean().optional(),
      deleted: z.boolean().optional().describe("true 将笔记移入回收站，false 恢复笔记"),
      tags: noteTagsSchema.optional().describe("要追加到正文的标签名，不带 #"),
      removeTags: noteTagsSchema.optional().describe("要从正文中移除的标签名，不带 #；会移除非代码区域中所有匹配标记"),
      includeContent: z.boolean().optional().describe("是否在成功结果中回传完整正文，默认 false"),
    }),
  }, async ({ noteId, version, title, contentMarkdown, notebookId, isFavorite, deleted, tags, removeTags, includeContent = false }) => {
    if (!user) return responseValue({ error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } }, true);
    if (title === undefined && contentMarkdown === undefined && notebookId === undefined && isFavorite === undefined && deleted === undefined && !tags?.length && !removeTags?.length) {
      return responseValue({ error: { code: "EMPTY_UPDATE", message: "请至少提供一个要更新的字段" } }, true);
    }
    const result = await updateNoteRoute(options, user, { noteId, version, title, contentMarkdown, notebookId, isFavorite, deleted, tags, removeTags, includeContent });
    return result.status === 200 ? responseValue(result.body, false, { writeResult: true, includeContent }) : routeError(result);
  });

  server.registerTool("append_to_note", {
    title: "追加到笔记",
    description: "将 contentMarkdown 精确追加到现有正文末尾，避免重新发送长正文。必须提供 get_note 返回的 version；若需要换行，请在追加文本中包含换行。内容按 JSON 传输，多行正文在结构化参数中直接传入；原始 JSON 文本中的控制字符必须转义。默认不回传完整正文。",
    inputSchema: z.object({
      noteId: z.string().min(1).max(200),
      version: z.number().int().positive(),
      contentMarkdown: z.string().min(1).max(1_000_000),
      includeContent: z.boolean().optional().describe("是否在成功结果中回传完整正文，默认 false"),
    }),
  }, async ({ noteId, version, contentMarkdown, includeContent = false }) => {
    if (!user) return responseValue({ error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } }, true);
    const current = await notesRoute(options, user, "GET", ["notes", noteId], `/api/notes/${encodeURIComponent(noteId)}`);
    if (current.status !== 200) return routeError(current);
    const note = current.body.note as Record<string, unknown> | undefined;
    if (typeof note?.contentMarkdown !== "string") return responseValue({ error: { code: "NOTE_READ_FAILED", message: "读取笔记正文失败" } }, true);
    const result = await updateNoteRoute(options, user, {
      noteId,
      version,
      contentMarkdown: `${note.contentMarkdown}${contentMarkdown}`,
      includeContent,
    });
    return result.status === 200 ? responseValue(result.body, false, { writeResult: true, includeContent }) : routeError(result);
  });

  server.registerTool("insert_into_note", {
    title: "按锚点插入正文",
    description: "在正文中唯一匹配的 anchor 前或后插入 Markdown，不必重传整篇笔记。anchor 按原文精确匹配；找不到或出现多次时会报错，不会修改笔记。必须提供 get_note 返回的 version。默认插入到锚点后。",
    inputSchema: z.object({
      noteId: z.string().min(1).max(200),
      version: z.number().int().positive(),
      anchor: z.string().min(1).max(2000).describe("正文中精确且唯一的原文片段"),
      contentMarkdown: z.string().min(1).max(1_000_000).describe("要插入的 Markdown 内容"),
      position: z.enum(["before", "after"]).optional().describe("插入位置，默认 after"),
      includeContent: z.boolean().optional().describe("是否在成功结果中回传完整正文，默认 false"),
    }),
  }, async ({ noteId, version, anchor, contentMarkdown, position = "after", includeContent = false }) => {
    if (!user) return responseValue({ error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } }, true);
    const current = await notesRoute(options, user, "GET", ["notes", noteId], `/api/notes/${encodeURIComponent(noteId)}`);
    if (current.status !== 200) return routeError(current);
    const note = current.body.note as Record<string, unknown> | undefined;
    if (typeof note?.contentMarkdown !== "string") return responseValue({ error: { code: "NOTE_READ_FAILED", message: "读取笔记正文失败" } }, true);
    if (typeof note.version === "number" && note.version !== version) {
      return responseValue({
        error: {
          code: "VERSION_CONFLICT",
          message: "这篇笔记已在别处更新",
          current: note,
        },
      }, true);
    }
    const body = note.contentMarkdown;
    const firstMatch = body.indexOf(anchor);
    if (firstMatch === -1) return responseValue({ error: { code: "ANCHOR_NOT_FOUND", message: "正文中找不到指定 anchor" } }, true);
    if (body.indexOf(anchor, firstMatch + 1) !== -1) return responseValue({ error: { code: "AMBIGUOUS_ANCHOR", message: "anchor 在正文中出现多次，请提供更长且唯一的片段" } }, true);
    const insertionPoint = position === "before" ? firstMatch : firstMatch + anchor.length;
    const updatedBody = `${body.slice(0, insertionPoint)}${contentMarkdown}${body.slice(insertionPoint)}`;
    const result = await updateNoteRoute(options, user, { noteId, version, contentMarkdown: updatedBody, includeContent });
    return result.status === 200 ? responseValue(result.body, false, { writeResult: true, includeContent }) : routeError(result);
  });

  server.registerTool("delete_note", {
    title: "移入回收站",
    description: "将笔记软删除并移入回收站，不会永久删除。必须提供 get_note 返回的 version；可在客户端恢复，或用 update_note 设置 deleted=false。",
    inputSchema: z.object({ noteId: z.string().min(1).max(200), version: z.number().int().positive() }),
  }, async ({ noteId, version }) => {
    if (!user) return responseValue({ error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } }, true);
    const result = await updateNoteRoute(options, user, { noteId, version, deleted: true });
    return result.status === 200 ? responseValue(result.body, false, { writeResult: true }) : routeError(result);
  });

  server.registerTool("batch_update_notes", {
    title: "批量更新笔记",
    description: "批量移动笔记本、添加或移除正文标签、切换收藏或移入/恢复回收站。每篇笔记都必须带上读取时的 version；逐条执行并返回每条结果，冲突不会覆盖，失败项可单独重试。一次最多 50 篇。",
    inputSchema: z.object({
      notes: z.array(z.object({ noteId: z.string().min(1).max(200), version: z.number().int().positive() })).min(1).max(50),
      notebookId: z.string().min(1).max(200).optional(),
      isFavorite: z.boolean().optional(),
      deleted: z.boolean().optional(),
      tags: noteTagsSchema.optional().describe("追加到每篇笔记正文的标签名，不带 #"),
      removeTags: noteTagsSchema.optional().describe("从每篇笔记正文移除的标签名，不带 #"),
    }),
  }, async ({ notes, notebookId, isFavorite, deleted, tags, removeTags }) => {
    if (!user) return responseValue({ error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } }, true);
    if (notebookId === undefined && isFavorite === undefined && deleted === undefined && !tags?.length && !removeTags?.length) {
      return responseValue({ error: { code: "EMPTY_UPDATE", message: "请至少提供 notebookId、isFavorite、deleted、tags 或 removeTags 中的一项" } }, true);
    }
    if (new Set(notes.map((note) => note.noteId)).size !== notes.length) {
      return responseValue({ error: { code: "DUPLICATE_NOTE_ID", message: "批量更新中不能重复出现同一篇笔记" } }, true);
    }
    const results: Record<string, unknown>[] = [];
    for (const note of notes) {
      const result = await updateNoteRoute(options, user, { ...note, notebookId, isFavorite, deleted, tags, removeTags });
      if (result.status === 200) {
        results.push({ noteId: note.noteId, ok: true, note: conciseWriteNote(result.body.note) });
      } else {
        const error = result.body.error && typeof result.body.error === "object"
          ? result.body.error as Record<string, unknown>
          : { code: "MCP_OPERATION_FAILED", message: "笔记更新失败" };
        results.push({ noteId: note.noteId, ok: false, error: { code: error.code, message: error.message } });
      }
    }
    const failedCount = results.filter((result) => result.ok === false).length;
    return responseValue({ results, updatedCount: results.length - failedCount, failedCount }, failedCount > 0);
  });

  return server;
}

function getMcpHandler(options: ServerOptions) {
  let handler = handlerByDatabase.get(options.database);
  if (!handler) {
    handler = createMcpHandler((context) => createNoteMcpServer(options, context));
    handlerByDatabase.set(options.database, handler);
  }
  return handler;
}

function staticToken(request: Request) {
  const authorization = request.headers.get("Authorization")?.trim() ?? "";
  const match = /^Bearer\s+(\S+)$/iu.exec(authorization);
  return match?.[1] ?? null;
}

function validateOrigin(request: Request, environment: Record<string, string | undefined>) {
  const originHeader = request.headers.get("Origin");
  if (!originHeader) return null;
  try {
    if (originHeader === "null") return jsonError(403, "INVALID_ORIGIN", "MCP 请求来源无效");
    const origin = new URL(originHeader);
    if (origin.origin !== getPublicOrigin(new URL(request.url), environment)) {
      return jsonError(403, "INVALID_ORIGIN", "MCP 请求来源无效");
    }
  } catch {
    return jsonError(403, "INVALID_ORIGIN", "MCP 请求来源无效");
  }
  return null;
}

function escapeUnescapedControlsInJsonStrings(value: string) {
  let inString = false;
  let escaped = false;
  let changed = false;
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    const code = character.charCodeAt(0);
    if (!inString) {
      output += character;
      if (character === '"') inString = true;
      continue;
    }
    if (escaped) {
      output += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      output += character;
      escaped = true;
      continue;
    }
    if (character === '"') {
      output += character;
      inString = false;
      continue;
    }
    if (code < 0x20) {
      changed = true;
      output += code === 0x08 ? "\\b"
        : code === 0x09 ? "\\t"
          : code === 0x0a ? "\\n"
            : code === 0x0c ? "\\f"
              : code === 0x0d ? "\\r"
                : `\\u${code.toString(16).padStart(4, "0")}`;
      continue;
    }
    output += character;
  }
  return { value: changed ? output : value, changed };
}

function invalidMcpArguments(id: unknown, message: string) {
  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    id: typeof id === "string" || typeof id === "number" ? id : null,
    error: { code: -32602, message },
  }), { status: 400, headers: { "Content-Type": "application/json; charset=utf-8" } });
}

async function readMcpBody(request: Request) {
  const reader = request.clone().body?.getReader();
  if (!reader) return { value: "", tooLarge: false };
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > NOTE_BODY_MAX_BYTES) {
      await reader.cancel();
      return { value: "", tooLarge: true };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { value: new TextDecoder().decode(bytes), tooLarge: false };
}

async function normalizeMcpRequest(request: Request): Promise<{ request: Request; error?: Response }> {
  if (request.method !== "POST" || !request.body) return { request };
  const { value: rawBody, tooLarge } = await readMcpBody(request);
  if (tooLarge) return { request, error: invalidMcpArguments(null, "MCP 请求体超出大小限制；请减少单次批量参数或拆分请求。") };
  const outer = escapeUnescapedControlsInJsonStrings(rawBody);
  let message: Record<string, unknown>;
  try {
    const parsed = JSON.parse(outer.value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { request };
    message = parsed as Record<string, unknown>;
  } catch {
    if (!outer.changed) return { request };
    return {
      request,
      error: invalidMcpArguments(null, "字符串中存在未转义的控制字符（U+0000–U+001F），请检查 contentMarkdown；修正后仍需发送完整 JSON。"),
    };
  }

  let rewritten = outer.changed;
  if (message.method === "tools/call") {
    const params = message.params && typeof message.params === "object" && !Array.isArray(message.params)
      ? message.params as Record<string, unknown>
      : null;
    const rawArguments = params?.arguments;
    let argumentsValue: unknown = rawArguments;
    if (typeof rawArguments === "string") {
      const inner = escapeUnescapedControlsInJsonStrings(rawArguments);
      try {
        argumentsValue = JSON.parse(rawArguments);
      } catch {
        if (!inner.changed) {
          return { request, error: invalidMcpArguments(message.id, "tools/call 的 arguments 必须是 JSON 对象，不能是字符串；请传入未二次序列化的对象参数。") };
        }
        try {
          argumentsValue = JSON.parse(inner.value);
          rewritten = true;
        } catch {
          return {
            request,
            error: invalidMcpArguments(message.id, "字符串中存在未转义的控制字符（U+0000–U+001F），请检查 contentMarkdown；arguments 还必须是完整 JSON 对象。"),
          };
        }
      }
      rewritten = true;
    }
    if (rawArguments !== undefined && (!argumentsValue || typeof argumentsValue !== "object" || Array.isArray(argumentsValue))) {
      return { request, error: invalidMcpArguments(message.id, "tools/call 的 arguments 必须是 JSON 对象；多行正文请放在 contentMarkdown 字段中。") };
    }
    if (rewritten && params && argumentsValue !== rawArguments) params.arguments = argumentsValue;
  }

  if (!rewritten) return { request };
  const headers = new Headers(request.headers);
  headers.delete("Content-Length");
  return { request: new Request(request, { headers, body: JSON.stringify(message) }) };
}

export async function handleMcpRequest(request: Request, options: ServerOptions) {
  const environment = options.environment ?? {};
  const expectedToken = environment.XIANGYING_MCP_TOKEN?.trim();
  if (!expectedToken) return jsonError(503, "MCP_AUTH_NOT_CONFIGURED", "请先配置 XIANGYING_MCP_TOKEN");

  const suppliedToken = staticToken(request);
  if (!suppliedToken || !constantTimeEqual(suppliedToken, expectedToken)) {
    return jsonError(401, "INVALID_MCP_TOKEN", "MCP Bearer Token 无效或缺失", {
      "WWW-Authenticate": 'Bearer realm="xiangying-mcp"',
    });
  }

  const originError = validateOrigin(request, environment);
  if (originError) return originError;

  const credentials = getAuthCredentials(environment);
  if (!credentials) return jsonError(503, "AUTH_NOT_CONFIGURED", "请先配置 XIANGYING_USERNAME 和 XIANGYING_PASSWORD");
  const user = await ensureEnvironmentUser(options.database, credentials);
  const authInfo: AuthInfo = {
    token: suppliedToken,
    clientId: "xiangying-notes-static-token",
    scopes: ["notes:read", "notes:write"],
    extra: { user },
  };

  const normalized = await normalizeMcpRequest(request);
  if (normalized.error) return normalized.error;
  const response = await getMcpHandler(options).fetch(normalized.request, { authInfo });
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  if (headers.get("Content-Type")?.toLowerCase().includes("text/event-stream")) headers.set("X-Accel-Buffering", "no");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
