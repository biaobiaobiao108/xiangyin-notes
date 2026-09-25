import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations, openDatabase, type SqliteDatabase } from "../server/db";
import { handleRequest } from "../server/index";
import { MCP_PATH } from "../server/mcp";
import { createNote } from "../server/routes/notes";

let database: SqliteDatabase;
let assetRoot: string;
const token = "mcp-test-token-with-enough-randomness-1234567890";
const credentials = { XIANGYING_USERNAME: "owner", XIANGYING_PASSWORD: "a long passphrase 1234" };

beforeEach(async () => {
  database = await openDatabase(":memory:");
  await applyMigrations(database);
  assetRoot = join(tmpdir(), `xiangying-notes-mcp-${crypto.randomUUID()}`);
});

afterEach(async () => {
  database.close();
  await rm(assetRoot, { recursive: true, force: true });
});

async function request(path: string, init: RequestInit = {}, environment: Record<string, string | undefined> = credentials, origin = "http://xiangying.test") {
  const response = await handleRequest(new Request(`${origin}${path}`, init), { database, environment, assetRoot });
  const body = await response.json().catch(() => null) as Record<string, any> | null;
  return { response, body };
}

function modernMcpRequest(method: string, id: number, params: Record<string, unknown> = {}, name?: string) {
  const protocolVersion = "2026-07-28";
  return new Request(`http://xiangying.test${MCP_PATH}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": protocolVersion,
      "Mcp-Method": method,
      ...(name ? { "Mcp-Name": name } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": protocolVersion,
          "io.modelcontextprotocol/clientInfo": { name: "xiangying-notes-test", version: "1.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
}

async function callMcp(requestValue: Request, environment: Record<string, string | undefined> = { ...credentials, XIANGYING_MCP_TOKEN: token }) {
  const response = await handleRequest(requestValue, { database, environment, assetRoot });
  const text = await response.text();
  if (response.headers.get("Content-Type")?.toLowerCase().includes("text/event-stream")) {
    const data = text.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
    return { response, body: data ? JSON.parse(data) as Record<string, any> : null };
  }
  return { response, body: JSON.parse(text) as Record<string, any> };
}

async function callTool(name: string, argumentsValue: Record<string, unknown>, id = 1, environment?: Record<string, string | undefined>) {
  return callMcp(modernMcpRequest("tools/call", id, { name, arguments: argumentsValue }, name), environment);
}

function resultOf(responseBody: Record<string, any>) {
  return responseBody.result as Record<string, any>;
}

function toolData(responseBody: Record<string, any>) {
  const result = resultOf(responseBody);
  expect(result.structuredContent).toBeUndefined();
  expect(result.content).toHaveLength(1);
  return JSON.parse(result.content[0].text) as Record<string, any>;
}

describe("remote MCP endpoint", () => {
  test("requires its own configured Bearer token and ignores cookies and the import token", async () => {
    const unconfigured = await request(MCP_PATH, { method: "POST" });
    expect(unconfigured.response.status).toBe(503);
    expect(unconfigured.body?.error.code).toBe("MCP_AUTH_NOT_CONFIGURED");

    const configuredEnvironment = { ...credentials, XIANGYING_MCP_TOKEN: token, XIANGYING_API_TOKEN: "shortcut-import-token-1234567890" };
    const invalid = await request(MCP_PATH, { method: "POST", headers: { Authorization: "Bearer wrong-token" } }, configuredEnvironment);
    expect(invalid.response.status).toBe(401);
    expect(invalid.response.headers.get("WWW-Authenticate")).toContain("Bearer");

    const apiToken = await request(MCP_PATH, { method: "POST", headers: { Authorization: "Bearer shortcut-import-token-1234567890" } }, configuredEnvironment);
    expect(apiToken.response.status).toBe(401);

    const loginResponse = await handleRequest(new Request("http://xiangying.test/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: credentials.XIANGYING_USERNAME, password: credentials.XIANGYING_PASSWORD }),
    }), { database, environment: configuredEnvironment, assetRoot });
    const cookie = loginResponse.headers.get("Set-Cookie")?.split(";", 1)[0];
    const cookieOnly = await request(MCP_PATH, { method: "POST", headers: cookie ? { Cookie: cookie } : {} }, configuredEnvironment);
    expect(cookieOnly.response.status).toBe(401);
  });

  test("validates Origin when present and accepts native clients without Origin", async () => {
    const environment = { ...credentials, XIANGYING_MCP_TOKEN: token, PUBLIC_URL: "https://notes.example.com" };
    const invalidOrigin = await handleRequest(new Request("https://notes.example.com/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: "https://attacker.example",
      },
    }), { database, environment, assetRoot });
    expect(invalidOrigin.status).toBe(403);

    const noOrigin = await callMcp(modernMcpRequest("tools/list", 1), environment);
    expect(noOrigin.response.status).toBe(200);
    expect(resultOf(noOrigin.body!).tools.map((tool: { name: string }) => tool.name)).toEqual([
      "list_notebooks", "create_notebook", "search_notes", "get_note", "create_note", "update_note",
    ]);

    const validOriginRequest = modernMcpRequest("tools/list", 2);
    validOriginRequest.headers.set("Origin", "https://notes.example.com");
    const validOrigin = await callMcp(validOriginRequest, environment);
    expect(validOrigin.response.status).toBe(200);
  });

  test("provides server-level usage instructions during discovery", async () => {
    const discovered = await callMcp(modernMcpRequest("server/discover", 1), { ...credentials, XIANGYING_MCP_TOKEN: token });
    expect(discovered.response.status).toBe(200);
    expect(resultOf(discovered.body!).instructions).toContain("修改笔记前必须先读取最新版本");
    expect(resultOf(discovered.body!).instructions).toContain("create_notebook");
  });

  test("creates a notebook that can be used when creating a note", async () => {
    const environment = { ...credentials, XIANGYING_MCP_TOKEN: token };
    const created = await callTool("create_notebook", {
      name: "MCP 项目资料",
      color: "#52675b",
      icon: "briefcase",
    }, 1, environment);
    expect(created.response.status).toBe(200);
    const notebook = toolData(created.body!).notebook;
    expect(notebook).toMatchObject({
      name: "MCP 项目资料",
      color: "#52675b",
      icon: "briefcase",
      isSystem: false,
      count: 0,
    });
    expect(typeof notebook.id).toBe("string");

    const note = await callTool("create_note", { title: "项目会议", notebookId: notebook.id }, 2, environment);
    expect(toolData(note.body!).note.notebookId).toBe(notebook.id);
  });

  test("lists notebooks, creates, searches, reads, and updates notes with version checks", async () => {
    const environment = { ...credentials, XIANGYING_MCP_TOKEN: token };
    const notebooks = await callTool("list_notebooks", {}, 1, environment);
    expect(notebooks.response.status).toBe(200);
    const inbox = toolData(notebooks.body!).notebooks[0];
    expect(inbox.name).toBe("收件箱");

    const created = await callTool("create_note", {
      title: "MCP 测试记录",
      contentMarkdown: "这里是 MCP 可搜索正文 #mcp-test",
    }, 2, environment);
    const createdNote = toolData(created.body!).note;
    expect(createdNote.title).toBe("MCP 测试记录");
    expect(createdNote.notebookId).toBe(inbox.id);
    expect(createdNote.version).toBe(1);

    const search = await callTool("search_notes", { query: "mcp-test" }, 3, environment);
    expect(toolData(search.body!).notes.map((note: { id: string }) => note.id)).toContain(createdNote.id);

    const fetched = await callTool("get_note", { noteId: createdNote.id }, 4, environment);
    const fetchedNote = toolData(fetched.body!).note;
    expect(fetchedNote.contentMarkdown).toContain("可搜索正文");
    expect(fetchedNote.version).toBe(1);

    const updated = await callTool("update_note", {
      noteId: createdNote.id,
      version: fetchedNote.version,
      title: "MCP 更新记录",
      contentMarkdown: "更新后的正文 #mcp-updated",
    }, 5, environment);
    const updatedNote = toolData(updated.body!).note;
    expect(updatedNote.title).toBe("MCP 更新记录");
    expect(updatedNote.version).toBe(2);

    const staleUpdate = await callTool("update_note", {
      noteId: createdNote.id,
      version: fetchedNote.version,
      contentMarkdown: "这次不应覆盖当前正文",
    }, 6, environment);
    const staleResult = resultOf(staleUpdate.body!);
    expect(staleResult.isError).toBe(true);
    expect(toolData(staleUpdate.body!).error.code).toBe("VERSION_CONFLICT");
    expect(toolData(staleUpdate.body!).error.current.version).toBe(2);

    const reread = await callTool("get_note", { noteId: createdNote.id }, 7, environment);
    expect(toolData(reread.body!).note.contentMarkdown).toContain("更新后的正文");
  });

  test("keeps Markdown image references without exposing thumbnails or image bytes", async () => {
    const environment = { ...credentials, XIANGYING_MCP_TOKEN: token };
    await callTool("list_notebooks", {}, 1, environment);
    const user = database.query("SELECT id FROM users WHERE username = ?").get(credentials.XIANGYING_USERNAME) as { id: string };
    const assetId = crypto.randomUUID();
    const assetUrl = `/api/assets/${assetId}`;
    database.query("INSERT INTO image_assets (id, user_id, storage_path, original_name, mime_type, byte_size, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(assetId, user.id, `${user.id}/${assetId}.png`, "图片.png", "image/png", 42, 1, 1, Math.floor(Date.now() / 1000));

    const markdown = `正文\n\n![图片](${assetUrl})`;
    const created = await callTool("create_note", { title: "图片引用笔记", contentMarkdown: markdown }, 2, environment);
    const createdNote = toolData(created.body!).note;
    expect(createdNote.contentMarkdown).toBe(markdown);
    expect(createdNote.thumbnail).toBeUndefined();

    const searched = await callTool("search_notes", { query: "图片引用笔记" }, 3, environment);
    const summary = toolData(searched.body!).notes.find((note: { id: string }) => note.id === createdNote.id);
    expect(summary?.thumbnail).toBeUndefined();

    const fetched = await callTool("get_note", { noteId: createdNote.id }, 4, environment);
    expect(toolData(fetched.body!).note.contentMarkdown).toBe(markdown);
    expect(toolData(fetched.body!).note.thumbnail).toBeUndefined();

    const imageRequest = await request(assetUrl, { headers: { Authorization: `Bearer ${token}` } }, environment);
    expect(imageRequest.response.status).toBe(401);

    const updated = await callTool("update_note", { noteId: createdNote.id, version: createdNote.version, contentMarkdown: `${markdown}\n补充` }, 5, environment);
    expect(toolData(updated.body!).note.contentMarkdown).toContain(assetUrl);
    expect(toolData(updated.body!).note.thumbnail).toBeUndefined();

    const conflict = await callTool("update_note", { noteId: createdNote.id, version: createdNote.version, title: "过期标题" }, 6, environment);
    expect(toolData(conflict.body!).error.current.thumbnail).toBeUndefined();
  });

  test("search returns a cursor and loads a non-overlapping next page", async () => {
    const environment = { ...credentials, XIANGYING_MCP_TOKEN: token };
    await callTool("list_notebooks", {}, 1, environment);
    const user = database.query("SELECT id FROM users WHERE username = ?").get(credentials.XIANGYING_USERNAME) as { id: string };
    const inbox = database.query("SELECT id FROM notebooks WHERE user_id = ? AND is_system = 1").get(user.id) as { id: string };
    for (let index = 0; index < 101; index += 1) {
      createNote(database, user.id, inbox.id, `MCP pagination ${index}`, "pagination marker");
    }

    const firstPage = await callTool("search_notes", { query: "pagination" }, 2, environment);
    const firstPageData = toolData(firstPage.body!);
    expect(firstPageData.notes).toHaveLength(100);
    expect(typeof firstPageData.nextCursor).toBe("string");

    const secondPage = await callTool("search_notes", { query: "pagination", cursor: firstPageData.nextCursor }, 3, environment);
    const secondPageData = toolData(secondPage.body!);
    expect(secondPageData.notes.length).toBeGreaterThan(0);
    const firstIds = new Set(firstPageData.notes.map((note: { id: string }) => note.id));
    expect(secondPageData.notes.every((note: { id: string }) => !firstIds.has(note.id))).toBe(true);
  });

  test("rejects empty updates and missing notes as MCP tool errors", async () => {
    const emptyUpdate = await callTool("update_note", { noteId: "missing", version: 1 });
    expect(resultOf(emptyUpdate.body!).isError).toBe(true);
    expect(toolData(emptyUpdate.body!).error.code).toBe("EMPTY_UPDATE");

    const missingNote = await callTool("get_note", { noteId: "missing" }, 2);
    expect(resultOf(missingNote.body!).isError).toBe(true);
    expect(toolData(missingNote.body!).error.code).toBe("NOTE_NOT_FOUND");
  });
});
