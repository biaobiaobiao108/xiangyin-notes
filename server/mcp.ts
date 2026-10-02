import { createMcpHandler, McpServer, type AuthInfo, type McpHttpHandler, type McpRequestContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  constantTimeEqual,
  first,
  findNotesByTitlePattern,
  formatPreview,
  getPublicOrigin,
  jsonError,
  NOTE_BODY_MAX_BYTES,
  NOTE_CONTENT_MAX_LENGTH,
  NOTE_PREVIEW_LIMIT,
  NOTE_VIEWS,
  type RouteContext,
  type ServerOptions,
  type SqliteDatabase,
  type UserRow,
} from "./core";
import { ensureEnvironmentUser, getAuthCredentials } from "./routes/auth";
import { assetRootFromEnv } from "./routes/assets";
import { handleNotebooksRoute, VALID_NOTEBOOK_ICONS } from "./routes/notebooks";
import { handleNotesRoute } from "./routes/notes";
import { extractTags, findTrailingTagFooterStart, normalizeTag, NOTE_TAG_MAX_LENGTH, removeTagsFromMarkdown } from "../shared/tags";

export const MCP_PATH = "/mcp";
const MATCH_CONTEXT_LENGTH = 30;
const MATCH_CONTEXT_LIMIT = 10;
const MCP_CONTENT_FIELDS = new Map([
  ["create_note", "contentMarkdown"],
  ["update_note", "contentMarkdown"],
  ["append_to_note", "contentMarkdown"],
  ["insert_into_note", "contentMarkdown"],
  ["replace_in_note", "newText"],
]);
const MCP_SERVER_INSTRUCTIONS = [
  "象映笔记是跨会话 Markdown 记忆库，可搜索、读取、新建和增量修改笔记，也可管理笔记本、收藏、标签、回收站。",
  "工具参数必须是 JSON 对象。客户端会先校验参数；手写原始 JSON 时，字符串中的控制字符须按 JSON 规范转义（换行写作 \\n）；结构化参数中的多行 Markdown 会原样保留。",
  "字段值不合法时使用统一错误码 INVALID_ARGUMENT，并通过 field 指明字段；当前 field 取值为 name、color、icon、tag、tags。标签错误还会在 invalidTags 中列出违规值。",
  "普通笔记应优先在 create_note 一次写入完整正文；只有客户端明确无法承载单次参数，或服务端返回 MCP 请求体超过 4.5 MB 的错误时，才用 append_to_note 分段追加并沿用返回的 version。单篇正文硬上限为 1,000,000 个 UTF-16 code units。contentLength 回执与批量读取字符预算按 Unicode code points 计算。写操作默认不回传正文。",
  "需要分类时先用 list_notebooks 获取 ID；create_notebook 创建笔记本，update_notebook 修改，delete_notebook 需 confirm=true 并建议用 totalCount 做二次确认。单篇写操作可省略 version，由服务端读取当前版本并以乐观锁保存；batch_update_notes 必须提供每篇读取时的 version。单篇 VERSION_CONFLICT 返回完整 current；批量冲突只返回摘要与元数据，需要时再读取失败项正文。",
  "create_note.tags 与 batch_update_notes.tags 是追加；note_operation 的 set_tags 必须显式传 mode=replace、add 或 remove。正文中未转义、代码区外且不超过 40 个 UTF-16 code units 的 #标签会被索引；可在井号前加反斜杠保留字面井号。回收站笔记可恢复，但 MCP 不提供永久删除笔记或清空回收站。",
  "用 search_notes 的 view=trash 或 list_trash 检索回收站。get_notes_batch 最多读 50 篇、总正文默认预算 20,000 个 Unicode 字符；各笔记分别读取，不构成同一时刻快照。",
  "MCP 只传输文字和 Markdown，不提供图片数据、缩略图或图片上传；正文可引用 HTTPS 图片地址或当前用户可用于该笔记的已上传附件，无效或不可用的图片引用会被拒绝。",
].join(" ");

// Keep published JSON Schemas within the broadly supported regular-expression
// subset. Tag syntax is still validated in the MCP handler below.
const noteTagsSchema = z.array(z.string().trim().min(1).max(NOTE_TAG_MAX_LENGTH)).max(50);
const validMcpTagName = /^[\p{L}\p{N}_-]+$/u;

function validMcpTags(tags: readonly string[]) {
  return tags.every((tag) => validMcpTagName.test(tag.trim()));
}

function invalidMcpTagsError(tags: readonly string[]) {
  const invalidTags = [...new Set(tags.filter((tag) => !validMcpTagName.test(tag.trim())))];
  return responseValue({
    error: {
      code: "INVALID_ARGUMENT",
      field: "tags",
      invalidTags,
      message: `字段 tags 中的标签格式无效；标签只能包含中文、字母、数字、下划线或连字符，每个最多 ${NOTE_TAG_MAX_LENGTH} 个 UTF-16 code units，最多传 50 个标签。请检查 invalidTags。`,
    },
  }, true);
}
const noteOperationActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("move"),
    noteId: z.string().min(1).max(200),
    version: z.number().int().positive().optional(),
    notebookId: z.string().min(1).max(200),
  }).strict(),
  z.object({
    action: z.literal("set_favorite"),
    noteId: z.string().min(1).max(200),
    version: z.number().int().positive().optional(),
    isFavorite: z.boolean().describe("目标收藏状态；true 收藏，false 取消收藏，重复传入结果不反转"),
  }).strict(),
  z.object({
    action: z.literal("set_tags"),
    noteId: z.string().min(1).max(200),
    version: z.number().int().positive().optional(),
      tags: noteTagsSchema.describe("标签名，仅可含中文、字母、数字、下划线或连字符，不带 #；mode=replace 时传空数组以清空"),
    mode: z.enum(["replace", "add", "remove"]).describe("必填的标签操作方式；replace 整体替换，add 追加，remove 移除"),
  }).strict(),
  z.object({
    action: z.literal("trash"),
    noteId: z.string().min(1).max(200),
    version: z.number().int().positive().optional(),
  }).strict(),
  z.object({
    action: z.literal("restore"),
    noteId: z.string().min(1).max(200),
    version: z.number().int().positive().optional(),
  }).strict(),
]);
// Keep the published MCP schema as a plain object. Some clients incorrectly
// combine a root-level additionalProperties:false with oneOf and reject every
// action field before sending the request. The stricter discriminated union
// below still validates the action-specific field combinations server-side.
const noteOperationInputSchema = z.object({
  action: z.enum(["move", "set_favorite", "set_tags", "trash", "restore"]),
  noteId: z.string().min(1).max(200),
  version: z.number().int().positive().optional().describe("可选预期版本；省略时服务端读取当前版本，仍使用乐观锁"),
  notebookId: z.string().min(1).max(200).optional().describe("仅 action=move 时必填"),
  isFavorite: z.boolean().optional().describe("仅 action=set_favorite 时必填；true 收藏，false 取消收藏"),
  tags: noteTagsSchema.optional().describe("仅 action=set_tags 时必填；标签名仅可含中文、字母、数字、下划线或连字符，不带 #"),
  mode: z.enum(["replace", "add", "remove"]).optional().describe("action=set_tags 时必填；其他 action 不适用"),
}).strict();

function countUnicodeCharacters(value: string) {
  let count = 0;
  for (const _character of value) count += 1;
  return count;
}

function codePointBoundaryBefore(value: string, index: number, maximumCharacters: number) {
  let start = index;
  let count = 0;
  while (start > 0 && count < maximumCharacters) {
    const previous = value.charCodeAt(start - 1);
    const isLowSurrogate = previous >= 0xdc00 && previous <= 0xdfff;
    const hasHighSurrogate = start > 1 && value.charCodeAt(start - 2) >= 0xd800 && value.charCodeAt(start - 2) <= 0xdbff;
    start -= isLowSurrogate && hasHighSurrogate ? 2 : 1;
    count += 1;
  }
  return start;
}

function codePointBoundaryAfter(value: string, index: number, maximumCharacters: number) {
  let end = index;
  let count = 0;
  while (end < value.length && count < maximumCharacters) {
    const current = value.charCodeAt(end);
    const isHighSurrogate = current >= 0xd800 && current <= 0xdbff;
    const hasLowSurrogate = end + 1 < value.length && value.charCodeAt(end + 1) >= 0xdc00 && value.charCodeAt(end + 1) <= 0xdfff;
    end += isHighSurrogate && hasLowSurrogate ? 2 : 1;
    count += 1;
  }
  return end;
}

function findTextMatches(value: string, searchText: string, options: { overlapping?: boolean; occurrence?: number } = {}) {
  const matches: Array<{ offset: number; before: string; after: string }> = [];
  let matchCount = 0;
  let selectedOffset: number | null = null;
  let searchFrom = 0;
  while (searchFrom <= value.length) {
    const offset = value.indexOf(searchText, searchFrom);
    if (offset === -1) break;
    matchCount += 1;
    if (matchCount === options.occurrence) selectedOffset = offset;
    if (matches.length < MATCH_CONTEXT_LIMIT) {
      const matchEnd = offset + searchText.length;
      matches.push({
        offset,
        before: value.slice(codePointBoundaryBefore(value, offset, MATCH_CONTEXT_LENGTH), offset),
        after: value.slice(matchEnd, codePointBoundaryAfter(value, matchEnd, MATCH_CONTEXT_LENGTH)),
      });
    }
    searchFrom = offset + (options.overlapping ? 1 : searchText.length);
  }
  return { matchCount, matches, truncated: matchCount > matches.length, selectedOffset };
}

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

function responseValue(value: Record<string, unknown>, isError = false, options: { writeResult?: boolean; includeContent?: boolean; contentLength?: number } = {}) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(withMcpMetadata(withoutThumbnailMetadata(value, options))) }],
    ...(isError ? { isError: true } : {}),
  };
}

function withMcpMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withMcpMetadata);
  if (!value || typeof value !== "object") return value;
  const result = Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, withMcpMetadata(entry)]));
  const isoFromUnixSeconds = (seconds: unknown) => {
    if (typeof seconds !== "number" || !Number.isFinite(seconds)) return undefined;
    const date = new Date(seconds * 1000);
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
  };
  // Every timestamp exposed to an agent gets an ISO twin; raw Unix seconds are easy to misread.
  for (const [key, isoKey] of [
    ["updatedAt", "updatedAtISO"],
    ["createdAt", "createdAtISO"],
    ["deletedAt", "deletedAtISO"],
    ["expiresAt", "expiresAtISO"],
    ["revokedAt", "revokedAtISO"],
  ] as const) {
    const iso = isoFromUnixSeconds(result[key]);
    if (iso) result[isoKey] = iso;
  }
  if (Object.prototype.hasOwnProperty.call(result, "deletedAt")) result.isDeleted = result.deletedAt !== null;
  return result;
}

function withoutThumbnailMetadata(value: Record<string, unknown>, options: { writeResult?: boolean; includeContent?: boolean; contentLength?: number }) {
  const omitThumbnail = (note: unknown) => {
    if (!note || typeof note !== "object" || Array.isArray(note)) return note;
    const sanitized = { ...(note as Record<string, unknown>) };
    delete sanitized.thumbnail;
    if (options.writeResult) {
      delete sanitized.preview;
      if (options.contentLength !== undefined) sanitized.contentLength = options.contentLength;
      else if (typeof sanitized.contentMarkdown === "string") sanitized.contentLength = countUnicodeCharacters(sanitized.contentMarkdown);
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

function withoutNotePreview(value: Record<string, unknown>) {
  const result = { ...value };
  const note = result.note;
  if (note && typeof note === "object" && !Array.isArray(note)) {
    const noteWithoutPreview = { ...(note as Record<string, unknown>) };
    delete noteWithoutPreview.preview;
    result.note = noteWithoutPreview;
  }
  return result;
}

function compactConflictNote(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const note = { ...(value as Record<string, unknown>) };
  if (typeof note.contentMarkdown === "string") note.contentLength = countUnicodeCharacters(note.contentMarkdown);
  delete note.contentMarkdown;
  delete note.thumbnail;
  return note;
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
    contentLength: note.contentLength,
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
  return responseValue({ error: normalizeMcpError(normalizedError) }, true);
}

function normalizeMcpError(error: Record<string, unknown>) {
  if (error.code === "NOTE_NOT_FOUND") return { ...error, code: "NOT_FOUND", target: "note", legacyCode: "NOTE_NOT_FOUND" };
  if (error.code === "NOTEBOOK_NOT_FOUND") return { ...error, code: "NOT_FOUND", target: "notebook", legacyCode: "NOTEBOOK_NOT_FOUND" };
  return error;
}

function isDeletedNote(note: unknown) {
  return Boolean(note && typeof note === "object" && !Array.isArray(note)
    && ((note as Record<string, unknown>).isDeleted === true
      || ((note as Record<string, unknown>).deletedAt !== null && (note as Record<string, unknown>).deletedAt !== undefined)));
}

function noteInTrashError() {
  return responseValue({ error: { code: "NOTE_IN_TRASH", message: "回收站中的笔记只读，请先恢复笔记后再修改" } }, true);
}

function noteOperationValidationMessage(input: unknown, issues: z.ZodIssue[]) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return "参数必须是包含 action 和 noteId 的对象；version 可选。";
  }
  const value = input as Record<string, unknown>;
  const action = value.action;
  if (action === "set_tags") {
    if (!Object.hasOwn(value, "mode")) return "action=set_tags 时必须显式传 mode=replace、add 或 remove。";
    if (!Object.hasOwn(value, "tags")) return "action=set_tags 时必须传 tags 数组；mode 必须为 replace、add 或 remove。";
    if (issues.some((issue) => issue.path[0] === "mode")) return "action=set_tags 的 mode 只能是 replace、add 或 remove。";
    return "action=set_tags 参数无效；请检查 tags 数组、标签格式和必填的 mode。";
  }
  if (action === "move" && !Object.hasOwn(value, "notebookId")) return "action=move 时必须传 notebookId。";
  if (action === "set_favorite" && !Object.hasOwn(value, "isFavorite")) return "action=set_favorite 时必须传 isFavorite（true 收藏，false 取消收藏）。";
  if ((action === "trash" || action === "restore") && issues.some((issue) => issue.code === "unrecognized_keys")) {
    return `action=${action} 只接受 action、noteId 和可选的 version。`;
  }
  return "action 与参数不匹配；请只传该 action 需要的字段，并提供有效的 noteId。version 可省略，由服务端读取当前版本。";
}

function noteWriteError(result: RouteResult) {
  const error = result.body.error;
  if (error && typeof error === "object" && (error as Record<string, unknown>).code === "INVALID_ASSET") {
    return responseValue({
      error: {
        ...(error as Record<string, unknown>),
        message: "该图片引用无法写入：MCP 不提供图片上传；请使用 HTTPS 图片地址，或当前用户已上传且可用于此笔记的附件引用。",
      },
    }, true);
  }
  if (error && typeof error === "object" && (error as Record<string, unknown>).code === "NOTE_TOO_LARGE") {
    return responseValue({
      error: {
        ...(error as Record<string, unknown>),
        message: `笔记标题或正文超出长度限制（正文最多 ${NOTE_CONTENT_MAX_LENGTH.toLocaleString("en-US")} 个 UTF-16 code units）；请缩短正文或使用 replace_in_note 修正局部内容。分段追加不能突破单篇笔记的正文上限。`,
      },
    }, true);
  }
  return routeError(result);
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

async function notebooksRoute(
  options: ServerOptions,
  user: UserRow,
  method: "GET" | "POST" | "PATCH" | "DELETE" = "GET",
  payload?: unknown,
  notebookId?: string,
) {
  const encodedId = notebookId === undefined ? undefined : encodeURIComponent(notebookId);
  const path = encodedId === undefined ? "/api/notebooks" : `/api/notebooks/${encodedId}`;
  const segments = notebookId === undefined ? ["notebooks"] : ["notebooks", notebookId];
  const context = createRouteContext(options, method, path, segments, payload);
  return routeResult(await handleNotebooksRoute(context, user));
}

function appendToMarkdown(markdown: string, addition: string) {
  const footerStart = findTrailingTagFooterStart(markdown);
  if (footerStart === null) return `${markdown}${addition}`;

  const prefix = markdown.slice(0, footerStart);
  const footer = markdown.slice(footerStart);
  const inserted = `${prefix}${addition}`;
  if (/(?:\r\n|\n|\r)$/u.test(inserted)) return `${inserted}${footer}`;

  const lineBreak = markdown.match(/\r\n|\n|\r/u)?.[0] ?? "\n";
  return `${inserted}${lineBreak}${footer}`;
}

type NoteUpdateInput = {
  noteId: string;
  version?: number;
  currentNote?: Record<string, unknown>;
  title?: string;
  contentMarkdown?: string;
  notebookId?: string;
  isFavorite?: boolean;
  deleted?: boolean;
  tags?: string[];
  removeTags?: string[];
  replaceTags?: string[];
  includeContent?: boolean;
};

async function updateNoteRoute(options: ServerOptions, user: UserRow, input: NoteUpdateInput) {
  let contentMarkdown = input.contentMarkdown;
  let version = input.version;
  let currentNote: Record<string, unknown> | undefined = input.currentNote;
  if (version === undefined || input.replaceTags !== undefined || input.tags?.length || input.removeTags?.length) {
    if (!currentNote) {
      const current = await notesRoute(options, user, "GET", ["notes", input.noteId], `/api/notes/${encodeURIComponent(input.noteId)}`);
      if (current.status !== 200) return current;
      const note = current.body.note as Record<string, unknown> | undefined;
      if (!note) return { status: 500, body: { error: { code: "NOTE_READ_FAILED", message: "读取笔记失败" } } };
      currentNote = note;
    }
    if (version === undefined) {
      if (typeof currentNote.version !== "number") return { status: 500, body: { error: { code: "NOTE_READ_FAILED", message: "读取笔记版本失败" } } };
      version = currentNote.version;
    }
  }
  if (input.replaceTags !== undefined || input.tags?.length || input.removeTags?.length) {
    if (contentMarkdown === undefined) {
      if (typeof currentNote?.contentMarkdown !== "string") return { status: 500, body: { error: { code: "NOTE_READ_FAILED", message: "读取笔记正文失败" } } };
      contentMarkdown = currentNote.contentMarkdown;
    }
    const tagsToRemove = input.replaceTags === undefined
      ? input.removeTags ?? []
      : [...extractTags(contentMarkdown), ...(input.removeTags ?? [])];
    contentMarkdown = removeTagsFromMarkdown(contentMarkdown, tagsToRemove);
    contentMarkdown = appendMarkdownTags(contentMarkdown, input.replaceTags ?? input.tags ?? []);
  }
  if (version === undefined) return { status: 500, body: { error: { code: "NOTE_READ_FAILED", message: "读取笔记版本失败" } } };
  const payload = {
    version,
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(contentMarkdown === undefined ? {} : { contentMarkdown }),
    ...(input.notebookId === undefined ? {} : { notebookId: input.notebookId }),
    ...(input.isFavorite === undefined ? {} : { isFavorite: input.isFavorite }),
    ...(input.deleted === undefined ? {} : { deleted: input.deleted }),
  };
  const path = `/api/notes/${encodeURIComponent(input.noteId)}${input.includeContent ? "" : "?response=summary"}`;
  const result = await notesRoute(options, user, "PATCH", ["notes", input.noteId], path, payload);
  if (result.status !== 200 || contentMarkdown === undefined) return result;
  const note = result.body.note;
  if (!note || typeof note !== "object" || Array.isArray(note)) return result;
  return {
    ...result,
    body: {
      ...result.body,
      note: { ...(note as Record<string, unknown>), contentLength: countUnicodeCharacters(contentMarkdown) },
    },
  };
}

async function noteByTitle(options: ServerOptions, user: UserRow, requestedTitle: string, includeDeleted = false) {
  const title = requestedTitle.trim();
  const rows = findNotesByTitlePattern(options.database, user.id, title, includeDeleted);
  const normalizedTitle = title.normalize("NFKC").toLocaleLowerCase("zh-CN");
  const exactMatches = rows.filter((note) => note.title.normalize("NFKC").toLocaleLowerCase("zh-CN") === normalizedTitle);
  const matches = exactMatches.length > 0 ? exactMatches : rows;
  if (matches.length === 0) {
    return { error: { code: "NOT_FOUND", target: "note", message: "找不到标题匹配的笔记" } };
  }
  // A full page of results means the real match count may be higher, so stay ambiguous.
  if (matches.length !== 1) {
    return {
      error: {
        code: "AMBIGUOUS_MATCH",
        target: "title",
        message: "标题匹配到多篇笔记，请使用 noteId 指定目标",
        matchCount: matches.length,
        matches: matches.slice(0, 5).map((note) => ({
          id: note.id,
          title: note.title,
          notebookName: note.notebook_name,
          version: note.version,
          preview: formatPreview(note.content_markdown),
          createdAt: note.created_at,
          updatedAt: note.updated_at,
        })),
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
    description: "列出笔记本的 ID、名称、数量和可读的 updatedAtISO 时间。count 只统计未删除笔记；totalCount 包括回收站笔记，删除笔记本二次确认时应使用 totalCount。",
    inputSchema: z.object({}).strict(),
  }, async () => {
    if (!user) return responseValue({ error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } }, true);
    const result = await notebooksRoute(options, user);
    return result.status === 200 ? responseValue(result.body) : routeError(result);
  });

  server.registerTool("create_notebook", {
    title: "创建笔记本",
    description: "创建一个用于分类笔记的新笔记本。返回新笔记本的 ID、名称、图标和颜色；省略颜色或图标时使用默认值。重名会返回 NOTEBOOK_EXISTS。",
    inputSchema: z.object({
      name: z.string().trim().min(1).max(40).describe("笔记本名称，最多 40 个字符"),
      color: z.string().optional().describe("六位十六进制颜色；格式无效时返回 INVALID_ARGUMENT，field=color。预设示例：#718077 松柏绿、#d96245 朱砂、#5b7899 蓝灰、#9c765f 木棕"),
      icon: z.enum(VALID_NOTEBOOK_ICONS).optional().describe("笔记本图标标识，例如 folder、book 或 bookmark"),
    }).strict(),
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

  server.registerTool("update_notebook", {
    title: "更新笔记本",
    description: "修改笔记本名称、图标或颜色；修改 name 即可重命名。笔记本中的笔记和内容保持不变。重名会返回 NOTEBOOK_EXISTS。",
    inputSchema: z.object({
      notebookId: z.string().min(1).max(200),
      name: z.string().trim().min(1).max(40).optional().describe("新名称，最多 40 个字符；用于重命名"),
      color: z.string().optional().describe("六位十六进制颜色；格式无效时返回 INVALID_ARGUMENT，field=color。预设示例：#718077 松柏绿、#d96245 朱砂、#5b7899 蓝灰、#9c765f 木棕"),
      icon: z.enum(VALID_NOTEBOOK_ICONS).optional().describe("笔记本图标标识，例如 folder、book 或 bookmark"),
    }).strict(),
  }, async ({ notebookId, name, color, icon }) => {
    if (!user) return responseValue({ error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } }, true);
    if (name === undefined && color === undefined && icon === undefined) {
      return responseValue({ error: { code: "EMPTY_UPDATE", message: "请至少提供一个要更新的字段" } }, true);
    }
    const payload = {
      ...(name === undefined ? {} : { name }),
      ...(color === undefined ? {} : { color }),
      ...(icon === undefined ? {} : { icon }),
    };
    const result = await notebooksRoute(options, user, "PATCH", payload, notebookId);
    return result.status === 200 ? responseValue(result.body) : routeError(result);
  });

  server.registerTool("delete_notebook", {
    title: "删除笔记本（笔记转入收件箱）",
    description: "永久删除指定笔记本，并将其中所有笔记（包括回收站中的笔记）移入收件箱；笔记本本身无法恢复，系统收件箱不能删除。这是不可逆的级联操作，必须先传 confirm=true；建议同时传 expectedNoteCount（取 list_notebooks 返回的 totalCount，包含回收站笔记）作为二次确认。校验在删除事务中执行；不一致时拒绝删除。返回 movedCount 表示被移动的笔记数；这些笔记的 version 已失效（versionsInvalidated=true），后续写入前需重新读取。",
    inputSchema: z.object({
      notebookId: z.string().min(1).max(200),
      confirm: z.literal(true).describe("确认删除该笔记本；操作不可逆"),
      expectedNoteCount: z.number().int().min(0).optional().describe("可选的预期笔记总数，来自 list_notebooks 的 totalCount（包括回收站）；不一致时拒绝删除"),
    }).strict(),
  }, async ({ notebookId, expectedNoteCount }) => {
    if (!user) return responseValue({ error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } }, true);
    const result = await notebooksRoute(options, user, "DELETE", expectedNoteCount === undefined ? undefined : { expectedNoteCount }, notebookId);
    return result.status === 200 ? responseValue(result.body) : routeError(result);
  });

  server.registerTool("search_notes", {
    title: "搜索笔记",
    description: "按标题或正文搜索笔记，可用 tag 精确筛选正文标签，并配合 nextCursor 分页取回该标签下全部匹配笔记。省略 query 可列出最近更新的笔记；默认每页 20 篇，preview 默认最多 120 个 Unicode 字符；摘要保留换行、孤立下划线及标识符和 URL 中的下划线，过滤纯标签行。结果含可读的 updatedAtISO，不含正文、图片或缩略图。",
    inputSchema: z.object({
      query: z.string().max(80).optional().describe("搜索词；省略或留空时列出最近笔记"),
      tag: z.string().trim().min(1).max(NOTE_TAG_MAX_LENGTH).optional().describe("按正文中的标签精确筛选，可带或不带 #；仅支持中文、字母、数字、下划线或连字符，格式由服务端校验"),
      notebookId: z.string().min(1).max(200).optional().describe("仅搜索指定笔记本"),
      view: z.enum(NOTE_VIEWS).optional().describe("笔记视图，默认 all；trash 搜索回收站"),
      cursor: z.string().max(2048).optional().describe("上一次搜索结果返回的 nextCursor"),
      limit: z.number().int().min(1).max(100).optional().describe("每页数量，默认 20，最大 100"),
      previewLength: z.number().int().min(0).max(NOTE_PREVIEW_LIMIT).optional().describe(`每篇笔记的摘要长度，默认 120，最大 ${NOTE_PREVIEW_LIMIT} 个 Unicode 字符`),
    }).strict(),
  }, async ({ query, tag, notebookId, view, cursor, limit = 20, previewLength = 120 }) => {
    if (!user) return responseValue({ error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } }, true);
    const url = new URL("/api/notes", "http://xiangying-notes.internal");
    if (query) url.searchParams.set("query", query);
    if (tag) url.searchParams.set("tag", tag.startsWith("#") ? tag.slice(1) : tag);
    if (notebookId) url.searchParams.set("notebookId", notebookId);
    if (view) url.searchParams.set("view", view);
    if (cursor) url.searchParams.set("cursor", cursor);
    url.searchParams.set("limit", String(limit));
    const result = await notesRoute(options, user, "GET", ["notes"], `${url.pathname}${url.search}`);
    if (result.status !== 200) return routeError(result);
    const notes = Array.isArray(result.body.notes) ? result.body.notes as Record<string, unknown>[] : [];
    return responseValue({ ...result.body, notes: withPreviewLimit(notes, previewLength) });
  });

  server.registerTool("list_trash", {
    title: "列出回收站",
    description: "分页列出回收站笔记，可用 query 在回收站内按标题或正文搜索。返回的 noteId 与 version 可用于 note_operation action=restore；结果含可读的 updatedAtISO。preview 保留换行、孤立下划线及标识符和 URL 中的下划线，过滤纯标签行。每页默认 20 篇，摘要默认最多 120 个 Unicode 字符。",
    inputSchema: z.object({
      query: z.string().max(80).optional().describe("在回收站内搜索的关键词；省略时列出全部回收站笔记"),
      cursor: z.string().max(2048).optional().describe("上一页返回的 nextCursor"),
      limit: z.number().int().min(1).max(100).optional().describe("每页数量，默认 20，最大 100"),
      previewLength: z.number().int().min(0).max(NOTE_PREVIEW_LIMIT).optional().describe(`每篇笔记的摘要长度，默认 120，最大 ${NOTE_PREVIEW_LIMIT} 个 Unicode 字符`),
    }).strict(),
  }, async ({ query, cursor, limit = 20, previewLength = 120 }) => {
    if (!user) return responseValue({ error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } }, true);
    const url = new URL("/api/notes", "http://xiangying-notes.internal");
    url.searchParams.set("view", "trash");
    if (query) url.searchParams.set("query", query);
    if (cursor) url.searchParams.set("cursor", cursor);
    url.searchParams.set("limit", String(limit));
    const result = await notesRoute(options, user, "GET", ["notes"], `${url.pathname}${url.search}`);
    if (result.status !== 200) return routeError(result);
    const notes = Array.isArray(result.body.notes) ? result.body.notes as Record<string, unknown>[] : [];
    return responseValue({ ...result.body, notes: withPreviewLimit(notes, previewLength) });
  });

  server.registerTool("get_note", {
    title: "读取笔记",
    description: "按 noteId 读取，或按 title 查找笔记。标题查找会先裁剪 title 参数的首尾空白；精确匹配和子串匹配均忽略 ASCII 字母大小写。因此仅改变查询 title 的大小写或首尾空白，不能用于区分笔记。先优先采用精确标题匹配：若恰有一篇精确匹配，即使另有更长标题包含该字符串，也直接返回精确匹配的笔记；若多篇标题仅大小写不同，会一起作为精确匹配候选返回。若没有精确匹配，再按标题子串匹配；最终匹配多篇时返回候选（含 preview、version、createdAtISO、updatedAtISO），可据此消歧；最多列出 5 篇，truncated=true 表示候选未列全，matchCount 最多报告 6、可能只是总数下限。默认标题查找只搜索未删除的笔记；includeDeleted=true 时也会匹配回收站中的笔记。includeDeleted 仅影响标题查找，按 noteId 可直接读取回收站笔记。结果含可读的 updatedAtISO；保留 Markdown 图片引用，但不提供图片内容或缩略图。只需要 version 时可传 includeContent=false 以省去正文；search_notes 与 list_trash 的返回结果本身也带 version，不必为此读取全文。",
    inputSchema: z.object({
      noteId: z.string().min(1).max(200).optional(),
      title: z.string().trim().min(1).max(200).optional(),
      includeDeleted: z.boolean().optional().describe("仅按 title 查找时是否包含回收站笔记，默认 false；按 noteId 读取回收站笔记不需要此参数"),
      includeContent: z.boolean().optional().describe("是否回传完整正文，默认 true；只想拿 version 时传 false"),
    }).strict(),
  }, async ({ noteId, title, includeDeleted = false, includeContent = true }) => {
    if (!user) return responseValue({ error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } }, true);
    if (Boolean(noteId) === Boolean(title)) {
      return responseValue({ error: { code: "INVALID_NOTE_SELECTOR", message: "请且仅提供 noteId 或 title 其中一个" } }, true);
    }
    if (title !== undefined) {
      const match = await noteByTitle(options, user, title, includeDeleted);
      if ("error" in match) return responseValue(match, true);
      noteId = match.noteId;
    }
    const result = await notesRoute(options, user, "GET", ["notes", noteId as string], `/api/notes/${encodeURIComponent(noteId as string)}`);
    if (result.status !== 200) return routeError(result);
    const body = includeContent ? withoutNotePreview(result.body) : result.body;
    if (includeContent) return responseValue(body);
    const note = body.note && typeof body.note === "object" && !Array.isArray(body.note) ? body.note as Record<string, unknown> : undefined;
    return responseValue({ ...body, ...(note ? { note: conciseWriteNote(note) } : {}) });
  });

  server.registerTool("get_notes_batch", {
    title: "批量读取笔记",
    description: "按 ID 一次读取多篇完整 Markdown 笔记，不重复返回 preview。最多输入 50 个 ID；limit 默认取 min(noteIds.length, 50)、最大 50，限制成功返回的笔记数；不存在或因预算跳过的笔记不占 limit，工具会继续检查后续 ID 以填满结果。正文总 Unicode 字符预算 maxTotalCharacters 默认 20,000、最大 100,000。各篇在本次调用期间分别读取，不构成同一时刻的一致快照，也可能看不到并行或之后完成的写入；需要最新状态时再次读取，写入仍应使用最新 version 并处理 VERSION_CONFLICT。单篇正文放不进剩余预算时，该 ID 会列入 oversizedIds 和 remainingIds，工具仍会继续读取后续 ID；超过本次总预算的长笔记可改用 get_note 单篇读取。checkedCount 表示已查询存在性的 ID 数，uncheckedCount 表示尚未查询存在性的 ID 数。只有已检查且不存在的 ID 才列入 notFoundIds。skippedForCharacterLimit 表示至少有一篇因预算被跳过。",
    inputSchema: z.object({
      noteIds: z.array(z.string().min(1).max(200)).min(1).max(50).describe("要读取的笔记 ID，最多 50 个且不能重复"),
      limit: z.number().int().min(1).max(50).optional().describe("本次最多返回的笔记数；省略时取 min(noteIds.length, 50)，最大 50"),
      maxTotalCharacters: z.number().int().min(1).max(100_000).optional().describe("正文总 Unicode 字符预算，默认 20,000，最大 100,000"),
    }).strict(),
  }, async ({ noteIds, limit, maxTotalCharacters = 20_000 }) => {
    // Passing 50 ids should return 50 notes by default instead of silently deferring 30.
    const effectiveLimit = limit ?? Math.min(noteIds.length, 50);
    if (!user) return responseValue({ error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } }, true);
    if (new Set(noteIds).size !== noteIds.length) {
      return responseValue({ error: { code: "DUPLICATE_NOTE_ID", message: "noteIds 中不能重复出现同一篇笔记" } }, true);
    }
    const notes: Record<string, unknown>[] = [];
    const notFoundIds: string[] = [];
    const oversizedIds: string[] = [];
    let checkedCount = 0;
    let totalContentCharacters = 0;
    for (let index = 0; index < noteIds.length && notes.length < effectiveLimit; index += 1) {
      const noteId = noteIds[index];
      const result = await notesRoute(options, user, "GET", ["notes", noteId], `/api/notes/${encodeURIComponent(noteId)}`);
      checkedCount += 1;
      if (result.status === 404) {
        notFoundIds.push(noteId);
        continue;
      }
      if (result.status !== 200) return routeError(result);
      const note = result.body.note;
      if (!note || typeof note !== "object" || Array.isArray(note)) {
        return responseValue({ error: { code: "NOTE_READ_FAILED", message: "读取笔记失败" } }, true);
      }
      const fullNote = note as Record<string, unknown>;
      if (typeof fullNote.contentMarkdown !== "string") {
        return responseValue({ error: { code: "NOTE_READ_FAILED", message: "读取笔记正文失败" } }, true);
      }
      const contentCharacters = countUnicodeCharacters(fullNote.contentMarkdown);
      if (totalContentCharacters + contentCharacters > maxTotalCharacters) {
        oversizedIds.push(noteId);
        continue;
      }
      const withoutPreview = { ...fullNote };
      delete withoutPreview.preview;
      notes.push(withoutPreview);
      totalContentCharacters += contentCharacters;
    }
    const oversized = new Set(oversizedIds);
    const remainingIds = noteIds.filter((noteId, index) => oversized.has(noteId) || index >= checkedCount);
    return responseValue({ notes, notFoundIds, oversizedIds, remainingIds, checkedCount, uncheckedCount: noteIds.length - checkedCount, returnedCount: notes.length, totalContentCharacters, maxTotalCharacters, skippedForCharacterLimit: oversizedIds.length > 0 });
  });

  server.registerTool("create_note", {
    title: "创建笔记",
    description: "创建一篇 Markdown 笔记。MCP 不提供图片上传；正文可引用 HTTPS 图片地址或当前用户可用于该笔记的已上传附件，无效或不可用的引用会返回 INVALID_ASSET。contentMarkdown 可直接传入完整正文，普通笔记应优先在本次 create_note 一次写入完整内容；多行 Markdown 会原样保留。只有客户端明确无法承载单次参数或服务端返回 MCP 请求体超过 4.5 MB 的错误时，才先创建骨架并用 append_to_note 分段追加，沿用每次返回的 version；单篇正文总上限为 1,000,000 个 UTF-16 code units。若手写原始 JSON，其中的换行、制表符等控制字符必须转义。tags 会以 #标签 形式追加到正文；每个正文标签最多 40 个 UTF-16 code units，代码中的标签和超长标签不会被索引；字面井号词可写作 \\#CSharp 以避免成为标签。省略 notebookId 时放入收件箱。默认不回传正文；需要时设 includeContent=true。成功结果包含按 Unicode code point 统计的 contentLength 回执。",
    inputSchema: z.object({
      title: z.string().min(1).max(200),
      contentMarkdown: z.string().max(NOTE_CONTENT_MAX_LENGTH).optional().describe("可直接传入完整 Markdown 正文；普通笔记优先一次创建；只有客户端明确无法承载单次参数或服务端返回 MCP 请求体超过 4.5 MB 的错误时才分段；最多 1,000,000 个 UTF-16 code units"),
      notebookId: z.string().min(1).max(200).optional(),
      tags: noteTagsSchema.optional().describe("要追加到正文的标签名，仅可含中文、字母、数字、下划线或连字符，不带 #；仅追加，不会覆盖已有标签（整体替换请用 note_operation action=set_tags）"),
      includeContent: z.boolean().optional().describe("是否在成功结果中回传完整正文，默认 false"),
    }).strict(),
  }, async ({ title, contentMarkdown = "", notebookId, tags = [], includeContent = false }) => {
    if (!user) return responseValue({ error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } }, true);
    if (!validMcpTags(tags)) return invalidMcpTagsError(tags);
    const payload = {
      title,
      contentMarkdown: appendMarkdownTags(contentMarkdown, tags),
      ...(notebookId === undefined ? {} : { notebookId }),
    };
    const result = await notesRoute(options, user, "POST", ["notes"], "/api/notes", payload);
    return result.status === 201 ? responseValue(result.body, false, { writeResult: true, includeContent }) : noteWriteError(result);
  });

  server.registerTool("update_note", {
    title: "更新笔记",
    description: "仅用于更新未删除笔记的标题或完整 Markdown 正文；MCP 不提供图片上传，正文中的图片引用必须是 HTTPS 地址或当前用户可用于该笔记的已上传附件，否则返回 INVALID_ASSET。回收站笔记只读，会返回 NOTE_IN_TRASH，请先用 note_operation action=restore 恢复。移动、收藏、标签和回收站操作统一用 note_operation。version 可省略，由服务端读取当前版本并以乐观锁保存；传入时会校验，VERSION_CONFLICT 的 error.current 含最新完整笔记，可直接合并后重试。完整正文可直接一次传入；局部改字优先用 replace_in_note。只有客户端明确无法承载单次参数或服务端返回 MCP 请求体超过 4.5 MB 的错误时，才将新增内容分段交给 append_to_note。正文最多 1,000,000 个 UTF-16 code units（JavaScript string.length）；结构化参数直接传入多行 Markdown，手写原始 JSON 时换行、制表符须转义。正文写入结果含按 Unicode code point 统计的 contentLength；默认不回传正文，设 includeContent=true 可返回。",
    inputSchema: z.object({
      noteId: z.string().min(1).max(200),
      version: z.number().int().positive().optional().describe("可选的预期版本；省略时由服务端读取当前版本，仍使用乐观锁保存"),
      title: z.string().max(200).optional(),
      contentMarkdown: z.string().max(NOTE_CONTENT_MAX_LENGTH).optional().describe("完整替换 Markdown 正文；最多 1,000,000 个 UTF-16 code units（JavaScript string.length）"),
      includeContent: z.boolean().optional().describe("是否在成功结果中回传完整正文，默认 false"),
    }).strict(),
  }, async ({ noteId, version, title, contentMarkdown, includeContent = false }) => {
    if (!user) return responseValue({ error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } }, true);
    if (title === undefined && contentMarkdown === undefined) {
      return responseValue({ error: { code: "EMPTY_UPDATE", message: "请至少提供一个要更新的字段" } }, true);
    }
    const result = await updateNoteRoute(options, user, { noteId, version, title, contentMarkdown, includeContent });
    return result.status === 200
      ? responseValue(result.body, false, { writeResult: true, includeContent, ...(contentMarkdown === undefined ? {} : { contentLength: countUnicodeCharacters(contentMarkdown) }) })
      : noteWriteError(result);
  });

  server.registerTool("replace_in_note", {
    title: "替换笔记片段",
    description: "仅修改未删除笔记；MCP 不提供图片上传，正文中的图片引用必须是 HTTPS 地址或当前用户可用于该笔记的已上传附件，否则返回 INVALID_ASSET。回收站笔记只读，会返回 NOTE_IN_TRASH，请先用 note_operation action=restore 恢复。在正文中替换 oldText，不需要把全文传给模型。默认只接受唯一匹配；多处匹配时可设 replaceAll=true 一次替换全部非重叠匹配（返回 replacedCount），或传 occurrence（从 1 开始）指定其中一处；replaceAll 与 occurrence 不能同时使用。歧义时返回 matchCount 和最多 10 条前后各 30 字上下文。服务端读取当前正文和 version 后以乐观锁保存；可选传 version 校验你手中的版本。force=true 会忽略传入的旧 version 并把替换应用到刚读取的最新正文，但保存仍受乐观锁保护。可用 includeContent=true 在成功结果中回传正文，默认 false。",
    inputSchema: z.object({
      noteId: z.string().min(1).max(200),
      oldText: z.string().min(1).max(NOTE_CONTENT_MAX_LENGTH).describe("正文中要查找的精确文本"),
      newText: z.string().max(NOTE_CONTENT_MAX_LENGTH).describe("替换后的文本；支持多行 Markdown"),
      replaceAll: z.boolean().optional().describe("设为 true 时替换所有非重叠匹配，不能与 occurrence 同时使用"),
      occurrence: z.number().int().min(1).optional().describe("可选的匹配序号，从 1 开始；不传时要求 oldText 只出现一次"),
      version: z.number().int().positive().optional().describe("可选的预期版本；传入时默认必须与当前版本一致"),
      force: z.boolean().optional().describe("显式设为 true 时忽略调用方传入的旧 version，并基于服务端刚读取的正文重试替换"),
      includeContent: z.boolean().optional().describe("是否在成功结果中回传完整正文，默认 false"),
    }).strict(),
  }, async ({ noteId, oldText, newText, replaceAll = false, occurrence, version, force = false, includeContent = false }) => {
    try {
      if (!user) return responseValue({ error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } }, true);
      if (replaceAll && occurrence !== undefined) {
        return responseValue({ error: { code: "INVALID_REPLACEMENT_SELECTOR", message: "replaceAll=true 与 occurrence 不能同时使用，请只选择一种替换方式" } }, true);
      }
      const current = await notesRoute(options, user, "GET", ["notes", noteId], `/api/notes/${encodeURIComponent(noteId)}`);
      if (current.status !== 200) return routeError(current);
      const note = current.body.note as Record<string, unknown> | undefined;
      if (typeof note?.contentMarkdown !== "string" || typeof note.version !== "number") {
        return responseValue({ error: { code: "NOTE_READ_FAILED", message: "读取笔记正文或版本失败" } }, true);
      }
      if (version !== undefined && version !== note.version && !force) {
        return responseValue({
          error: {
            code: "VERSION_CONFLICT",
            message: "这篇笔记已在别处更新；请基于 error.current 合并后重试，或显式设置 force=true 将替换应用到最新正文",
            current: note,
          },
        }, true);
      }
      if (isDeletedNote(note)) return noteInTrashError();
      const body = note.contentMarkdown;
      const search = findTextMatches(body, oldText, { occurrence: replaceAll ? undefined : occurrence });
      if (search.matchCount === 0) return responseValue({ error: { code: "NOT_FOUND", target: "text", message: "正文中找不到 oldText，笔记未修改" } }, true);
      if (occurrence !== undefined && search.selectedOffset === null) {
        return responseValue({ error: { code: "NOT_FOUND", target: "occurrence", message: `occurrence=${occurrence} 超出匹配数量 ${search.matchCount}，笔记未修改`, matchCount: search.matchCount, matches: search.matches, truncated: search.truncated } }, true);
      }
      if (!replaceAll && occurrence === undefined && search.matchCount > 1) {
        return responseValue({
          error: {
            code: "AMBIGUOUS_MATCH",
            target: "text",
            message: `oldText 在正文中出现 ${search.matchCount} 次；请提供更长的片段、设置 occurrence 指定目标，或设 replaceAll=true 替换全部。`,
            matchCount: search.matchCount,
            matches: search.matches,
            truncated: search.truncated,
          },
        }, true);
      }
      const replacedCount = replaceAll ? search.matchCount : 1;
      const resultingCharacters = countUnicodeCharacters(body)
        + replacedCount * (countUnicodeCharacters(newText) - countUnicodeCharacters(oldText));
      if (resultingCharacters > NOTE_CONTENT_MAX_LENGTH) {
        return responseValue({ error: { code: "NOTE_TOO_LARGE", message: `替换后正文将超过 ${NOTE_CONTENT_MAX_LENGTH.toLocaleString("en-US")} 个 Unicode 字符，笔记未修改` } }, true);
      }
      const firstMatch = occurrence === undefined ? search.matches[0].offset : search.selectedOffset!;
      const updatedBody = replaceAll
        ? body.replaceAll(oldText, newText)
        : `${body.slice(0, firstMatch)}${newText}${body.slice(firstMatch + oldText.length)}`;
      const result = await updateNoteRoute(options, user, { noteId, version: note.version, contentMarkdown: updatedBody, includeContent });
      return result.status === 200
        ? responseValue({ ...result.body, replacedCount }, false, { writeResult: true, includeContent, contentLength: resultingCharacters })
        : noteWriteError(result);
    } catch (error) {
      console.error("[MCP] replace_in_note failed", error);
      return responseValue({ error: { code: "MCP_INTERNAL_ERROR", message: "片段替换遇到内部错误；请读取笔记确认当前内容后再决定是否重试。" } }, true);
    }
  });

  server.registerTool("note_operation", {
    title: "笔记管理操作",
    description: "低频笔记管理入口，每次通过 action 执行一项操作：move 移动到笔记本；set_favorite 设定目标收藏状态；set_tags 管理标签（必须显式传 mode=replace/add/remove，避免遗漏时意外覆盖）；trash 软删除到回收站；restore 恢复。幂等操作若未改变状态会返回 noop=true。各 action 只接受对应字段。version 可直接从 search_notes 或 list_trash 结果获取；也可省略，由服务端读取当前版本并继续使用乐观锁。回收站笔记只读，恢复前不能移动、改标签或改收藏。此工具不提供永久删除。",
    inputSchema: noteOperationInputSchema,
  }, async (input) => {
    if (!user) return responseValue({ error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } }, true);
    const parsedInput = noteOperationActionSchema.safeParse(input);
    if (!parsedInput.success) {
      return responseValue({
        error: {
          code: "INVALID_NOTE_OPERATION",
          message: noteOperationValidationMessage(input, parsedInput.error.issues),
        },
      }, true);
    }
    const operation = parsedInput.data;
    let currentNote: Record<string, unknown> | undefined;
    let version = operation.version;
    if (version === undefined) {
      const current = await notesRoute(options, user, "GET", ["notes", operation.noteId], `/api/notes/${encodeURIComponent(operation.noteId)}`);
      if (current.status !== 200) return routeError(current);
      if (!current.body.note || typeof current.body.note !== "object" || Array.isArray(current.body.note)) {
        return responseValue({ error: { code: "NOTE_READ_FAILED", message: "读取笔记版本失败" } }, true);
      }
      currentNote = current.body.note as Record<string, unknown>;
      if (typeof currentNote.version !== "number") return responseValue({ error: { code: "NOTE_READ_FAILED", message: "读取笔记版本失败" } }, true);
      version = currentNote.version;
    }
    if (operation.action === "move") {
      const result = await updateNoteRoute(options, user, { noteId: operation.noteId, version, currentNote, notebookId: operation.notebookId });
      if (result.status !== 200) return routeError(result);
      const note = result.body.note as Record<string, unknown> | undefined;
      return responseValue({ ...result.body, ...(note?.version === version ? { noop: true } : {}) }, false, { writeResult: true });
    }
    if (operation.action === "set_favorite") {
      const result = await updateNoteRoute(options, user, { noteId: operation.noteId, version, currentNote, isFavorite: operation.isFavorite });
      if (result.status !== 200) return routeError(result);
      const note = result.body.note as Record<string, unknown> | undefined;
      return responseValue({ ...result.body, ...(note?.version === version ? { noop: true } : {}) }, false, { writeResult: true });
    }
    if (operation.action === "set_tags") {
      if (!validMcpTags(operation.tags)) return invalidMcpTagsError(operation.tags);
      const tagInput = operation.mode === "add"
        ? { tags: operation.tags }
        : operation.mode === "remove"
          ? { removeTags: operation.tags }
          : { replaceTags: operation.tags };
      const result = await updateNoteRoute(options, user, { noteId: operation.noteId, version, currentNote, ...tagInput });
      if (result.status !== 200) return routeError(result);
      const note = result.body.note as Record<string, unknown> | undefined;
      return responseValue({ ...result.body, mode: operation.mode, ...(note?.version === version ? { noop: true } : {}) }, false, { writeResult: true });
    }
    if (operation.action === "trash") {
      const result = await updateNoteRoute(options, user, { noteId: operation.noteId, version, currentNote, deleted: true });
      if (result.status !== 200) return routeError(result);
      const note = result.body.note as Record<string, unknown> | undefined;
      const noop = note !== undefined && isDeletedNote(note) && note.version === version;
      return responseValue({ ...result.body, ...(noop ? { noop: true } : {}) }, false, { writeResult: true });
    }
    const result = await updateNoteRoute(options, user, { noteId: operation.noteId, version, currentNote, deleted: false });
    if (result.status !== 200) return routeError(result);
    const note = result.body.note as Record<string, unknown> | undefined;
    const noop = note?.deletedAt === null && note.version === version;
    return responseValue({ ...result.body, ...(noop ? { noop: true } : {}) }, false, { writeResult: true });
  });

  server.registerTool("append_to_note", {
    title: "追加到笔记",
    description: "仅修改未删除笔记；MCP 不提供图片上传，正文中的图片引用必须是 HTTPS 地址或当前用户可用于该笔记的已上传附件，否则返回 INVALID_ASSET。回收站笔记只读，会返回 NOTE_IN_TRASH，请先用 note_operation action=restore 恢复。将 contentMarkdown 追加到现有正文，避免重新发送长正文。普通追加按一个请求完成；只有客户端明确无法承载单次参数或服务端返回 MCP 请求体超过 4.5 MB 的错误时才分段，所有分段合计仍受单篇正文 1,000,000 个 UTF-16 code units 的总上限约束。沿用上一次写入返回的 version，或省略 version 让服务端读取最新正文并执行乐观锁保存。传入 version 时仍会校验版本。末尾若有独立标签行，会把新内容插到标签行之前并保留标签；否则按原样追加。遇 VERSION_CONFLICT 时 error.current 含完整当前笔记。需要换行时请在追加文本中包含换行。多行正文通过结构化参数直接传入；手写原始 JSON 时控制字符必须转义。默认不回传正文，结果含 contentLength 回执。",
    inputSchema: z.object({
      noteId: z.string().min(1).max(200),
      version: z.number().int().positive().optional().describe("可选的预期版本；省略时服务端读取当前版本"),
      contentMarkdown: z.string().min(1).max(NOTE_CONTENT_MAX_LENGTH).describe("要追加的一段 Markdown；正常情况下可一次追加完整新增内容，仅按客户端参数能力或 MCP 请求体上限分段"),
      includeContent: z.boolean().optional().describe("是否在成功结果中回传完整正文，默认 false"),
    }).strict(),
  }, async ({ noteId, version, contentMarkdown, includeContent = false }) => {
    if (!user) return responseValue({ error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } }, true);
    const current = await notesRoute(options, user, "GET", ["notes", noteId], `/api/notes/${encodeURIComponent(noteId)}`);
    if (current.status !== 200) return routeError(current);
    const note = current.body.note as Record<string, unknown> | undefined;
    if (typeof note?.contentMarkdown !== "string" || typeof note.version !== "number") return responseValue({ error: { code: "NOTE_READ_FAILED", message: "读取笔记正文或版本失败" } }, true);
    if (version !== undefined && version !== note.version) {
      return responseValue({ error: { code: "VERSION_CONFLICT", message: "这篇笔记已在别处更新", current: note } }, true);
    }
    if (isDeletedNote(note)) return noteInTrashError();
    const updatedBody = appendToMarkdown(note.contentMarkdown, contentMarkdown);
    const result = await updateNoteRoute(options, user, {
      noteId,
      version: version ?? note.version,
      contentMarkdown: updatedBody,
      includeContent,
    });
    return result.status === 200
      ? responseValue(result.body, false, { writeResult: true, includeContent, contentLength: countUnicodeCharacters(updatedBody) })
      : noteWriteError(result);
  });

  server.registerTool("insert_into_note", {
    title: "按锚点插入正文",
    description: "仅修改未删除笔记；MCP 不提供图片上传，正文中的图片引用必须是 HTTPS 地址或当前用户可用于该笔记的已上传附件，否则返回 INVALID_ASSET。回收站笔记只读，会返回 NOTE_IN_TRASH，请先用 note_operation action=restore 恢复。在正文中匹配的 anchor 前或后插入 Markdown，不必重传整篇笔记；contentMarkdown 可传入完整插入内容，单篇正文仍受 1,000,000 个 UTF-16 code units 上限约束。默认要求 anchor 唯一；歧义时返回 matchCount 和最多 10 条前后各 30 字上下文，可传 occurrence（从 1 开始）指定一处，或设 insertAll=true 在所有非重叠匹配处插入（返回 insertedCount）；insertAll 与 occurrence 不能同时使用。插入点位于行首或行尾时会自动补换行，行内锚点保持精确拼接。version 可省略以使用服务端读取的当前版本；传入时会校验，冲突时 error.current 含完整当前笔记。默认插入到锚点后；成功结果含 contentLength 回执。",
    inputSchema: z.object({
      noteId: z.string().min(1).max(200),
      version: z.number().int().positive().optional().describe("可选的预期版本；省略时服务端读取当前版本"),
      anchor: z.string().min(1).max(2000).describe("正文中精确的原文片段"),
      contentMarkdown: z.string().min(1).max(NOTE_CONTENT_MAX_LENGTH).describe("要在锚点前或后插入的 Markdown 内容"),
      insertAll: z.boolean().optional().describe("设为 true 时在所有非重叠 anchor 匹配处插入，不能与 occurrence 同时使用"),
      occurrence: z.number().int().min(1).optional().describe("可选的匹配序号，从 1 开始；不传时要求 anchor 只出现一次"),
      position: z.enum(["before", "after"]).optional().describe("插入位置，默认 after"),
      includeContent: z.boolean().optional().describe("是否在成功结果中回传完整正文，默认 false"),
    }).strict(),
  }, async ({ noteId, version, anchor, contentMarkdown, insertAll = false, occurrence, position = "after", includeContent = false }) => {
    if (!user) return responseValue({ error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } }, true);
    if (insertAll && occurrence !== undefined) {
      return responseValue({ error: { code: "INVALID_INSERTION_SELECTOR", message: "insertAll=true 与 occurrence 不能同时使用，请只选择一种插入方式" } }, true);
    }
    const current = await notesRoute(options, user, "GET", ["notes", noteId], `/api/notes/${encodeURIComponent(noteId)}`);
    if (current.status !== 200) return routeError(current);
    const note = current.body.note as Record<string, unknown> | undefined;
    if (typeof note?.contentMarkdown !== "string" || typeof note.version !== "number") return responseValue({ error: { code: "NOTE_READ_FAILED", message: "读取笔记正文或版本失败" } }, true);
    if (version !== undefined && note.version !== version) {
      return responseValue({
        error: {
          code: "VERSION_CONFLICT",
          message: "这篇笔记已在别处更新",
          current: note,
        },
      }, true);
    }
    if (isDeletedNote(note)) return noteInTrashError();
    const body = note.contentMarkdown;
    // Matches are counted non-overlapping, exactly like replace_in_note, so both tools
    // report the same matchCount for the same text.
    const search = findTextMatches(body, anchor, { occurrence: insertAll ? undefined : occurrence });
    if (search.matchCount === 0) return responseValue({ error: { code: "NOT_FOUND", target: "anchor", message: "正文中找不到指定 anchor" } }, true);
    if (occurrence !== undefined && search.selectedOffset === null) {
      return responseValue({ error: { code: "NOT_FOUND", target: "occurrence", message: `occurrence=${occurrence} 超出匹配数量 ${search.matchCount}，笔记未修改`, matchCount: search.matchCount, matches: search.matches, truncated: search.truncated } }, true);
    }
    if (!insertAll && occurrence === undefined && search.matchCount > 1) {
      return responseValue({
        error: {
          code: "AMBIGUOUS_MATCH",
          target: "anchor",
          message: `anchor 在正文中出现 ${search.matchCount} 次；请提供更长的片段、设置 occurrence 指定目标，或设 insertAll=true 在全部匹配处插入。`,
          matchCount: search.matchCount,
          matches: search.matches,
          truncated: search.truncated,
        },
      }, true);
    }
    const firstMatch = occurrence === undefined ? search.matches[0].offset : search.selectedOffset!;
    const insertionPoint = position === "before" ? firstMatch : firstMatch + anchor.length;
    const lineEnding = body.includes("\r\n") ? "\r\n" : body.includes("\r") ? "\r" : "\n";
    const insertionAt = (point: number) => {
      let insertion = contentMarkdown;
      if (position === "before" && (point === 0 || body[point - 1] === "\n" || body[point - 1] === "\r") && !/(?:\r\n|\r|\n)$/u.test(insertion)) {
        insertion += lineEnding;
      }
      if (position === "after" && (point === body.length || body[point] === "\n" || body[point] === "\r") && !/^(?:\r\n|\r|\n)/u.test(insertion)) {
        insertion = `${lineEnding}${insertion}`;
      }
      return insertion;
    };
    let insertedCharacters = insertAll ? search.matchCount * countUnicodeCharacters(contentMarkdown) : 0;
    if (insertAll) {
      let searchFrom = 0;
      while (searchFrom <= body.length) {
        const offset = body.indexOf(anchor, searchFrom);
        if (offset === -1) break;
        const point = position === "before" ? offset : offset + anchor.length;
        insertedCharacters += countUnicodeCharacters(insertionAt(point)) - countUnicodeCharacters(contentMarkdown);
        searchFrom = offset + anchor.length;
      }
    } else {
      insertedCharacters = countUnicodeCharacters(insertionAt(insertionPoint));
    }
    const resultingCharacters = countUnicodeCharacters(body) + insertedCharacters;
    if (resultingCharacters > NOTE_CONTENT_MAX_LENGTH) {
      return responseValue({ error: { code: "NOTE_TOO_LARGE", message: `插入后正文将超过 ${NOTE_CONTENT_MAX_LENGTH.toLocaleString("en-US")} 个 Unicode 字符，笔记未修改` } }, true);
    }
    const updatedBody = insertAll
      ? body.replaceAll(anchor, (_match, offset: number) => {
        const insertion = insertionAt(position === "before" ? offset : offset + anchor.length);
        return position === "before" ? `${insertion}${anchor}` : `${anchor}${insertion}`;
      })
      : `${body.slice(0, insertionPoint)}${insertionAt(insertionPoint)}${body.slice(insertionPoint)}`;
    const result = await updateNoteRoute(options, user, { noteId, version: version ?? note.version, contentMarkdown: updatedBody, includeContent });
    return result.status === 200
      ? responseValue({ ...result.body, insertedCount: insertAll ? search.matchCount : 1 }, false, { writeResult: true, includeContent, contentLength: resultingCharacters })
      : noteWriteError(result);
  });

  server.registerTool("batch_update_notes", {
    title: "批量更新笔记",
    description: "批量移动笔记本、追加标签 tags、移除标签 removeTags、整体替换标签 replaceTags、设定收藏状态或移入/恢复回收站。replaceTags 与 tags/removeTags 互斥；空 replaceTags 可清空所有标签。回收站笔记只读；仅当本次只传 deleted:false 时可批量恢复，其他修改都会返回 NOTE_IN_TRASH，恢复后再进行其他编辑。isFavorite 是目标状态（true 收藏、false 取消收藏），重复设定不会反转；未实际改变笔记的成功项会标记 noop:true。返回 updatedCount 实际改动数、noopCount 未变化成功数与 failedCount 失败数；noop 也算成功。仅当同一批次同时有成功项和失败项时返回 partial:true；全部成功或全部失败时都省略该字段，失败项的原因见 results。把最多 50 篇笔记的 noteId 和 version 放入 notes，并传同一个 notebookId 即可批量移入该笔记本。每篇笔记都必须带上读取时的 version；逐条执行并返回每条结果，冲突不会覆盖。冲突 current 只返回有界摘要、版本、长度和元数据；需要合并正文时再用 get_note 或 get_notes_batch 读取失败笔记，避免批量重复回传长正文。失败项可单独重试。",
    inputSchema: z.object({
      notes: z.array(z.object({ noteId: z.string().min(1).max(200), version: z.number().int().positive() }).strict()).min(1).max(50),
      notebookId: z.string().min(1).max(200).optional(),
      isFavorite: z.boolean().optional().describe("设定收藏目标状态；true 收藏，false 取消收藏，重复传入不反转"),
      deleted: z.boolean().optional().describe("目标回收站状态；仅当 deleted=false 且没有其他修改时可恢复回收站笔记"),
      tags: noteTagsSchema.optional().describe("追加到每篇笔记正文的标签名，仅可含中文、字母、数字、下划线或连字符，不带 #；仅追加，不会覆盖已有标签"),
      removeTags: noteTagsSchema.optional().describe("从每篇笔记正文移除的标签名，仅可含中文、字母、数字、下划线或连字符，不带 #"),
      replaceTags: noteTagsSchema.optional().describe("整体替换每篇笔记的标签集合，仅可含中文、字母、数字、下划线或连字符，不带 #；空数组清空所有标签，不能与 tags/removeTags 同时使用"),
    }).strict(),
  }, async ({ notes, notebookId, isFavorite, deleted, tags, removeTags, replaceTags }) => {
    if (!user) return responseValue({ error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } }, true);
    if ([tags, removeTags, replaceTags].some((values) => values !== undefined && !validMcpTags(values))) {
      return invalidMcpTagsError([...(tags ?? []), ...(removeTags ?? []), ...(replaceTags ?? [])]);
    }
    if (replaceTags !== undefined && (tags !== undefined || removeTags !== undefined)) {
      return responseValue({ error: { code: "INCOMPATIBLE_TAG_OPERATIONS", message: "replaceTags 是整体替换操作，不能与追加 tags 或移除 removeTags 同次使用" } }, true);
    }
    if (notebookId === undefined && isFavorite === undefined && deleted === undefined && !tags?.length && !removeTags?.length && replaceTags === undefined) {
      return responseValue({ error: { code: "EMPTY_UPDATE", message: "请至少提供 notebookId、isFavorite、deleted、tags、removeTags 或 replaceTags 中的一项" } }, true);
    }
    if (new Set(notes.map((note) => note.noteId)).size !== notes.length) {
      return responseValue({ error: { code: "DUPLICATE_NOTE_ID", message: "批量更新中不能重复出现同一篇笔记" } }, true);
    }
    const results: Record<string, unknown>[] = [];
    for (const note of notes) {
      const result = await updateNoteRoute(options, user, { ...note, notebookId, isFavorite, deleted, tags, removeTags, replaceTags });
      if (result.status === 200) {
        const updatedNote = result.body.note as Record<string, unknown> | undefined;
        const noop = updatedNote !== undefined && updatedNote.version === note.version;
        results.push({ noteId: note.noteId, ok: true, note: conciseWriteNote(updatedNote), ...(noop ? { noop: true } : {}) });
      } else {
        const rawError = result.body.error && typeof result.body.error === "object"
          ? result.body.error as Record<string, unknown>
          : { code: "MCP_OPERATION_FAILED", message: "笔记更新失败" };
        const error = normalizeMcpError(rawError);
        results.push({
          noteId: note.noteId,
          ok: false,
          error: {
            code: error.code,
            message: error.message,
            ...(error.target === undefined ? {} : { target: error.target }),
            ...(error.legacyCode === undefined ? {} : { legacyCode: error.legacyCode }),
            ...(Object.prototype.hasOwnProperty.call(error, "current") ? { current: compactConflictNote(error.current) } : {}),
          },
        });
      }
    }
    const failedCount = results.filter((result) => result.ok === false).length;
    const noopCount = results.filter((result) => result.noop === true).length;
    const successfulCount = results.length - failedCount;
    const updatedCount = successfulCount - noopCount;
    // Keep successful no-ops distinct from mutations: a no-op still makes a
    // mixed-success batch recoverable without reporting the whole call as failed.
    const isError = failedCount > 0 && successfulCount === 0;
    return responseValue({
      results,
      updatedCount,
      noopCount,
      failedCount,
      ...(failedCount > 0 && successfulCount > 0 ? { partial: true } : {}),
    }, isError);
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

function pathToken(request: Request) {
  const pathname = new URL(request.url).pathname;
  const prefix = `${MCP_PATH}/`;
  if (!pathname.startsWith(prefix)) return null;
  const encodedToken = pathname.slice(prefix.length);
  if (!encodedToken || encodedToken.includes("/")) return null;
  try {
    return decodeURIComponent(encodedToken) || null;
  } catch {
    return null;
  }
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
  if (tooLarge) return { request, error: invalidMcpArguments(null, "MCP 请求体超过 4.5 MB 传输上限；请拆分本次参数或把新增正文分段调用 append_to_note。普通笔记在单次请求未超限时应优先直接创建；分段写入仍受单篇笔记正文总长度上限约束。") };
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
    const toolName = params?.name;
    const contentField = typeof toolName === "string" ? MCP_CONTENT_FIELDS.get(toolName) : undefined;
    const contentValue = argumentsValue && typeof argumentsValue === "object" && !Array.isArray(argumentsValue)
      ? (argumentsValue as Record<string, unknown>)[contentField ?? ""]
      : undefined;
    if (typeof contentValue === "string" && contentValue.length > NOTE_CONTENT_MAX_LENGTH) {
      const nextStep = "请缩短本次字段；替换或分段追加仍受单篇笔记正文总长度上限约束。";
      return {
        request,
        error: invalidMcpArguments(
          message.id,
          `${contentField} 超过单次字段 1,000,000 个 UTF-16 code units 上限；${nextStep}`,
        ),
      };
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

  const suppliedToken = pathToken(request);
  if (!suppliedToken || !constantTimeEqual(suppliedToken, expectedToken)) {
    return jsonError(401, "INVALID_MCP_TOKEN", "MCP URL 令牌无效或缺失");
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
