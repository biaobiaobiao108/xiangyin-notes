import { createMcpHandler, type AuthInfo, type McpHttpHandler } from "@modelcontextprotocol/server";
import {
  constantTimeEqual,
  getPublicOrigin,
  jsonError,
  NOTE_BODY_MAX_BYTES,
  NOTE_CONTENT_MAX_LENGTH,
  type ServerOptions,
  type SqliteDatabase,
} from "./core";
import { ensureEnvironmentUser, getAuthCredentials } from "./routes/auth";
import { createNoteMcpServer } from "./mcp";

export const MCP_PATH = "/mcp";

const MCP_CONTENT_FIELDS = new Map([
  ["create_note", "contentMarkdown"],
  ["save_note", "contentMarkdown"],
  ["replace_note_section", "contentMarkdown"],
  ["update_note", "contentMarkdown"],
  ["append_to_note", "contentMarkdown"],
  ["insert_into_note", "contentMarkdown"],
  ["replace_in_note", "newText"],
]);

const handlerByDatabase = new WeakMap<SqliteDatabase, { key: string; handler: McpHttpHandler }>();

function getMcpHandler(options: ServerOptions) {
  // The handler closes over `options`, so a cache keyed only by the database would
  // keep serving the first environment/asset root it saw in the process.
  const cacheKey = [
    options.assetRoot ?? "",
    options.clientRoot ?? "",
    options.environment?.PUBLIC_URL ?? "",
    options.environment?.XIANGYING_USERNAME ?? "",
  ].join("\u0000");
  const cached = handlerByDatabase.get(options.database);
  if (cached && cached.key === cacheKey) return cached.handler;
  const handler = createMcpHandler((context) => createNoteMcpServer(options, context));
  handlerByDatabase.set(options.database, { key: cacheKey, handler });
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
      output +=
        code === 0x08
          ? "\\b"
          : code === 0x09
            ? "\\t"
            : code === 0x0a
              ? "\\n"
              : code === 0x0c
                ? "\\f"
                : code === 0x0d
                  ? "\\r"
                  : `\\u${code.toString(16).padStart(4, "0")}`;
      continue;
    }
    output += character;
  }
  return { value: changed ? output : value, changed };
}

function invalidMcpArguments(id: unknown, message: string) {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: typeof id === "string" || typeof id === "number" ? id : null,
      error: { code: -32602, message },
    }),
    { status: 400, headers: { "Content-Type": "application/json; charset=utf-8" } },
  );
}

async function readMcpBody(request: Request) {
  const reader = request.clone().body?.getReader();
  if (!reader) return { value: "", tooLarge: false };
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > NOTE_BODY_MAX_BYTES) {
        // A tee branch waits for its sibling (and potentially the source) to cancel.
        // Stop both branches without delaying the size-limit response.
        void reader.cancel().catch(() => {});
        void request.body?.cancel().catch(() => {});
        return { value: "", tooLarge: true };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { value: new TextDecoder().decode(bytes), tooLarge: false };
}

async function normalizeMcpRequest(
  request: Request,
): Promise<{ request: Request; error?: Response }> {
  if (request.method !== "POST" || !request.body) return { request };
  const { value: rawBody, tooLarge } = await readMcpBody(request);
  if (tooLarge)
    return {
      request,
      error: invalidMcpArguments(
        null,
        "MCP 请求体超过 4.5 MB 传输上限；请拆分本次参数或把新增正文分段调用 append_to_note。普通笔记在单次请求未超限时应优先直接创建；分段写入仍受单篇笔记正文总长度上限约束。",
      ),
    };
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
      error: invalidMcpArguments(
        null,
        "字符串中存在未转义的控制字符（U+0000–U+001F），请检查 contentMarkdown；修正后仍需发送完整 JSON。",
      ),
    };
  }

  let rewritten = outer.changed;
  if (message.method === "tools/call") {
    const params =
      message.params && typeof message.params === "object" && !Array.isArray(message.params)
        ? (message.params as Record<string, unknown>)
        : null;
    const rawArguments = params?.arguments;
    let argumentsValue: unknown = rawArguments;
    if (typeof rawArguments === "string") {
      const inner = escapeUnescapedControlsInJsonStrings(rawArguments);
      try {
        argumentsValue = JSON.parse(rawArguments);
      } catch {
        if (!inner.changed) {
          return {
            request,
            error: invalidMcpArguments(
              message.id,
              "tools/call 的 arguments 必须是 JSON 对象，不能是字符串；请传入未二次序列化的对象参数。",
            ),
          };
        }
        try {
          argumentsValue = JSON.parse(inner.value);
          rewritten = true;
        } catch {
          return {
            request,
            error: invalidMcpArguments(
              message.id,
              "字符串中存在未转义的控制字符（U+0000–U+001F），请检查 contentMarkdown；arguments 还必须是完整 JSON 对象。",
            ),
          };
        }
      }
      rewritten = true;
    }
    if (
      rawArguments !== undefined &&
      (!argumentsValue || typeof argumentsValue !== "object" || Array.isArray(argumentsValue))
    ) {
      return {
        request,
        error: invalidMcpArguments(
          message.id,
          "tools/call 的 arguments 必须是 JSON 对象；多行正文请放在 contentMarkdown 字段中。",
        ),
      };
    }
    const toolName = params?.name;
    const contentField =
      typeof toolName === "string" ? MCP_CONTENT_FIELDS.get(toolName) : undefined;
    const contentValue =
      argumentsValue && typeof argumentsValue === "object" && !Array.isArray(argumentsValue)
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
  if (!expectedToken)
    return jsonError(503, "MCP_AUTH_NOT_CONFIGURED", "请先配置 XIANGYING_MCP_TOKEN");

  const suppliedToken = pathToken(request);
  if (!suppliedToken || !constantTimeEqual(suppliedToken, expectedToken)) {
    return jsonError(401, "INVALID_MCP_TOKEN", "MCP URL 令牌无效或缺失");
  }

  const originError = validateOrigin(request, environment);
  if (originError) return originError;

  const credentials = getAuthCredentials(environment);
  if (!credentials)
    return jsonError(
      503,
      "AUTH_NOT_CONFIGURED",
      "请先配置 XIANGYING_USERNAME 和 XIANGYING_PASSWORD",
    );
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
  if (headers.get("Content-Type")?.toLowerCase().includes("text/event-stream"))
    headers.set("X-Accel-Buffering", "no");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
