import {
  constantTimeEqual,
  first,
  getNote,
  json,
  jsonError,
  NOTE_BODY_MAX_BYTES,
  NOTE_CONTENT_MAX_LENGTH,
  type RouteContext,
  toNote,
  validNoteAssetReferences,
  validText,
} from "../core";
import { getAuthCredentials, ensureEnvironmentUser } from "./auth";
import { createNote } from "./notes";

const IMPORT_API_PATH = "/api/import";

function getApiToken(environment: Record<string, string | undefined>) {
  const token = environment.XIANGYING_API_TOKEN?.trim();
  return token || null;
}

function bearerToken(request: Request) {
  const header = request.headers.get("Authorization")?.trim();
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/iu.exec(header);
  return match?.[1] ?? null;
}

function requireApiToken(request: Request, environment: Record<string, string | undefined>) {
  const expectedToken = getApiToken(environment);
  if (!expectedToken) return jsonError(503, "API_AUTH_NOT_CONFIGURED", "请先配置 XIANGYING_API_TOKEN");

  const suppliedToken = bearerToken(request);
  if (!suppliedToken || !constantTimeEqual(suppliedToken, expectedToken)) {
    return jsonError(401, "INVALID_API_TOKEN", "API Token 无效或缺失", {
      "WWW-Authenticate": 'Bearer realm="xiangying-import"',
    });
  }
  return null;
}

type ReadTextBodyResult =
  | { ok: true; text: string }
  | { ok: false; reason: "invalid" | "too-large" };

async function readTextBody(request: Request, maxBytes: number): Promise<ReadTextBodyResult> {
  const contentLengthHeader = request.headers.get("Content-Length");
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (!Number.isInteger(contentLength) || contentLength < 0 || contentLength > maxBytes) return { ok: false, reason: "too-large" };
  }

  if (!request.body) return { ok: true, text: "" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { ok: false, reason: "too-large" };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false, reason: "invalid" };
  } finally {
    reader.releaseLock();
  }
}

function formatImportTitle(timestamp: number) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp * 1000));
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `快捷导入 ${value("year")}-${value("month")}-${value("day")} ${value("hour")}:${value("minute")}:${value("second")}`;
}

export async function handleImportRoute(ctx: RouteContext): Promise<Response | null> {
  const { request, url, method, options } = ctx;
  if (url.pathname !== IMPORT_API_PATH) return null;
  if (method !== "POST") return jsonError(405, "METHOD_NOT_ALLOWED", "导入接口只支持 POST", { Allow: "POST" });

  const environment = options.environment ?? {};
  const tokenError = requireApiToken(request, environment);
  if (tokenError) return tokenError;

  const credentials = getAuthCredentials(environment);
  if (!credentials) return jsonError(503, "AUTH_NOT_CONFIGURED", "请先配置 XIANGYING_USERNAME 和 XIANGYING_PASSWORD");

  const mediaType = (request.headers.get("Content-Type") ?? "").split(";", 1)[0].trim().toLowerCase();
  const isJson = mediaType === "application/json";
  const isMarkdown = mediaType === "text/markdown" || mediaType === "text/plain" || mediaType === "";
  if (!isJson && !isMarkdown) return jsonError(415, "UNSUPPORTED_MEDIA_TYPE", "只支持 application/json、text/markdown 或 text/plain");

  const body = await readTextBody(request, NOTE_BODY_MAX_BYTES);
  if (!body.ok) {
    return body.reason === "too-large"
      ? jsonError(413, "NOTE_TOO_LARGE", "笔记正文超过大小限制")
      : jsonError(400, "INVALID_REQUEST_BODY", "请求体不是有效的 UTF-8 文本");
  }

  let contentMarkdown: string;
  if (isJson) {
    try {
      const payload = JSON.parse(body.text) as { contentMarkdown?: unknown } | null;
      if (!payload || typeof payload !== "object" || typeof payload.contentMarkdown !== "string") {
        return jsonError(400, "INVALID_IMPORT_PAYLOAD", "请求体必须包含字符串字段 contentMarkdown");
      }
      contentMarkdown = payload.contentMarkdown;
    } catch {
      return jsonError(400, "INVALID_JSON", "请求体不是有效的 JSON");
    }
  } else {
    contentMarkdown = body.text;
  }

  if (!validText(contentMarkdown, NOTE_CONTENT_MAX_LENGTH)) return jsonError(413, "NOTE_TOO_LARGE", "笔记正文超过 1000000 个字符限制");
  if (!contentMarkdown.trim()) return jsonError(400, "EMPTY_NOTE", "笔记正文不能为空");

  const user = await ensureEnvironmentUser(options.database, credentials);
  const inbox = first<{ id: string }>(options.database, "SELECT id FROM notebooks WHERE user_id = ? AND is_system = 1 LIMIT 1", user.id);
  if (!inbox) return jsonError(500, "NO_INBOX", "找不到收件箱");
  if (!validNoteAssetReferences(options.database, user.id, null, contentMarkdown)) return jsonError(400, "INVALID_ASSET", "笔记包含不支持的图片地址或无权访问的图片");

  let noteId: string;
  try {
    noteId = createNote(options.database, user.id, inbox.id, formatImportTitle(Math.floor(Date.now() / 1000)), contentMarkdown);
  } catch (error) {
    if (error instanceof Error && error.message === "invalid-note-assets") return jsonError(400, "INVALID_ASSET", "笔记包含不支持的图片地址或无权访问的图片");
    throw error;
  }
  const note = getNote(options.database, user.id, noteId);
  return json({ ok: true, note: note ? toNote(note) : null }, 201);
}
