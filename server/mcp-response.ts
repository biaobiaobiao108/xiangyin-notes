import { NOTE_CONTENT_MAX_LENGTH, type ServerOptions, type UserRow } from "./core";
import { countMarkdownStats } from "../shared/markdown-stats";
import { extractTags, normalizeTag, NOTE_TAG_MAX_LENGTH } from "../shared/tags";
import { validMcpTagName } from "./mcp-schema";

const MATCH_CONTEXT_LENGTH = 30;
const MATCH_CONTEXT_LIMIT = 10;

export function countUnicodeCharacters(value: string) {
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
    const hasHighSurrogate =
      start > 1 && value.charCodeAt(start - 2) >= 0xd800 && value.charCodeAt(start - 2) <= 0xdbff;
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
    const hasLowSurrogate =
      end + 1 < value.length &&
      value.charCodeAt(end + 1) >= 0xdc00 &&
      value.charCodeAt(end + 1) <= 0xdfff;
    end += isHighSurrogate && hasLowSurrogate ? 2 : 1;
    count += 1;
  }
  return end;
}

export function findTextMatches(
  value: string,
  searchText: string,
  options: { overlapping?: boolean; occurrence?: number } = {},
) {
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

export type RouteResult = {
  status: number;
  body: Record<string, unknown>;
};

// Serialize convenience saves so concurrent title upserts do not both create a note.

const BUSINESS_RECOVERY_ACTIONS: Record<string, string> = {
  NOTE_EXISTS:
    "使用候选 version 作为 expectedVersion 并在指定笔记本内 upsert；多个候选请按 noteId 操作，或使用新标题。",
  NOTEBOOK_EXISTS: "使用 ensure_notebook 获取现有笔记本，或换一个名称。",
  AMBIGUOUS_NOTE: "从 matches 选择目标 noteId，或使用新标题。",
  AMBIGUOUS_MATCH: "选择候选 ID，或提供更精确的片段及 occurrence。",
  AMBIGUOUS_SECTION: "从大纲选择 sectionId，或指定 heading 的 occurrence。",
  VERSION_CONFLICT:
    "重新读取目标笔记或章节，合并修改后使用最新 version 作为 expectedVersion 重试。",
  NOTE_IN_TRASH: "先用 manage_note 恢复笔记，再执行修改。",
  SECTION_NOT_FOUND: "重新读取大纲，使用当前 sectionId 或正确的 heading。",
  NOT_FOUND: "使用 search_notes 查找目标笔记，再以正确的 ID 操作。",
  NOTEBOOK_COUNT_MISMATCH: "重新读取笔记本 totalCount，核实后更新 expectedNoteCount。",
  SYSTEM_NOTEBOOK: "选择其他笔记本；系统收件箱不能删除。",
};

function businessError(value: unknown): Record<string, unknown> {
  const normalized = normalizeMcpError(
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { code: "MCP_OPERATION_FAILED", message: "笔记操作失败" },
  );
  const error: Record<string, unknown> = {
    ...normalized,
    code: typeof normalized.code === "string" ? normalized.code : "MCP_OPERATION_FAILED",
    message: typeof normalized.message === "string" ? normalized.message : "笔记操作失败",
  };
  let suggestedAction = BUSINESS_RECOVERY_ACTIONS[String(error.code)];
  if (error.code === "NOT_FOUND") {
    if (error.target === "notebook") {
      suggestedAction = "使用 list_notebooks 查找目标笔记本，再以正确的 ID 操作。";
    } else if (["text", "anchor", "occurrence"].includes(String(error.target))) {
      suggestedAction = "使用 get_note 读取最新正文，修正 oldText、anchor 或 occurrence 后重试。";
    }
  }
  const current = compactConflictNote(error.current);
  const currentVersion =
    current &&
    typeof current === "object" &&
    typeof (current as Record<string, unknown>).version === "number"
      ? (current as Record<string, unknown>).version
      : undefined;
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
    return error.recoverable
      ? `操作未完成：${error.code}；请查看 structuredContent 中的恢复建议。`
      : `操作失败：${error.code}；请检查参数或服务状态。`;
  }
  if (Array.isArray(value.results))
    return `批量操作完成：更新 ${value.updatedCount ?? 0} 篇，未变 ${value.noopCount ?? 0} 篇，失败 ${value.failedCount ?? 0} 篇。`;
  if (Array.isArray(value.headings)) return `已返回笔记大纲，共 ${value.headings.length} 个标题。`;
  if (value.section) return "已返回目标章节数据。";
  if (Array.isArray(value.notes)) return `已返回 ${value.notes.length} 篇笔记。`;
  if (Array.isArray(value.notebooks)) return `已返回 ${value.notebooks.length} 个笔记本。`;
  if (value.note) return value.created === true ? "已创建笔记。" : "已返回笔记数据。";
  if (value.notebook) return value.created === true ? "已创建笔记本。" : "已返回笔记本数据。";
  if (value.wouldDeleteNotebook !== undefined)
    return `已生成删除预览，将移动 ${value.wouldMoveNotes ?? 0} 篇笔记。`;
  return "操作完成。";
}

export function rawResponseValue(
  value: Record<string, unknown>,
  isError = false,
  options: { writeResult?: boolean; includeContent?: boolean } = {},
) {
  const sanitized: Record<string, unknown> = withoutThumbnailMetadata(value, options);
  const error = sanitized.error === undefined ? undefined : businessError(sanitized.error);
  const results = Array.isArray(sanitized.results)
    ? sanitized.results.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
        const result = entry as Record<string, unknown>;
        return result.error === undefined
          ? result
          : { ...result, error: businessError(result.error) };
      })
    : undefined;
  const failedResults = results?.filter(
    (entry) =>
      entry && typeof entry === "object" && (entry as Record<string, unknown>).ok === false,
  ) as Array<Record<string, unknown>> | undefined;
  const ok = error === undefined && !failedResults?.length && !isError;
  const structuredContent = withMcpMetadata({
    ...sanitized,
    ok,
    ...(error === undefined ? {} : { error }),
    ...(results === undefined ? {} : { results }),
  }) as Record<string, unknown>;
  // Recoverable library states are normal tool results; validation and internal
  // failures retain MCP's tool-error signal. Partial batches always retain data.
  const toolError =
    error !== undefined
      ? !error.recoverable
      : isError &&
        !(
          failedResults?.length &&
          failedResults.every(
            (entry) => (entry.error as Record<string, unknown>)?.recoverable === true,
          )
        );
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
  const result = Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, withMcpMetadata(entry)]),
  );
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
  if (Object.prototype.hasOwnProperty.call(result, "deletedAt"))
    result.isDeleted = result.deletedAt !== null;
  return result;
}

function withNoteStatistics(note: Record<string, unknown>) {
  if (typeof note.contentMarkdown !== "string") return note;
  if (
    typeof note.markdownCharacterCount === "number" &&
    typeof note.textCharacterCount === "number" &&
    typeof note.wordCount === "number"
  )
    return note;
  const stats = countMarkdownStats(note.contentMarkdown);
  return { ...note, ...stats };
}

function withoutThumbnailMetadata(
  value: Record<string, unknown>,
  options: { writeResult?: boolean; includeContent?: boolean },
) {
  const omitThumbnail = (note: unknown) => {
    if (!note || typeof note !== "object" || Array.isArray(note)) return note;
    const sanitized = { ...withNoteStatistics(note as Record<string, unknown>) };
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
    ...(Array.isArray(notes)
      ? { notes: notes.map(omitThumbnail) }
      : notes === undefined
        ? {}
        : { notes }),
    ...(error && typeof error === "object" && "current" in error
      ? { error: { ...error, current: compactConflictNote(error.current) } }
      : error === undefined
        ? {}
        : { error }),
  };
}

export function withoutNotePreview(value: Record<string, unknown>) {
  const result = { ...value };
  const note = result.note;
  if (note && typeof note === "object" && !Array.isArray(note)) {
    const noteWithoutPreview = { ...(note as Record<string, unknown>) };
    delete noteWithoutPreview.preview;
    result.note = noteWithoutPreview;
  }
  return result;
}

export function compactConflictNote(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const note = { ...withNoteStatistics(value as Record<string, unknown>) };
  delete note.contentMarkdown;
  delete note.thumbnail;
  return note;
}

export function appendMarkdownTags(markdown: string, tags: string[]) {
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

export function withPreviewLimit(notes: Record<string, unknown>[], previewLength: number) {
  return notes.map((note) => ({ ...note, preview: previewAtLength(note.preview, previewLength) }));
}

export function conciseWriteNote(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const note = withNoteStatistics(value as Record<string, unknown>);
  return {
    id: note.id,
    title: note.title,
    notebookId: note.notebookId,
    notebookName: note.notebookName,
    tags: note.tags,
    isFavorite: note.isFavorite,
    deletedAt: note.deletedAt,
    version: note.version,
    markdownCharacterCount: note.markdownCharacterCount,
    textCharacterCount: note.textCharacterCount,
    wordCount: note.wordCount,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
}

export function invalidMcpTagsError(tags: readonly string[]) {
  const invalidTags = [...new Set(tags.filter((tag) => !validMcpTagName.test(tag.trim())))];
  return responseValue(
    {
      error: {
        code: "INVALID_ARGUMENT",
        field: "tags",
        invalidTags,
        message: `字段 tags 中的标签格式无效；标签只能包含中文、字母、数字、下划线或连字符，每个最多 ${NOTE_TAG_MAX_LENGTH} 个 UTF-16 code units，最多传 50 个标签。请检查 invalidTags。`,
      },
    },
    true,
  );
}

export function routeError(result: RouteResult) {
  const error = result.body.error;
  const normalizedError =
    error && typeof error === "object"
      ? (error as Record<string, unknown>)
      : { code: "MCP_OPERATION_FAILED", message: "笔记操作失败" };
  return responseValue({ error: normalizeMcpError(normalizedError) }, true);
}

export function normalizeMcpError(error: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...error };
  delete normalized.legacyCode;
  if (normalized.code === "NOTE_NOT_FOUND")
    return { ...normalized, code: "NOT_FOUND", target: "note" };
  if (normalized.code === "NOTEBOOK_NOT_FOUND")
    return { ...normalized, code: "NOT_FOUND", target: "notebook" };
  if (normalized.code === "SECTION_AMBIGUOUS")
    return { ...normalized, code: "AMBIGUOUS_SECTION", target: "section" };
  return normalized;
}

export function isDeletedNote(note: unknown) {
  return Boolean(
    note &&
    typeof note === "object" &&
    !Array.isArray(note) &&
    ((note as Record<string, unknown>).isDeleted === true ||
      ((note as Record<string, unknown>).deletedAt !== null &&
        (note as Record<string, unknown>).deletedAt !== undefined)),
  );
}

export function noteInTrashError() {
  return responseValue(
    { error: { code: "NOTE_IN_TRASH", message: "回收站中的笔记只读，请先恢复笔记后再修改" } },
    true,
  );
}

export function noteWriteError(result: RouteResult) {
  const error = result.body.error;
  if (
    error &&
    typeof error === "object" &&
    (error as Record<string, unknown>).code === "INVALID_ASSET"
  ) {
    return responseValue(
      {
        error: {
          ...(error as Record<string, unknown>),
          message:
            "该图片引用无法写入：MCP 不提供图片上传；请使用 HTTPS 图片地址，或当前用户已上传且可用于此笔记的附件引用。",
        },
      },
      true,
    );
  }
  if (
    error &&
    typeof error === "object" &&
    (error as Record<string, unknown>).code === "NOTE_TOO_LARGE"
  ) {
    return responseValue(
      {
        error: {
          ...(error as Record<string, unknown>),
          message: `笔记标题或正文超出长度限制（正文最多 ${NOTE_CONTENT_MAX_LENGTH.toLocaleString("en-US")} 个 UTF-16 code units）；请缩短正文或使用 replace_in_note 修正局部内容。分段追加不能突破单篇笔记的正文上限。`,
        },
      },
      true,
    );
  }
  return routeError(result);
}

export type McpToolContext = {
  options: ServerOptions;
  user: UserRow | null;
  responseValue: typeof rawResponseValue;
};
