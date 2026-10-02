import { createMcpHandler, McpServer, type AuthInfo, type McpHttpHandler, type McpRequestContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  constantTimeEqual,
  first,
  all,
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
import { getNotebook, toNotebook, handleNotebooksRoute, VALID_NOTEBOOK_ICONS } from "./routes/notebooks";
import { handleNotesRoute } from "./routes/notes";
import { getMarkdownOutline, locateMarkdownSection } from "./mcp-sections";
import { extractTags, findTrailingTagFooterStart, normalizeTag, NOTE_TAG_MAX_LENGTH, removeTagsFromMarkdown } from "../shared/tags";

export const MCP_PATH = "/mcp";
const MATCH_CONTEXT_LENGTH = 30;
const MATCH_CONTEXT_LIMIT = 10;
const MCP_CONTENT_FIELDS = new Map([
  ["create_note", "contentMarkdown"],
  ["save_note", "contentMarkdown"],
  ["replace_note_section", "contentMarkdown"],
  ["update_note", "contentMarkdown"],
  ["append_to_note", "contentMarkdown"],
  ["insert_into_note", "contentMarkdown"],
  ["replace_in_note", "newText"],
]);
const MCP_SERVER_INSTRUCTIONS = [
  "完整机器数据仅在 structuredContent 中，content 只给简短说明；客户端必须透传 structuredContent。检查 ok 和 error.code，可恢复业务分支不标记为工具异常；批量结果另检查 partial 与逐项 results。",
  "象映笔记是跨会话 Markdown 记忆库，可搜索、读取、新建和增量修改笔记，也可管理笔记本、收藏、标签、回收站。",
  "工具参数必须是 JSON 对象。客户端会先校验参数；手写原始 JSON 时，字符串中的控制字符须按 JSON 规范转义（换行写作 \\n）；结构化参数中的多行 Markdown 会原样保留。",
  "字段值不合法时使用统一错误码 INVALID_ARGUMENT，并通过 field 指明字段；当前 field 取值为 name、color、icon、tags。标签错误还会在 invalidTags 中列出违规值。",
  "普通笔记应优先在 save_note 一次写入完整正文；其默认 create 在目标笔记本内防重名；create_note 仅在有意允许同名时使用；只有客户端明确无法承载单次参数，或服务端返回 MCP 请求体超过 4.5 MB 的错误时，才用 append_to_note 分段追加并将返回的 version 作为 expectedVersion。单篇正文硬上限为 1,000,000 个 UTF-16 code units。contentLength 回执与批量读取字符预算按 Unicode code points 计算。写操作默认不回传正文。",
  "分类可直接传 notebookName，notebookId 同时存在时优先；ensure_notebook 幂等创建，save_note 可一次创建笔记本并保存笔记；create_notebook 创建笔记本，update_notebook 修改，delete_notebook 需 confirm=true 并建议用 totalCount 做二次确认。局部编辑和仅改标题可省略 expectedVersion，由服务端读取当前版本并以乐观锁保存；所有写入的版本参数统一 expectedVersion，不接受 version/baseVersion 别名；全文覆盖必须提供 expectedVersion，save_note 的 upsert 更新已有笔记也必须提供 expectedVersion；batch_update_notes 必须提供每篇读取时的 expectedVersion。所有 VERSION_CONFLICT 的 current 只返回有界摘要、长度、版本与元数据，需要时用 get_note/get_note_section 读取正文。",
  "create_note.tags 与 batch_update_notes.tags 是追加；manage_note 的 set_tags 必须显式传 mode=replace、add 或 remove。正文中未转义、代码区外且不超过 40 个 UTF-16 code units 的 #标签会被索引；可在井号前加反斜杠保留字面井号。回收站笔记可恢复，但 MCP 不提供永久删除笔记或清空回收站。",
  "用 search_notes 的 view=trash 检索回收站。get_notes_batch 最多读 50 篇、总正文默认预算 20,000 个 Unicode 字符；各笔记分别读取，不构成同一时刻快照。",
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
    expectedVersion: z.number().int().positive().optional(),
    notebookId: z.string().min(1).max(200).optional(),
    notebookName: z.string().trim().min(1).max(40).optional(),
  }).strict(),
  z.object({
    action: z.literal("set_favorite"),
    noteId: z.string().min(1).max(200),
    expectedVersion: z.number().int().positive().optional(),
    isFavorite: z.boolean().describe("目标收藏状态；true 收藏，false 取消收藏，重复传入结果不反转"),
  }).strict(),
  z.object({
    action: z.literal("set_tags"),
    noteId: z.string().min(1).max(200),
    expectedVersion: z.number().int().positive().optional(),
      tags: noteTagsSchema.describe("标签名，仅可含中文、字母、数字、下划线或连字符，不带 #；mode=replace 时传空数组以清空"),
    mode: z.enum(["replace", "add", "remove"]).describe("必填的标签操作方式；replace 整体替换，add 追加，remove 移除"),
  }).strict(),
  z.object({
    action: z.literal("trash"),
    noteId: z.string().min(1).max(200),
    expectedVersion: z.number().int().positive().optional(),
  }).strict(),
  z.object({
    action: z.literal("restore"),
    noteId: z.string().min(1).max(200),
    expectedVersion: z.number().int().positive().optional(),
  }).strict(),
]);
// Keep the published MCP schema as a plain object. Some clients incorrectly
// combine a root-level additionalProperties:false with oneOf and reject every
// action field before sending the request. The stricter discriminated union
// below still validates the action-specific field combinations server-side.
const noteOperationInputSchema = z.object({
  action: z.enum(["move", "set_favorite", "set_tags", "trash", "restore"]),
  noteId: z.string().min(1).max(200),
  expectedVersion: z.number().int().positive().optional().describe("可选预期版本；省略时服务端读取当前版本，仍使用乐观锁"),
  notebookId: z.string().min(1).max(200).optional().describe("仅 action=move 时使用，与 notebookName 至少提供一个"),
  notebookName: z.string().trim().min(1).max(40).optional(),
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

// Serialize convenience saves so concurrent title upserts do not both create a note.
const saveLocks = new WeakMap<SqliteDatabase, Promise<void>>();
async function withSaveLock<T>(database: SqliteDatabase, operation: () => Promise<T>): Promise<T> {
  const previous = saveLocks.get(database) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  saveLocks.set(database, current);
  await previous;
  try { return await operation(); }
  finally {
    release();
    if (saveLocks.get(database) === current) saveLocks.delete(database);
  }
}

function asUser(value: unknown): UserRow | null {
  if (!value || typeof value !== "object") return null;
  const user = value as Partial<UserRow>;
  return typeof user.id === "string" && typeof user.username === "string"
    ? { id: user.id, username: user.username }
    : null;
}

const BUSINESS_RECOVERY_ACTIONS: Record<string, string> = {
  NOTE_EXISTS: "使用候选 version 作为 expectedVersion 并在指定笔记本内 upsert；多个候选请按 noteId 操作，或使用新标题。",
  NOTEBOOK_EXISTS: "使用 ensure_notebook 获取现有笔记本，或换一个名称。",
  AMBIGUOUS_NOTE: "从 matches 选择目标 noteId，或使用新标题。",
  AMBIGUOUS_MATCH: "选择候选 ID，或提供更精确的片段及 occurrence。",
  AMBIGUOUS_SECTION: "从大纲选择 sectionId，或指定 heading 的 occurrence。",
  VERSION_CONFLICT: "重新读取目标笔记或章节，合并修改后使用最新 version 作为 expectedVersion 重试。",
  NOTE_IN_TRASH: "先用 manage_note 恢复笔记，再执行修改。",
  SECTION_NOT_FOUND: "重新读取大纲，使用当前 sectionId 或正确的 heading。",
  NOT_FOUND: "使用 search_notes 或 list_notebooks 查找当前目标，再以正确的 ID 操作。",
  NOTEBOOK_COUNT_MISMATCH: "重新读取笔记本 totalCount，核实后更新 expectedNoteCount。",
  SYSTEM_NOTEBOOK: "选择其他笔记本；系统收件箱不能删除。",
};

function businessError(value: unknown): Record<string, unknown> {
  const normalized = normalizeMcpError(value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { code: "MCP_OPERATION_FAILED", message: "笔记操作失败" });
  const error: Record<string, unknown> = {
    ...normalized,
    code: typeof normalized.code === "string" ? normalized.code : "MCP_OPERATION_FAILED",
    message: typeof normalized.message === "string" ? normalized.message : "笔记操作失败",
  };
  const suggestedAction = error.code === "NOT_FOUND" && ["text", "anchor", "occurrence"].includes(String(error.target))
    ? "使用 get_note 读取最新正文，修正 oldText、anchor 或 occurrence 后重试。"
    : BUSINESS_RECOVERY_ACTIONS[String(error.code)];
  const current = compactConflictNote(error.current);
  const currentVersion = current && typeof current === "object" && typeof (current as Record<string, unknown>).version === "number"
    ? (current as Record<string, unknown>).version : undefined;
  return {
    ...error,
    ...(Object.hasOwn(error, "current") ? { current } : {}),
    recoverable: suggestedAction !== undefined,
    ...(suggestedAction ? { suggestedAction } : {}),
    ...(currentVersion === undefined ? {} : { currentVersion }),
  };
}

function resultSummary(value: Record<string, unknown>) {
  if (value.error && typeof value.error === "object") {
    const error = value.error as Record<string, unknown>;
    return error.recoverable ? `操作未完成：${error.code}；请查看 structuredContent 中的恢复建议。` : `操作失败：${error.code}；请检查参数或服务状态。`;
  }
  if (Array.isArray(value.results)) return `批量操作完成：更新 ${value.updatedCount ?? 0} 篇，未变 ${value.noopCount ?? 0} 篇，失败 ${value.failedCount ?? 0} 篇。`;
  if (Array.isArray(value.headings)) return `已返回笔记大纲，共 ${value.headings.length} 个标题。`;
  if (value.section) return "已返回目标章节数据。";
  if (Array.isArray(value.notes)) return `已返回 ${value.notes.length} 篇笔记。`;
  if (Array.isArray(value.notebooks)) return `已返回 ${value.notebooks.length} 个笔记本。`;
  if (value.note) return value.created === true ? "已创建笔记。" : "已返回笔记数据。";
  if (value.notebook) return value.created === true ? "已创建笔记本。" : "已返回笔记本数据。";
  if (value.wouldDeleteNotebook !== undefined) return `已生成删除预览，将移动 ${value.wouldMoveNotes ?? 0} 篇笔记。`;
  return "操作完成。";
}

function rawResponseValue(value: Record<string, unknown>, isError = false, options: { writeResult?: boolean; includeContent?: boolean; contentLength?: number } = {}) {
  const sanitized: Record<string, unknown> = withoutThumbnailMetadata(value, options);
  const error = sanitized.error === undefined ? undefined : businessError(sanitized.error);
  const results = Array.isArray(sanitized.results) ? sanitized.results.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const result = entry as Record<string, unknown>;
    return result.error === undefined ? result : { ...result, error: businessError(result.error) };
  }) : undefined;
  const failedResults = results?.filter((entry) => entry && typeof entry === "object" && (entry as Record<string, unknown>).ok === false) as Array<Record<string, unknown>> | undefined;
  const ok = error === undefined && !(failedResults?.length) && !isError;
  const structuredContent = withMcpMetadata({
    ...sanitized,
    ok,
    ...(error === undefined ? {} : { error }),
    ...(results === undefined ? {} : { results }),
  }) as Record<string, unknown>;
  // Recoverable library states are normal tool results; validation and internal
  // failures retain MCP's tool-error signal. Partial batches always retain data.
  const toolError = error !== undefined ? !error.recoverable
    : isError && !(failedResults?.length && failedResults.every((entry) => (entry.error as Record<string, unknown>)?.recoverable === true));
  return {
    structuredContent,
    content: [{ type: "text" as const, text: resultSummary(structuredContent) }],
    ...(toolError ? { isError: true } : {}),
  };
}

const responseValue = rawResponseValue;

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
      ? { error: { ...error, current: compactConflictNote(error.current) } }
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

function normalizeMcpError(error: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...error };
  delete normalized.legacyCode;
  if (normalized.code === "NOTE_NOT_FOUND") return { ...normalized, code: "NOT_FOUND", target: "note" };
  if (normalized.code === "NOTEBOOK_NOT_FOUND") return { ...normalized, code: "NOT_FOUND", target: "notebook" };
  if (normalized.code === "SECTION_AMBIGUOUS") return { ...normalized, code: "AMBIGUOUS_SECTION", target: "section" };
  return normalized;
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
    return "参数必须是包含 action 和 noteId 的对象；expectedVersion 可选。";
  }
  const value = input as Record<string, unknown>;
  const action = value.action;
  if (action === "set_tags") {
    if (!Object.hasOwn(value, "mode")) return "action=set_tags 时必须显式传 mode=replace、add 或 remove。";
    if (!Object.hasOwn(value, "tags")) return "action=set_tags 时必须传 tags 数组；mode 必须为 replace、add 或 remove。";
    if (issues.some((issue) => issue.path[0] === "mode")) return "action=set_tags 的 mode 只能是 replace、add 或 remove。";
    return "action=set_tags 参数无效；请检查 tags 数组、标签格式和必填的 mode。";
  }
  if (action === "move" && !Object.hasOwn(value, "notebookId") && !Object.hasOwn(value, "notebookName")) return "action=move 时必须传 notebookId 或 notebookName。";
  if (action === "set_favorite" && !Object.hasOwn(value, "isFavorite")) return "action=set_favorite 时必须传 isFavorite（true 收藏，false 取消收藏）。";
  if ((action === "trash" || action === "restore") && issues.some((issue) => issue.code === "unrecognized_keys")) {
    return `action=${action} 只接受 action、noteId 和可选的 expectedVersion。`;
  }
  return "action 与参数不匹配；请只传该 action 需要的字段，并提供有效的 noteId。expectedVersion 可省略，由服务端读取当前版本。";
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

async function noteByTitle(options: ServerOptions, user: UserRow, requestedTitle: string, includeDeleted = false, notebookId?: string) {
  const matches = all<{ id: string; title: string; version: number; notebook_name: string; notebook_id: string; content_markdown: string; created_at: number; updated_at: number }>(options.database, `
    SELECT n.id, n.title, n.version, b.name AS notebook_name, n.notebook_id, substr(n.content_markdown, 1, 4000) AS content_markdown, n.created_at, n.updated_at
    FROM notes n JOIN notebooks b ON b.id = n.notebook_id
    WHERE n.user_id = ? AND n.title = ? COLLATE NOCASE
      ${includeDeleted ? "" : "AND n.deleted_at IS NULL"}
      ${notebookId === undefined ? "" : "AND n.notebook_id = ?"}
    ORDER BY n.id LIMIT 6
  `, user.id, requestedTitle.trim(), ...(notebookId === undefined ? [] : [notebookId]));
  if (!matches.length) return { error: { code: "NOT_FOUND", target: "note", message: "找不到精确标题匹配的笔记，请用 search_notes 模糊搜索" } };
  const candidates = matches.slice(0, 5).map((note) => ({ id: note.id, title: note.title, version: note.version, notebookId: note.notebook_id, notebookName: note.notebook_name, preview: formatPreview(note.content_markdown), createdAt: note.created_at, updatedAt: note.updated_at }));
  if (matches.length !== 1) return { error: { code: "AMBIGUOUS_MATCH", target: "title", message: "标题匹配到多篇笔记，请使用 noteId 指定目标", matchCount: matches.length, matches: candidates, truncated: matches.length > 5 } };
  return { noteId: matches[0].id, matches: candidates };
}

// Resolve within the authenticated user's library. Never fall back from a bad ID to a name.
async function resolveNotebook(options: ServerOptions, user: UserRow, selector: { notebookId?: string; notebookName?: string; createIfMissing?: boolean }) {
  if (selector.notebookId !== undefined) {
    const row = getNotebook(options.database, user.id, selector.notebookId);
    return row ? { notebook: toNotebook(row), created: false } : { error: { code: "NOT_FOUND", target: "notebook", message: "笔记本不存在" } };
  }
  if (selector.notebookName === undefined) return {};
  const find = () => {
    const row = first<{ id: string }>(options.database, "SELECT id FROM notebooks WHERE user_id = ? AND name = ?", user.id, selector.notebookName!.trim());
    return row ? getNotebook(options.database, user.id, row.id) : null;
  };
  const row = find();
  if (row) return { notebook: toNotebook(row), created: false };
  if (selector.createIfMissing) {
    const result = await notebooksRoute(options, user, "POST", { name: selector.notebookName });
    if (result.status === 201) return { notebook: result.body.notebook as ReturnType<typeof toNotebook>, created: true };
    if ((result.body.error as Record<string, unknown>)?.code === "NOTEBOOK_EXISTS") {
      const existing = find();
      if (existing) return { notebook: toNotebook(existing), created: false };
    }
    return { error: normalizeMcpError(result.body.error as Record<string, unknown>) };
  }
  return { error: { code: "NOT_FOUND", target: "notebook", message: "笔记本不存在" } };
}

function mcpUser(context: McpRequestContext) {
  return asUser(context.authInfo?.extra?.user);
}

function createNoteMcpServer(options: ServerOptions, context: McpRequestContext) {
  const server = new McpServer({ name: "xiangying-notes", version: "0.1.0" }, {
    instructions: MCP_SERVER_INSTRUCTIONS,
  });
  const user = mcpUser(context);

  const responseValue: typeof rawResponseValue = (value, isError, resultOptions) => {
    const addLinks = (entry: unknown): unknown => {
      if (Array.isArray(entry)) return entry.map(addLinks);
      if (!entry || typeof entry !== "object") return entry;
      const result = Object.fromEntries(Object.entries(entry).map(([key, value]) => [key, addLinks(value)]));
      if (typeof result.id === "string" && typeof result.title === "string" && typeof result.version === "number") {
        const configuredUrl = context.authInfo?.extra?.publicUrl;
        const publicUrl = typeof configuredUrl === "string" ? configuredUrl.trim() : undefined;
        if (publicUrl) {
          try {
            const url = new URL(publicUrl);
            if (url.protocol === "http:" || url.protocol === "https:") {
              url.pathname = "/app";
              url.search = "";
              url.hash = "";
              url.searchParams.set("note", result.id);
              result.webUrl = url.href;
            }
          } catch { /* Links are optional when no valid public URL is configured. */ }
        }
      }
      return result;
    };
    return rawResponseValue(addLinks(value) as Record<string, unknown>, isError, resultOptions);
  };

  server.registerTool("ensure_notebook", {
    title: "确保笔记本存在",
    description: "按名称幂等获取或创建笔记本；已有笔记本不修改颜色和图标，返回 created 标记。",
    inputSchema: z.object({
      name: z.string().trim().min(1).max(40),
      color: z.string().optional(),
      icon: z.enum(VALID_NOTEBOOK_ICONS).optional(),
    }).strict(),
  }, async ({ name, color, icon }) => {
    if (!user) return responseValue({ error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } }, true);
    const existing = await resolveNotebook(options, user, { notebookName: name });
    if (existing.notebook) return responseValue({ notebook: existing.notebook, created: false });
    const created = await notebooksRoute(options, user, "POST", { name, color, icon });
    if (created.status === 201) return responseValue({ ...created.body, created: true });
    if ((created.body.error as Record<string, unknown>)?.code === "NOTEBOOK_EXISTS") {
      const existing = await resolveNotebook(options, user, { notebookName: name });
      if (existing.notebook) return responseValue({ notebook: existing.notebook, created: false });
    }
    return routeError(created);
  });

  server.registerTool("save_note", {
    title: "保存笔记",
    description: "一次定位或创建笔记本并保存。mode 默认 create，同笔记本已有同标题报 NOTE_EXISTS；create 模式省略笔记本放入收件箱；upsert 必须指定笔记本，按标题匹配，更新需 expectedVersion，多篇拒绝。标题匹配忽略 ASCII 大小写，裁剪查询参数首尾空白。 图片仅接受 HTTPS 地址或当前用户可用于该笔记的已上传附件，MCP 不上传图片。",
    inputSchema: z.object({
      title: z.string().trim().min(1).max(200),
      contentMarkdown: z.string().max(NOTE_CONTENT_MAX_LENGTH),
      notebook: z.object({
        notebookId: z.string().min(1).max(200).optional(),
        notebookName: z.string().trim().min(1).max(40).optional(),
        createIfMissing: z.boolean().optional(),
      }).strict().optional(),
      tags: noteTagsSchema.optional(),
      mode: z.enum(["create", "upsert"]).default("create").describe("默认 create，同笔记本同标题报 NOTE_EXISTS；upsert 更新已有笔记必须 expectedVersion"),
      expectedVersion: z.number().int().positive().optional(),
      includeContent: z.boolean().optional(),
    }).strict(),
  }, async ({ title, contentMarkdown, notebook, tags = [], mode = "create", expectedVersion, includeContent = false }) => {
    if (!user) return responseValue({ error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } }, true);
    if (!validMcpTags(tags)) return invalidMcpTagsError(tags);
    const markdown = appendMarkdownTags(contentMarkdown, tags);
    if (markdown.length > NOTE_CONTENT_MAX_LENGTH) return responseValue({ error: { code: "NOTE_TOO_LARGE", message: "包含标签的正文超出长度限制" } }, true);
    if (mode === "upsert" && !notebook?.notebookId && !notebook?.notebookName) return responseValue({ error: { code: "INVALID_NOTEBOOK_SELECTOR", message: "upsert 必须指定笔记本" } }, true);
    return withSaveLock(options.database, async () => {
      const resolved = await resolveNotebook(options, user, notebook ?? {});
      if (resolved.error) return responseValue({ error: resolved.error }, true);
      const notebookId = resolved.notebook?.id ?? first<{ id: string }>(options.database, "SELECT id FROM notebooks WHERE user_id = ? AND is_system = 1 LIMIT 1", user.id)?.id;
      if (!notebookId) return responseValue({ error: { code: "NO_NOTEBOOK", message: "没有可用的收件箱" } }, true);
      const match = await noteByTitle(options, user, title, false, notebookId);
      if (mode === "create" && ("noteId" in match || match.error.code !== "NOT_FOUND")) {
        const candidates = "noteId" in match ? match.matches : match.error.matches;
        return responseValue({ error: {
          code: "NOTE_EXISTS", target: "title", notebookId,
          message: "目标笔记本内已有同标题笔记（忽略 ASCII 大小写）；请指定笔记本并使用 upsert 和候选 version 作为 expectedVersion，或换标题；多篇候选请按 noteId 操作",
          matchCount: "noteId" in match ? 1 : match.error.matchCount,
          matches: candidates,
          truncated: "noteId" in match ? false : match.error.truncated,
        } }, true);
      }
      if (mode === "upsert") {
        if ("noteId" in match) {
          if (expectedVersion === undefined) return responseValue({ error: { code: "VERSION_REQUIRED", message: "覆盖已有笔记必须提供读取时的 expectedVersion" } }, true);
          const result = await updateNoteRoute(options, user, { noteId: match.noteId!, version: expectedVersion, title, contentMarkdown: markdown, includeContent });
          return result.status === 200 ? responseValue({ ...result.body, created: false }, false, { writeResult: true, includeContent }) : noteWriteError(result);
        }
        if (match.error.code !== "NOT_FOUND") return responseValue({ error: { ...match.error, code: "AMBIGUOUS_NOTE" } }, true);
      }
      const result = await notesRoute(options, user, "POST", ["notes"], "/api/notes", { title, contentMarkdown: markdown, notebookId });
      return result.status === 201 ? responseValue({ ...result.body, created: true }, false, { writeResult: true, includeContent }) : noteWriteError(result);
    });
  });

  const sectionSelector = {
    noteId: z.string().min(1).max(200),
    sectionId: z.string().min(1).max(200).optional(),
    heading: z.string().min(1).max(2000).optional(),
    occurrence: z.number().int().positive().optional(),
  };
  server.registerTool("get_note_outline", {
    title: "读取笔记大纲",
    description: "读取 Markdown 文档级标题结构和 version；sectionId 在正文修改后失效，不返回正文。",
    inputSchema: z.object({ noteId: sectionSelector.noteId }).strict(),
  }, async ({ noteId }) => {
    if (!user) return responseValue({ error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } }, true);
    const result = await notesRoute(options, user, "GET", ["notes", noteId], `/api/notes/${encodeURIComponent(noteId)}`);
    if (result.status !== 200) return routeError(result);
    const note = result.body.note as Record<string, unknown>;
    return responseValue({ note: conciseWriteNote(note), version: note.version, headings: getMarkdownOutline(note.contentMarkdown as string).map(({ sectionId, level, text }) => ({ sectionId, level, text })) });
  });
  server.registerTool("get_note_section", {
    title: "读取笔记章节",
    description: "按 sectionId 或精确 heading 读取章节，包含标题和子章节；重复标题用 occurrence 指定。",
    inputSchema: z.object(sectionSelector).strict(),
  }, async ({ noteId, ...selector }) => {
    if (!user) return responseValue({ error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } }, true);
    const result = await notesRoute(options, user, "GET", ["notes", noteId], `/api/notes/${encodeURIComponent(noteId)}`);
    if (result.status !== 200) return routeError(result);
    const note = result.body.note as Record<string, unknown>;
    const body = note.contentMarkdown as string;
    const located = locateMarkdownSection(body, selector);
    if ("error" in located) return responseValue({ error: located.error }, true);
    const { start, end, ...section } = located.section;
    return responseValue({ note: conciseWriteNote(note), version: note.version, section: { ...section, contentMarkdown: body.slice(start, end) } });
  });
  server.registerTool("replace_note_section", {
    title: "替换笔记章节",
    description: "替换整个章节（包括标题及子章节），保留其他正文；重复标题需 occurrence，建议将读取的 version 作为 expectedVersion。 图片仅接受 HTTPS 地址或当前用户可用于该笔记的已上传附件，MCP 不上传图片。",
    inputSchema: z.object({ ...sectionSelector, contentMarkdown: z.string().max(NOTE_CONTENT_MAX_LENGTH), expectedVersion: z.number().int().positive().optional(), includeContent: z.boolean().optional() }).strict(),
  }, async ({ noteId, contentMarkdown, expectedVersion: version, includeContent = false, ...selector }) => {
    if (!user) return responseValue({ error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } }, true);
    const current = await notesRoute(options, user, "GET", ["notes", noteId], `/api/notes/${encodeURIComponent(noteId)}`);
    if (current.status !== 200) return routeError(current);
    const note = current.body.note as Record<string, unknown>;
    if (version !== undefined && version !== note.version) return responseValue({ error: { code: "VERSION_CONFLICT", message: "笔记已更新，请重新读取章节", current: note } }, true);
    if (isDeletedNote(note)) return noteInTrashError();
    const body = note.contentMarkdown as string;
    const located = locateMarkdownSection(body, selector);
    if ("error" in located) return responseValue({ error: located.error }, true);
    const { start, end } = located.section;
    const lineBreak = body.match(/\r\n|\n|\r/u)?.[0] ?? "\n";
    // Keep a block boundary: a following setext heading must not absorb the
    // replacement's trailing paragraph into its heading text.
    const trailingBreaks = contentMarkdown.match(/(?:\r\n|\r|\n)+$/u)?.[0].match(/\r\n|\r|\n/gu)?.length ?? 0;
    const addition = end < body.length && contentMarkdown ? `${contentMarkdown}${lineBreak.repeat(Math.max(0, 2 - trailingBreaks))}` : contentMarkdown;
    const markdown = `${body.slice(0, start)}${addition}${body.slice(end)}`;
    const result = await updateNoteRoute(options, user, { noteId, version: note.version as number, contentMarkdown: markdown, includeContent });
    return result.status === 200 ? responseValue(result.body, false, { writeResult: true, includeContent }) : noteWriteError(result);
  });

  server.registerTool("list_notebooks", {
    title: "列出笔记本",
    description: "列出笔记本；count 不含回收站，totalCount 包含回收站，可用于删除确认。",
    inputSchema: z.object({}).strict(),
  }, async () => {
    if (!user) return responseValue({ error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } }, true);
    const result = await notebooksRoute(options, user);
    return result.status === 200 ? responseValue(result.body) : routeError(result);
  });

  server.registerTool("create_notebook", {
    title: "创建笔记本",
    description: "创建笔记本；重名报错。需要幂等创建时用 ensure_notebook。",
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
    description: "按 ID 或名称修改笔记本名称、颜色或图标。",
    inputSchema: z.object({
      notebookId: z.string().min(1).max(200).optional(),
      notebookName: z.string().trim().min(1).max(40).optional(),
      name: z.string().trim().min(1).max(40).optional().describe("新名称，最多 40 个字符；用于重命名"),
      color: z.string().optional().describe("六位十六进制颜色；格式无效时返回 INVALID_ARGUMENT，field=color。预设示例：#718077 松柏绿、#d96245 朱砂、#5b7899 蓝灰、#9c765f 木棕"),
      icon: z.enum(VALID_NOTEBOOK_ICONS).optional().describe("笔记本图标标识，例如 folder、book 或 bookmark"),
    }).strict(),
  }, async ({ notebookId, notebookName, name, color, icon }) => {
    if (!user) return responseValue({ error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } }, true);
    const resolved = await resolveNotebook(options, user, { notebookId, notebookName });
    if (resolved.error) return responseValue({ error: resolved.error }, true);
    notebookId = resolved.notebook?.id;
    if (!notebookId) return responseValue({ error: { code: "INVALID_NOTEBOOK_SELECTOR", message: "请提供 notebookId 或 notebookName" } }, true);

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
    description: "删除笔记本，将所有笔记移入收件箱并使旧版本失效；dryRun 预览，正式执行需 confirm=true。",
    inputSchema: z.object({
      notebookId: z.string().min(1).max(200).optional(),
      notebookName: z.string().trim().min(1).max(40).optional(),
      dryRun: z.boolean().optional(),
      confirm: z.literal(true).optional().describe("确认删除该笔记本；操作不可逆"),
      expectedNoteCount: z.number().int().min(0).optional().describe("可选的预期笔记总数，来自 list_notebooks 的 totalCount（包括回收站）；不一致时拒绝删除"),
    }).strict(),
  }, async ({ notebookId, notebookName, expectedNoteCount, confirm, dryRun = false }) => {
    if (!user) return responseValue({ error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } }, true);
    const resolved = await resolveNotebook(options, user, { notebookId, notebookName });
    if (resolved.error) return responseValue({ error: resolved.error }, true);
    notebookId = resolved.notebook?.id;
    if (!notebookId) return responseValue({ error: { code: "INVALID_NOTEBOOK_SELECTOR", message: "请提供 notebookId 或 notebookName" } }, true);

    if (resolved.notebook?.isSystem) return responseValue({ error: { code: "SYSTEM_NOTEBOOK", message: "收件箱不能删除" } }, true);
    if (dryRun) return responseValue({ wouldDeleteNotebook: resolved.notebook!.name, wouldMoveNotes: resolved.notebook!.totalCount });
    if (!confirm) return responseValue({ error: { code: "CONFIRMATION_REQUIRED", message: "正式删除必须传 confirm=true" } }, true);
    const result = await notebooksRoute(options, user, "DELETE", expectedNoteCount === undefined ? undefined : { expectedNoteCount }, notebookId);
    return result.status === 200 ? responseValue(result.body) : routeError(result);
  });

  server.registerTool("search_notes", {
    title: "搜索笔记",
    description: "搜索标题或正文，按笔记本、多标签和视图筛选；返回有界摘要及命中线索，支持分页和排序。",
    inputSchema: z.object({
      query: z.string().max(80).optional().describe("搜索词；省略或留空时列出最近笔记"),
      tags: noteTagsSchema.max(20).optional(),
      tagMode: z.enum(["all", "any"]).optional(),
      sort: z.enum(["relevance", "updated_desc", "created_desc"]).optional(),
      notebookId: z.string().min(1).max(200).optional().describe("仅搜索指定笔记本"),
      notebookName: z.string().trim().min(1).max(40).optional(),
      view: z.enum(NOTE_VIEWS).optional().describe("笔记视图，默认 all；trash 搜索回收站"),
      cursor: z.string().max(2048).optional().describe("上一次搜索结果返回的 nextCursor"),
      limit: z.number().int().min(1).max(100).optional().describe("每页数量，默认 20，最大 100"),
      previewLength: z.number().int().min(0).max(NOTE_PREVIEW_LIMIT).optional().describe(`每篇笔记的摘要长度，默认 120，最大 ${NOTE_PREVIEW_LIMIT} 个 Unicode 字符`),
    }).strict(),
  }, async ({ query, tags, tagMode, sort, notebookId, notebookName, view, cursor, limit = 20, previewLength = 120 }) => {
    if (!user) return responseValue({ error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } }, true);
    const resolved = await resolveNotebook(options, user, { notebookId, notebookName });
    if (resolved.error) return responseValue({ error: resolved.error }, true);
    notebookId = resolved.notebook?.id;

    const url = new URL("/api/notes", "http://xiangying-notes.internal");
    if (tags && !validMcpTags(tags)) return invalidMcpTagsError(tags);
    for (const value of tags ?? []) url.searchParams.append("tags", value);
    if (tagMode) url.searchParams.set("tagMode", tagMode);
    url.searchParams.set("sort", sort === "created_desc" ? "created" : sort === "updated_desc" ? "updated" : "relevance");
    url.searchParams.set("includeMatch", "1");
    if (query) url.searchParams.set("query", query);
    if (notebookId) url.searchParams.set("notebookId", notebookId);
    if (view) url.searchParams.set("view", view);
    if (cursor) url.searchParams.set("cursor", cursor);
    url.searchParams.set("limit", String(limit));
    const result = await notesRoute(options, user, "GET", ["notes"], `${url.pathname}${url.search}`);
    if (result.status !== 200) return routeError(result);
    const notes = Array.isArray(result.body.notes) ? result.body.notes as Record<string, unknown>[] : [];
    return responseValue({ ...result.body, notes: withPreviewLimit(notes, previewLength) });
  });

  server.registerTool("get_note", {
    title: "读取笔记",
    description: "按 ID 或精确标题读取；标题匹配忽略 ASCII 大小写并裁剪查询参数首尾空白，仅改变查询大小写或空白不能消歧。模糊查找用 search_notes，长笔记局部读取用 get_note_section；只取版本用 includeContent=false。歧义最多返回 5 个候选，matchCount 上限 6、可能为总数下限；truncated 表示候选未列全。",
    inputSchema: z.object({
      noteId: z.string().min(1).max(200).optional(),
      title: z.string().trim().min(1).max(200).optional(),
      notebookId: z.string().min(1).max(200).optional(),
      notebookName: z.string().trim().min(1).max(40).optional(),
      includeDeleted: z.boolean().optional().describe("仅按 title 查找时是否包含回收站笔记，默认 false；按 noteId 读取回收站笔记不需要此参数"),
      includeContent: z.boolean().optional().describe("是否回传完整正文，默认 true；只想拿 version 时传 false"),
    }).strict(),
  }, async ({ noteId, title, notebookId, notebookName, includeDeleted = false, includeContent = true }) => {
    if (!user) return responseValue({ error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } }, true);
    if (Boolean(noteId) === Boolean(title)) {
      return responseValue({ error: { code: "INVALID_NOTE_SELECTOR", message: "请且仅提供 noteId 或 title 其中一个" } }, true);
    }
    if (title !== undefined) {
      const resolved = await resolveNotebook(options, user, { notebookId, notebookName });
      if (resolved.error) return responseValue({ error: resolved.error }, true);
      const match = await noteByTitle(options, user, title, includeDeleted, resolved.notebook?.id);
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
    description: "批量读取正文，保留总字符预算；各篇分别读取，不构成同一时刻的一致快照。",
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
    description: "创建 Markdown 笔记并追加 tags，允许同名；省略笔记本放入收件箱。常规保存或需防重名时用 save_note。 图片仅接受 HTTPS 地址或当前用户可用于该笔记的已上传附件，MCP 不上传图片。",
    inputSchema: z.object({
      title: z.string().min(1).max(200),
      contentMarkdown: z.string().max(NOTE_CONTENT_MAX_LENGTH).optional().describe("可直接传入完整 Markdown 正文；普通笔记优先一次创建；只有客户端明确无法承载单次参数或服务端返回 MCP 请求体超过 4.5 MB 的错误时才分段；最多 1,000,000 个 UTF-16 code units"),
      notebookId: z.string().min(1).max(200).optional(),
      notebookName: z.string().trim().min(1).max(40).optional(),
      tags: noteTagsSchema.optional().describe("要追加到正文的标签名，仅可含中文、字母、数字、下划线或连字符，不带 #；仅追加，不会覆盖已有标签（整体替换请用 manage_note action=set_tags）"),
      includeContent: z.boolean().optional().describe("是否在成功结果中回传完整正文，默认 false"),
    }).strict(),
  }, async ({ title, contentMarkdown = "", notebookId, notebookName, tags = [], includeContent = false }) => {
    if (!user) return responseValue({ error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } }, true);
    const resolved = await resolveNotebook(options, user, { notebookId, notebookName });
    if (resolved.error) return responseValue({ error: resolved.error }, true);
    notebookId = resolved.notebook?.id;

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
    description: "修改标题或覆盖完整正文；所有写入的版本参数统一 expectedVersion，不接受 version/baseVersion 别名；全文覆盖必须提供 expectedVersion，局部修改优先用片段或章节工具。 图片仅接受 HTTPS 地址或当前用户可用于该笔记的已上传附件，MCP 不上传图片。",
    inputSchema: z.object({
      noteId: z.string().min(1).max(200),
      expectedVersion: z.number().int().positive().optional().describe("预期版本；仅改标题可省略，覆盖正文必须提供版本"),
      title: z.string().max(200).optional(),
      contentMarkdown: z.string().max(NOTE_CONTENT_MAX_LENGTH).optional().describe("完整替换 Markdown 正文；最多 1,000,000 个 UTF-16 code units（JavaScript string.length）"),
      includeContent: z.boolean().optional().describe("是否在成功结果中回传完整正文，默认 false"),
    }).strict(),
  }, async ({ noteId, expectedVersion: version, title, contentMarkdown, includeContent = false }) => {
    if (!user) return responseValue({ error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } }, true);
    if (title === undefined && contentMarkdown === undefined) {
      return responseValue({ error: { code: "EMPTY_UPDATE", message: "请至少提供一个要更新的字段" } }, true);
    }
    if (contentMarkdown !== undefined && version === undefined) return responseValue({ error: { code: "VERSION_REQUIRED", message: "全文覆盖必须提供读取时的 expectedVersion" } }, true);
    const result = await updateNoteRoute(options, user, { noteId, version, title, contentMarkdown, includeContent });
    return result.status === 200
      ? responseValue(result.body, false, { writeResult: true, includeContent, ...(contentMarkdown === undefined ? {} : { contentLength: countUnicodeCharacters(contentMarkdown) }) })
      : noteWriteError(result);
  });

  server.registerTool("replace_in_note", {
    title: "替换笔记片段",
    description: "替换精确片段；歧义需 occurrence 或 replaceAll。applyToLatest 将替换应用到最新正文，写入仍使用乐观锁。 图片仅接受 HTTPS 地址或当前用户可用于该笔记的已上传附件，MCP 不上传图片。",
    inputSchema: z.object({
      noteId: z.string().min(1).max(200),
      oldText: z.string().min(1).max(NOTE_CONTENT_MAX_LENGTH).describe("正文中要查找的精确文本"),
      newText: z.string().max(NOTE_CONTENT_MAX_LENGTH).describe("替换后的文本；支持多行 Markdown"),
      replaceAll: z.boolean().optional().describe("设为 true 时替换所有非重叠匹配，不能与 occurrence 同时使用"),
      occurrence: z.number().int().min(1).optional().describe("可选的匹配序号，从 1 开始；不传时要求 oldText 只出现一次"),
      expectedVersion: z.number().int().positive().optional().describe("可选的预期版本；传入时默认必须与当前版本一致"),
      applyToLatest: z.boolean().optional().describe("显式设为 true 时忽略调用方传入的旧 expectedVersion，并基于服务端刚读取的正文重试替换"),
      includeContent: z.boolean().optional().describe("是否在成功结果中回传完整正文，默认 false"),
    }).strict(),
  }, async ({ noteId, oldText, newText, replaceAll = false, occurrence, expectedVersion: version, applyToLatest = false, includeContent = false }) => {
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
      if (version !== undefined && version !== note.version && !applyToLatest) {
        return responseValue({
          error: {
            code: "VERSION_CONFLICT",
            message: "这篇笔记已在别处更新；请读取最新正文后重试，或显式设置 applyToLatest=true 将替换应用到最新正文",
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

  server.registerTool("manage_note", {
    title: "笔记管理操作",
    description: "移动、设置收藏或标签、移入或恢复回收站；set_tags 必须指定 mode。此工具不提供永久删除。",
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
    if (operation.action === "move") {
      const current = await notesRoute(options, user, "GET", ["notes", operation.noteId], `/api/notes/${encodeURIComponent(operation.noteId)}`);
      if (current.status !== 200) return routeError(current);
      if (isDeletedNote(current.body.note)) return noteInTrashError();
      if (!operation.notebookId && !operation.notebookName) return responseValue({ error: { code: "INVALID_NOTE_OPERATION", message: "move 必须提供 notebookId 或 notebookName" } }, true);
      const resolved = await resolveNotebook(options, user, operation);
      if (resolved.error) return responseValue({ error: resolved.error }, true);
      operation.notebookId = resolved.notebook!.id;
    }

    let currentNote: Record<string, unknown> | undefined;
    let version = operation.expectedVersion;
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
    description: "追加 Markdown；末尾独立标签行保留在新增内容之后。需要换行时在新增文本中包含换行。 图片仅接受 HTTPS 地址或当前用户可用于该笔记的已上传附件，MCP 不上传图片。",
    inputSchema: z.object({
      noteId: z.string().min(1).max(200),
      expectedVersion: z.number().int().positive().optional().describe("可选的预期版本；省略时服务端读取当前版本"),
      contentMarkdown: z.string().min(1).max(NOTE_CONTENT_MAX_LENGTH).describe("要追加的一段 Markdown；正常情况下可一次追加完整新增内容，仅按客户端参数能力或 MCP 请求体上限分段"),
      includeContent: z.boolean().optional().describe("是否在成功结果中回传完整正文，默认 false"),
    }).strict(),
  }, async ({ noteId, expectedVersion: version, contentMarkdown, includeContent = false }) => {
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
    description: "在精确锚点前后插入；歧义需 occurrence 或 insertAll，行边界自动补换行。 图片仅接受 HTTPS 地址或当前用户可用于该笔记的已上传附件，MCP 不上传图片。",
    inputSchema: z.object({
      noteId: z.string().min(1).max(200),
      expectedVersion: z.number().int().positive().optional().describe("可选的预期版本；省略时服务端读取当前版本"),
      anchor: z.string().min(1).max(2000).describe("正文中精确的原文片段"),
      contentMarkdown: z.string().min(1).max(NOTE_CONTENT_MAX_LENGTH).describe("要在锚点前或后插入的 Markdown 内容"),
      insertAll: z.boolean().optional().describe("设为 true 时在所有非重叠 anchor 匹配处插入，不能与 occurrence 同时使用"),
      occurrence: z.number().int().min(1).optional().describe("可选的匹配序号，从 1 开始；不传时要求 anchor 只出现一次"),
      position: z.enum(["before", "after"]).optional().describe("插入位置，默认 after"),
      includeContent: z.boolean().optional().describe("是否在成功结果中回传完整正文，默认 false"),
    }).strict(),
  }, async ({ noteId, expectedVersion: version, anchor, contentMarkdown, insertAll = false, occurrence, position = "after", includeContent = false }) => {
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
    description: "按每篇 expectedVersion 批量管理，逐条报告成功、失败与 noop。partial 固定返回布尔值，仅成功（含 noop）与失败混合时为 true，其他为 false。回收站仅支持单独 deleted=false 恢复。",
    inputSchema: z.object({
      notes: z.array(z.object({ noteId: z.string().min(1).max(200), expectedVersion: z.number().int().positive() }).strict()).min(1).max(50),
      notebookId: z.string().min(1).max(200).optional(),
      notebookName: z.string().trim().min(1).max(40).optional(),
      isFavorite: z.boolean().optional().describe("设定收藏目标状态；true 收藏，false 取消收藏，重复传入不反转"),
      deleted: z.boolean().optional().describe("目标回收站状态；仅当 deleted=false 且没有其他修改时可恢复回收站笔记"),
      tags: noteTagsSchema.optional().describe("追加到每篇笔记正文的标签名，仅可含中文、字母、数字、下划线或连字符，不带 #；仅追加，不会覆盖已有标签"),
      removeTags: noteTagsSchema.optional().describe("从每篇笔记正文移除的标签名，仅可含中文、字母、数字、下划线或连字符，不带 #"),
      replaceTags: noteTagsSchema.optional().describe("整体替换每篇笔记的标签集合，仅可含中文、字母、数字、下划线或连字符，不带 #；空数组清空所有标签，不能与 tags/removeTags 同时使用"),
    }).strict(),
  }, async ({ notes, notebookId, notebookName, isFavorite, deleted, tags, removeTags, replaceTags }) => {
    if (!user) return responseValue({ error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } }, true);
    if (notebookId === undefined && notebookName !== undefined) {
      const resolved = await resolveNotebook(options, user, { notebookName });
      if (resolved.error) return responseValue({ error: resolved.error }, true);
      notebookId = resolved.notebook!.id;
    }
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
      const result = await updateNoteRoute(options, user, { noteId: note.noteId, version: note.expectedVersion, notebookId, isFavorite, deleted, tags, removeTags, replaceTags });
      if (result.status === 200) {
        const updatedNote = result.body.note as Record<string, unknown> | undefined;
        const noop = updatedNote !== undefined && updatedNote.version === note.expectedVersion;
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
      partial: failedCount > 0 && successfulCount > 0,
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
    extra: { user, publicUrl: environment.PUBLIC_URL },
  };

  const normalized = await normalizeMcpRequest(request);
  if (normalized.error) return normalized.error;
  const response = await getMcpHandler(options).fetch(normalized.request, { authInfo });
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  if (headers.get("Content-Type")?.toLowerCase().includes("text/event-stream")) headers.set("X-Accel-Buffering", "no");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
