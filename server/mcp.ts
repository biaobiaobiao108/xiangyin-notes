import { createMcpHandler, McpServer, type AuthInfo, type McpHttpHandler, type McpRequestContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  constantTimeEqual,
  getPublicOrigin,
  jsonError,
  type RouteContext,
  type ServerOptions,
  type SqliteDatabase,
  type UserRow,
} from "./core";
import { ensureEnvironmentUser, getAuthCredentials } from "./routes/auth";
import { assetRootFromEnv } from "./routes/assets";
import { handleNotebooksRoute } from "./routes/notebooks";
import { handleNotesRoute } from "./routes/notes";

export const MCP_PATH = "/mcp";

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

function responseValue(value: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
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

async function notebooksRoute(options: ServerOptions, user: UserRow) {
  const context = createRouteContext(options, "GET", "/api/notebooks", ["notebooks"]);
  return routeResult(await handleNotebooksRoute(context, user));
}

function mcpUser(context: McpRequestContext) {
  return asUser(context.authInfo?.extra?.user);
}

function createNoteMcpServer(options: ServerOptions, context: McpRequestContext) {
  const server = new McpServer({ name: "xiangying-notes", version: "0.1.0" });
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

  server.registerTool("search_notes", {
    title: "搜索笔记",
    description: "按标题、正文或标签搜索笔记。省略 query 可列出最近更新的笔记；使用 nextCursor 继续读取下一页。",
    inputSchema: z.object({
      query: z.string().max(80).optional().describe("搜索词；省略或留空时列出最近笔记"),
      notebookId: z.string().min(1).max(200).optional().describe("仅搜索指定笔记本"),
      cursor: z.string().max(2048).optional().describe("上一次搜索结果返回的 nextCursor"),
    }),
  }, async ({ query, notebookId, cursor }) => {
    if (!user) return responseValue({ error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } }, true);
    const url = new URL("/api/notes", "http://xiangying-notes.internal");
    if (query) url.searchParams.set("query", query);
    if (notebookId) url.searchParams.set("notebookId", notebookId);
    if (cursor) url.searchParams.set("cursor", cursor);
    const result = await notesRoute(options, user, "GET", ["notes"], `${url.pathname}${url.search}`);
    return result.status === 200 ? responseValue(result.body) : routeError(result);
  });

  server.registerTool("get_note", {
    title: "读取笔记",
    description: "按笔记 ID 读取完整笔记内容和 version。更新前先读取笔记，并在 update_note 中带回 version。",
    inputSchema: z.object({ noteId: z.string().min(1).max(200) }),
  }, async ({ noteId }) => {
    if (!user) return responseValue({ error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } }, true);
    const result = await notesRoute(options, user, "GET", ["notes", noteId], `/api/notes/${encodeURIComponent(noteId)}`);
    return result.status === 200 ? responseValue(result.body) : routeError(result);
  });

  server.registerTool("create_note", {
    title: "创建笔记",
    description: "创建一篇 Markdown 笔记。省略 notebookId 时放入收件箱。",
    inputSchema: z.object({
      title: z.string().min(1).max(200),
      contentMarkdown: z.string().max(1_000_000).optional(),
      notebookId: z.string().min(1).max(200).optional(),
    }),
  }, async ({ title, contentMarkdown, notebookId }) => {
    if (!user) return responseValue({ error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } }, true);
    const payload = {
      title,
      ...(contentMarkdown === undefined ? {} : { contentMarkdown }),
      ...(notebookId === undefined ? {} : { notebookId }),
    };
    const result = await notesRoute(options, user, "POST", ["notes"], "/api/notes", payload);
    return result.status === 201 ? responseValue(result.body) : routeError(result);
  });

  server.registerTool("update_note", {
    title: "更新笔记",
    description: "更新笔记标题、Markdown 正文或所属笔记本。必须提供 get_note 返回的 version；遇到版本冲突时先读取当前内容并合并后再重试。",
    inputSchema: z.object({
      noteId: z.string().min(1).max(200),
      version: z.number().int().positive(),
      title: z.string().max(200).optional(),
      contentMarkdown: z.string().max(1_000_000).optional(),
      notebookId: z.string().min(1).max(200).optional(),
    }),
  }, async ({ noteId, version, title, contentMarkdown, notebookId }) => {
    if (!user) return responseValue({ error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } }, true);
    if (title === undefined && contentMarkdown === undefined && notebookId === undefined) {
      return responseValue({ error: { code: "EMPTY_UPDATE", message: "请至少提供一个要更新的字段" } }, true);
    }
    const payload = {
      version,
      ...(title === undefined ? {} : { title }),
      ...(contentMarkdown === undefined ? {} : { contentMarkdown }),
      ...(notebookId === undefined ? {} : { notebookId }),
    };
    const result = await notesRoute(options, user, "PATCH", ["notes", noteId], `/api/notes/${encodeURIComponent(noteId)}`, payload);
    return result.status === 200 ? responseValue(result.body) : routeError(result);
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

  const response = await getMcpHandler(options).fetch(request, { authInfo });
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  if (headers.get("Content-Type")?.toLowerCase().includes("text/event-stream")) headers.set("X-Accel-Buffering", "no");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
