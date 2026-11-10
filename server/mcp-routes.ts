import type { McpRequestContext } from "@modelcontextprotocol/server";
import {
  first,
  all,
  formatPreview,
  type RouteContext,
  type ServerOptions,
  type SqliteDatabase,
  type UserRow,
  toNote,
} from "./core";
import { assetRootFromEnv } from "./routes/assets";
import { getNotebook, toNotebook, handleNotebooksRoute } from "./routes/notebooks";
import { handleNotesRoute } from "./routes/notes";
import { extractTags, findTrailingTagFooterStart, removeTagsFromMarkdown } from "../shared/tags";
import { countMarkdownStats } from "../shared/markdown-stats";
import { appendMarkdownTags, normalizeMcpError, type RouteResult } from "./mcp-response";

const saveLocks = new WeakMap<SqliteDatabase, Promise<void>>();
export async function withSaveLock<T>(
  database: SqliteDatabase,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = saveLocks.get(database) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  saveLocks.set(database, current);
  await previous;
  try {
    return await operation();
  } finally {
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

async function routeResult(response: Response | null): Promise<RouteResult> {
  if (!response)
    return {
      status: 500,
      body: { error: { code: "MCP_ROUTE_NOT_FOUND", message: "笔记操作暂时不可用" } },
    };
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, body };
}

function createRouteContext(
  options: ServerOptions,
  method: string,
  pathname: string,
  segments: string[],
  payload?: unknown,
): RouteContext {
  const url = new URL(pathname, "http://xiangying-notes.internal");
  const request = new Request(url, {
    method,
    headers: payload === undefined ? undefined : { "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { request, url, method, segments, options };
}

export async function notesRoute(
  options: ServerOptions,
  user: UserRow,
  method: string,
  segments: string[],
  urlPath: string,
  payload?: unknown,
) {
  const context = createRouteContext(options, method, urlPath, segments, payload);
  const assetRoot = options.assetRoot ?? assetRootFromEnv(options.environment);
  return routeResult(
    await handleNotesRoute(context, user, assetRoot, (note) => {
      // Capture statistics from the exact response version before yielding to
      // another writer. Only MCP summaries pay for parsing the whole document.
      const stats = countMarkdownStats(note.content_markdown);
      return { ...toNote(note), ...stats };
    }),
  );
}

export async function notebooksRoute(
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

export function appendToMarkdown(markdown: string, addition: string) {
  const footerStart = findTrailingTagFooterStart(markdown);
  if (footerStart === null) return `${markdown}${addition}`;

  const prefix = markdown.slice(0, footerStart);
  const footer = markdown.slice(footerStart);
  const inserted = `${prefix}${addition}`;
  if (/(?:\r\n|\n|\r)$/u.test(inserted)) return `${inserted}${footer}`;

  const lineBreak = markdown.match(/\r\n|\n|\r/u)?.[0] ?? "\n";
  return `${inserted}${lineBreak}${footer}`;
}

export type NoteUpdateInput = {
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

export async function updateNoteRoute(
  options: ServerOptions,
  user: UserRow,
  input: NoteUpdateInput,
) {
  let contentMarkdown = input.contentMarkdown;
  let version = input.version;
  let currentNote: Record<string, unknown> | undefined = input.currentNote;
  if (
    version === undefined ||
    input.replaceTags !== undefined ||
    input.tags?.length ||
    input.removeTags?.length
  ) {
    if (!currentNote) {
      const current = await notesRoute(
        options,
        user,
        "GET",
        ["notes", input.noteId],
        `/api/notes/${encodeURIComponent(input.noteId)}`,
      );
      if (current.status !== 200) return current;
      const note = current.body.note as Record<string, unknown> | undefined;
      if (!note)
        return {
          status: 500,
          body: { error: { code: "NOTE_READ_FAILED", message: "读取笔记失败" } },
        };
      currentNote = note;
    }
    if (version === undefined) {
      if (typeof currentNote.version !== "number")
        return {
          status: 500,
          body: { error: { code: "NOTE_READ_FAILED", message: "读取笔记版本失败" } },
        };
      version = currentNote.version;
    }
  }
  if (input.replaceTags !== undefined || input.tags?.length || input.removeTags?.length) {
    if (contentMarkdown === undefined) {
      if (typeof currentNote?.contentMarkdown !== "string")
        return {
          status: 500,
          body: { error: { code: "NOTE_READ_FAILED", message: "读取笔记正文失败" } },
        };
      contentMarkdown = currentNote.contentMarkdown;
    }
    const tagsToRemove =
      input.replaceTags === undefined
        ? (input.removeTags ?? [])
        : [...extractTags(contentMarkdown), ...(input.removeTags ?? [])];
    contentMarkdown = removeTagsFromMarkdown(contentMarkdown, tagsToRemove);
    contentMarkdown = appendMarkdownTags(contentMarkdown, input.replaceTags ?? input.tags ?? []);
  }
  if (version === undefined)
    return {
      status: 500,
      body: { error: { code: "NOTE_READ_FAILED", message: "读取笔记版本失败" } },
    };
  const payload = {
    version,
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(contentMarkdown === undefined ? {} : { contentMarkdown }),
    ...(input.notebookId === undefined ? {} : { notebookId: input.notebookId }),
    ...(input.isFavorite === undefined ? {} : { isFavorite: input.isFavorite }),
    ...(input.deleted === undefined ? {} : { deleted: input.deleted }),
  };
  const path = `/api/notes/${encodeURIComponent(input.noteId)}${input.includeContent ? "" : "?response=summary"}`;
  return notesRoute(options, user, "PATCH", ["notes", input.noteId], path, payload);
}

export async function noteByTitle(
  options: ServerOptions,
  user: UserRow,
  requestedTitle: string,
  includeDeleted = false,
  notebookId?: string,
) {
  const matches = all<{
    id: string;
    title: string;
    version: number;
    notebook_name: string;
    notebook_id: string;
    content_markdown: string;
    created_at: number;
    updated_at: number;
  }>(
    options.database,
    `
    SELECT n.id, n.title, n.version, b.name AS notebook_name, n.notebook_id, substr(n.content_markdown, 1, 4000) AS content_markdown, n.created_at, n.updated_at
    FROM notes n JOIN notebooks b ON b.id = n.notebook_id
    WHERE n.user_id = ? AND n.title = ? COLLATE NOCASE
      ${includeDeleted ? "" : "AND n.deleted_at IS NULL"}
      ${notebookId === undefined ? "" : "AND n.notebook_id = ?"}
    ORDER BY n.id LIMIT 6
  `,
    user.id,
    requestedTitle.trim(),
    ...(notebookId === undefined ? [] : [notebookId]),
  );
  if (!matches.length)
    return {
      error: {
        code: "NOT_FOUND",
        target: "note",
        message: "找不到精确标题匹配的笔记，请用 search_notes 模糊搜索",
      },
    };
  const candidates = matches.slice(0, 5).map((note) => ({
    id: note.id,
    title: note.title,
    version: note.version,
    notebookId: note.notebook_id,
    notebookName: note.notebook_name,
    preview: formatPreview(note.content_markdown),
    createdAt: note.created_at,
    updatedAt: note.updated_at,
  }));
  if (matches.length !== 1)
    return {
      error: {
        code: "AMBIGUOUS_MATCH",
        target: "title",
        message: "标题匹配到多篇笔记，请使用 noteId 指定目标",
        matchCount: matches.length,
        matches: candidates,
        truncated: matches.length > 5,
      },
    };
  return { noteId: matches[0].id, matches: candidates };
}

// Resolve within the authenticated user's library. Never fall back from a bad ID to a name.
export async function resolveNotebook(
  options: ServerOptions,
  user: UserRow,
  selector: { notebookId?: string; notebookName?: string; createIfMissing?: boolean },
) {
  if (selector.notebookId !== undefined) {
    const row = getNotebook(options.database, user.id, selector.notebookId);
    return row
      ? { notebook: toNotebook(row), created: false }
      : { error: { code: "NOT_FOUND", target: "notebook", message: "笔记本不存在" } };
  }
  if (selector.notebookName === undefined) return {};
  const find = () => {
    const row = first<{ id: string }>(
      options.database,
      "SELECT id FROM notebooks WHERE user_id = ? AND name = ?",
      user.id,
      selector.notebookName!.trim(),
    );
    return row ? getNotebook(options.database, user.id, row.id) : null;
  };
  const row = find();
  if (row) return { notebook: toNotebook(row), created: false };
  if (selector.createIfMissing) {
    const result = await notebooksRoute(options, user, "POST", { name: selector.notebookName });
    if (result.status === 201)
      return { notebook: result.body.notebook as ReturnType<typeof toNotebook>, created: true };
    if ((result.body.error as Record<string, unknown>)?.code === "NOTEBOOK_EXISTS") {
      const existing = find();
      if (existing) return { notebook: toNotebook(existing), created: false };
    }
    return { error: normalizeMcpError(result.body.error as Record<string, unknown>) };
  }
  return { error: { code: "NOT_FOUND", target: "notebook", message: "笔记本不存在" } };
}

export function mcpUser(context: McpRequestContext) {
  return asUser(context.authInfo?.extra?.user);
}
