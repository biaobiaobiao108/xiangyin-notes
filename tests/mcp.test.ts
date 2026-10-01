import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations, openDatabase, type SqliteDatabase } from "../server/db";
import { handleRequest, redactSensitivePath } from "../server/index";
import { MCP_PATH } from "../server/mcp";
import { createNote } from "../server/routes/notes";
import { handleNoteShares } from "../server/routes/shares";

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
  return new Request(`http://xiangying.test${MCP_PATH}/${encodeURIComponent(token)}`, {
    method: "POST",
    headers: {
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

function requestWithBody(requestValue: Request, body: string) {
  const headers = new Headers(requestValue.headers);
  headers.delete("Content-Length");
  return new Request(requestValue.url, { method: requestValue.method, headers, body });
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
  test("authenticates with a path token and ignores Authorization, cookies, and the import token", async () => {
    const unconfigured = await request(`${MCP_PATH}/${token}`, { method: "POST" });
    expect(unconfigured.response.status).toBe(503);
    expect(unconfigured.body?.error.code).toBe("MCP_AUTH_NOT_CONFIGURED");

    const configuredEnvironment = { ...credentials, XIANGYING_MCP_TOKEN: token, XIANGYING_API_TOKEN: "shortcut-import-token-1234567890" };
    const invalid = await request(`${MCP_PATH}/wrong-token`, { method: "POST" }, configuredEnvironment);
    expect(invalid.response.status).toBe(401);
    expect(invalid.response.headers.get("Cache-Control")).toBe("no-store");
    expect(invalid.response.headers.get("Referrer-Policy")).toBe("no-referrer");

    const nestedTokenPath = await request(`${MCP_PATH}/${token}/extra`, { method: "POST" }, configuredEnvironment);
    expect(nestedTokenPath.response.status).toBe(401);

    const headerOnly = await request(MCP_PATH, { method: "POST", headers: { Authorization: `Bearer ${token}` } }, configuredEnvironment);
    expect(headerOnly.response.status).toBe(401);

    const apiToken = await request(`${MCP_PATH}/shortcut-import-token-1234567890`, { method: "POST" }, configuredEnvironment);
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
    const invalidOrigin = await handleRequest(new Request(`https://notes.example.com${MCP_PATH}/${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { Origin: "https://attacker.example" },
    }), { database, environment, assetRoot });
    expect(invalidOrigin.status).toBe(403);

    const noOrigin = await callMcp(modernMcpRequest("tools/list", 1), environment);
    expect(noOrigin.response.status).toBe(200);
    const tools = resultOf(noOrigin.body!).tools;
    expect(tools.map((tool: { name: string }) => tool.name)).toEqual([
      "list_notebooks", "create_notebook", "update_notebook", "delete_notebook", "search_notes", "create_share", "list_shares", "revoke_share", "list_trash", "get_note", "get_notes_batch", "create_note", "update_note", "replace_in_note", "note_operation", "append_to_note", "insert_into_note", "batch_update_notes",
    ]);
    const assertClosedSchemas = (schema: Record<string, any>) => {
      if ((schema.type === "object" || schema.properties) && !schema.oneOf && !schema.anyOf) expect(schema.additionalProperties).toBe(false);
      for (const property of Object.values(schema.properties ?? {})) {
        if (property && typeof property === "object") assertClosedSchemas(property as Record<string, any>);
      }
      if (schema.items && typeof schema.items === "object") assertClosedSchemas(schema.items as Record<string, any>);
      for (const branch of [...(schema.oneOf ?? []), ...(schema.anyOf ?? [])]) assertClosedSchemas(branch);
    };
    const assertNoPattern = (schema: Record<string, any>) => {
      expect(schema.pattern).toBeUndefined();
      for (const property of Object.values(schema.properties ?? {})) {
        if (property && typeof property === "object") assertNoPattern(property as Record<string, any>);
      }
      if (schema.items && typeof schema.items === "object") assertNoPattern(schema.items as Record<string, any>);
      for (const branch of [...(schema.oneOf ?? []), ...(schema.anyOf ?? [])]) assertNoPattern(branch);
    };
    for (const tool of tools) {
      assertClosedSchemas(tool.inputSchema);
      assertNoPattern(tool.inputSchema);
    }
    const updateSchema = tools.find((tool: { name: string }) => tool.name === "update_note").inputSchema;
    expect(Object.keys(updateSchema.properties)).toEqual(["noteId", "version", "title", "contentMarkdown", "includeContent"]);
    expect(updateSchema.required).toEqual(["noteId"]);
    expect(updateSchema.additionalProperties).toBe(false);
    const noteOperation = tools.find((tool: { name: string }) => tool.name === "note_operation");
    expect(noteOperation.inputSchema.type).toBe("object");
    expect(noteOperation.inputSchema.oneOf).toBeUndefined();
    expect(noteOperation.inputSchema.anyOf).toBeUndefined();
    expect(noteOperation.inputSchema.additionalProperties).toBe(false);
    expect(Object.keys(noteOperation.inputSchema.properties)).toEqual([
      "action", "noteId", "version", "notebookId", "isFavorite", "tags", "mode",
    ]);
    expect(noteOperation.inputSchema.properties.action.enum).toEqual([
      "move", "set_favorite", "set_tags", "trash", "restore",
    ]);
    expect(noteOperation.inputSchema.required).toEqual(["action", "noteId"]);
    expect(noteOperation.inputSchema.properties.version.description).toContain("省略时服务端读取当前版本");
    expect(noteOperation.inputSchema.properties.mode.description).toContain("action=set_tags 时必填");
    expect(noteOperation.description).toContain("此工具不提供永久删除");
    const listSharesTool = tools.find((tool: { name: string }) => tool.name === "list_shares");
    expect(listSharesTool.inputSchema.required).toEqual(["noteId"]);
    expect(listSharesTool.inputSchema.properties.limit.maximum).toBe(100);
    const createNoteTool = tools.find((tool: { name: string }) => tool.name === "create_note");
    expect(createNoteTool.description).toContain("普通笔记优先在本次 create_note 一次创建完成");
    expect(createNoteTool.description).toContain("只有正文超过约 8,000 个 Unicode 字符时");
    expect(createNoteTool.inputSchema.properties.contentMarkdown.description).toContain("普通笔记优先一次创建");
    const getNotesBatch = tools.find((tool: { name: string }) => tool.name === "get_notes_batch");
    expect(getNotesBatch.description).toContain("不构成同一时刻的一致快照，也可能看不到并行或之后完成的写入");
    const searchTool = tools.find((tool: { name: string }) => tool.name === "search_notes");
    expect(searchTool.description).toContain("摘要保留换行");
    const replaceSchema = tools.find((tool: { name: string }) => tool.name === "replace_in_note").inputSchema;
    expect(Object.keys(replaceSchema.properties)).toEqual(["noteId", "oldText", "newText", "replaceAll", "occurrence", "version", "force", "includeContent"]);
    const insertSchema = tools.find((tool: { name: string }) => tool.name === "insert_into_note").inputSchema;
    expect(Object.keys(insertSchema.properties)).toContain("insertAll");
    const batchUpdateTool = tools.find((tool: { name: string }) => tool.name === "batch_update_notes");
    expect(batchUpdateTool.description).toContain("仅当本次只传 deleted:false 时可批量恢复");
    expect(batchUpdateTool.inputSchema.properties.replaceTags.description).toContain("整体替换");
    const revokeShareTool = tools.find((tool: { name: string }) => tool.name === "revoke_share");
    expect(Object.keys(revokeShareTool.inputSchema.properties)).toEqual(["shareId", "url", "token"]);
    const getNoteTool = tools.find((tool: { name: string }) => tool.name === "get_note");
    expect(getNoteTool.description).toContain("truncated=true 表示候选未列全");
    expect(getNoteTool.inputSchema.properties.includeDeleted.description).toContain("按 noteId 读取回收站笔记不需要此参数");

    const validOriginRequest = modernMcpRequest("tools/list", 2);
    validOriginRequest.headers.set("Origin", "https://notes.example.com");
    const validOrigin = await callMcp(validOriginRequest, environment);
    expect(validOrigin.response.status).toBe(200);
  });

  test("provides server-level usage instructions during discovery", async () => {
    const discovered = await callMcp(modernMcpRequest("server/discover", 1), { ...credentials, XIANGYING_MCP_TOKEN: token });
    expect(discovered.response.status).toBe(200);
    expect(resultOf(discovered.body!).instructions).toContain("单篇写操作可省略 version");
    expect(resultOf(discovered.body!).instructions).toContain("create_notebook");
    expect(resultOf(discovered.body!).instructions).toContain("换行写作 \\n");
    expect(resultOf(discovered.body!).instructions).toContain("工具参数必须是 JSON 对象");
    expect(resultOf(discovered.body!).instructions).toContain("客户端会先校验参数");
    expect(resultOf(discovered.body!).instructions).toContain("list_trash");
    expect(resultOf(discovered.body!).instructions).toContain("create_notebook 创建笔记本");
    expect(resultOf(discovered.body!).instructions).toContain("update_notebook");
    expect(resultOf(discovered.body!).instructions).toContain("delete_notebook");
    expect(resultOf(discovered.body!).instructions).toContain("get_notes_batch");
    expect(resultOf(discovered.body!).instructions).toContain("MCP 不提供永久删除笔记或清空回收站");
    expect(resultOf(discovered.body!).instructions).toContain("note_operation");
    expect(resultOf(discovered.body!).instructions).toContain("note_operation 的 set_tags 必须显式传 mode=replace、add 或 remove");
    expect(resultOf(discovered.body!).instructions).toContain("create_share 创建 7 天只读链接");
    expect(resultOf(discovered.body!).instructions).toContain("list_shares 分页查看");
    expect(resultOf(discovered.body!).instructions).toContain("revoke_share 撤销");
    expect(resultOf(discovered.body!).instructions).toContain("不构成同一时刻快照");
    expect(resultOf(discovered.body!).instructions).toContain("普通笔记应优先在 create_note 一次写入完整正文");
    expect(resultOf(discovered.body!).instructions).toContain("超过约 8,000 个 Unicode 字符");
    expect(resultOf(discovered.body!).instructions).toContain("保留字面井号");
    expect(resultOf(discovered.body!).instructions).toContain("contentLength 与批量读取字符预算按 Unicode code points 计算");
  });

  test("keeps tag and color validation on the server without publishing regex patterns", async () => {
    const environment = { ...credentials, XIANGYING_MCP_TOKEN: token };
    const listed = await callMcp(modernMcpRequest("tools/list", 1), environment);
    const tools = resultOf(listed.body!).tools as Array<{ name: string; inputSchema: Record<string, any> }>;
    const search = tools.find((tool) => tool.name === "search_notes")!;
    expect(search.inputSchema.properties.tag).toMatchObject({ type: "string", minLength: 1, maxLength: 40 });
    expect(search.inputSchema.properties.tag.pattern).toBeUndefined();

    const invalidSearchTag = await callTool("search_notes", { tag: "bad tag" }, 2, environment);
    expect(toolData(invalidSearchTag.body!).error.code).toBe("INVALID_TAG_FILTER");

    const invalidCreateTag = await callTool("create_note", {
      title: "非法标签不会写入",
      contentMarkdown: "正文",
      tags: ["bad tag"],
    }, 3, environment);
    expect(toolData(invalidCreateTag.body!).error.code).toBe("INVALID_TAGS");

    const invalidNotebookColor = await callTool("create_notebook", {
      name: "非法颜色校验",
      color: "#GGGGGG",
    }, 4, environment);
    expect(toolData(invalidNotebookColor.body!).error.code).toBe("INVALID_NOTEBOOK");
  });

  test("redacts MCP path tokens from application error log paths", () => {
    expect(redactSensitivePath(`${MCP_PATH}/${token}`)).toBe(`${MCP_PATH}/[REDACTED]`);
    expect(redactSensitivePath(`${MCP_PATH}/${token}/extra`)).toBe(`${MCP_PATH}/[REDACTED]/extra`);
  });

  test("creates, inspects, and revokes public share links through MCP", async () => {
    const environment = { ...credentials, XIANGYING_MCP_TOKEN: token, PUBLIC_URL: "https://notes.example.com" };
    const note = toolData((await callTool("create_note", {
      title: "MCP 分享生命周期",
      contentMarkdown: "分享中的当前内容",
    }, 1, environment)).body!).note;

    const created = await callTool("create_share", { noteId: note.id }, 2, environment);
    expect(created.response.status).toBe(200);
    const share = toolData(created.body!).share;
    expect(share.url.startsWith("https://notes.example.com/share/")).toBe(true);
    expect(share.createdAtISO).toBe(new Date(share.createdAt * 1000).toISOString());
    expect(share.expiresAtISO).toBe(new Date(share.expiresAt * 1000).toISOString());

    const shares = toolData((await callTool("list_shares", { noteId: note.id }, 3, environment)).body!).shares;
    expect(shares).toHaveLength(1);
    expect(shares[0]).toMatchObject({ id: share.id, noteId: note.id, revokedAt: null });
    expect(shares[0].url).toBeUndefined();

    const publicToken = new URL(share.url).pathname.split("/").at(-1)!;
    const publiclyReadable = await request(`/api/shares/${publicToken}`, {}, environment);
    expect(publiclyReadable.response.status).toBe(200);
    expect(publiclyReadable.body?.note.contentMarkdown).toBe("分享中的当前内容");

    const revoked = await callTool("revoke_share", { shareId: share.id }, 4, environment);
    const revokeResult = toolData(revoked.body!);
    expect(revokeResult).toMatchObject({ ok: true, noop: false, share: { id: share.id, revokedAt: expect.any(Number) } });
    expect(typeof revokeResult.share.revokedAtISO).toBe("string");
    const revokedAgain = await callTool("revoke_share", { url: share.url }, 5, environment);
    expect(toolData(revokedAgain.body!)).toMatchObject({ ok: true, noop: true, share: { id: share.id, revokedAt: revokeResult.share.revokedAt } });
    const afterRevoke = toolData((await callTool("list_shares", { noteId: note.id }, 6, environment)).body!).shares;
    expect(typeof afterRevoke[0].revokedAtISO).toBe("string");

    const noLongerPublic = await request(`/api/shares/${publicToken}`, {}, environment);
    expect(noLongerPublic.response.status).toBe(410);
    expect(noLongerPublic.body?.error.code).toBe("SHARE_REVOKED");

    const secondShare = toolData((await callTool("create_share", { noteId: note.id }, 7, environment)).body!).share;
    const tokenOnly = new URL(secondShare.url).pathname.split("/").at(-1)!;
    const otherOwner = await callTool("revoke_share", { token: tokenOnly }, 8, {
      XIANGYING_USERNAME: "other-owner",
      XIANGYING_PASSWORD: "another long passphrase 5678",
      XIANGYING_MCP_TOKEN: token,
    });
    expect(toolData(otherOwner.body!).error.code).toBe("SHARE_NOT_FOUND");
    const revokedByToken = await callTool("revoke_share", { token: tokenOnly }, 9, environment);
    expect(toolData(revokedByToken.body!)).toMatchObject({ ok: true, noop: false, share: { id: secondShare.id } });
    const invalidSelector = await callTool("revoke_share", { shareId: share.id, url: share.url }, 10, environment);
    expect(toolData(invalidSelector.body!).error.code).toBe("INVALID_SHARE_SELECTOR");
  });

  test("paginates share history and rechecks trash state after token hashing", async () => {
    const environment = { ...credentials, XIANGYING_MCP_TOKEN: token, PUBLIC_URL: "https://notes.example.com" };
    const note = toolData((await callTool("create_note", { title: "分享分页与并发删除", contentMarkdown: "正文" }, 1, environment)).body!).note;
    for (let index = 0; index < 3; index += 1) {
      expect((await callTool("create_share", { noteId: note.id }, 2 + index, environment)).response.status).toBe(200);
    }

    const firstPage = toolData((await callTool("list_shares", { noteId: note.id, limit: 2 }, 5, environment)).body!);
    expect(firstPage.shares).toHaveLength(2);
    expect(firstPage.hasMore).toBe(true);
    expect(typeof firstPage.nextCursor).toBe("string");
    const secondPage = toolData((await callTool("list_shares", { noteId: note.id, limit: 2, cursor: firstPage.nextCursor }, 6, environment)).body!);
    expect(secondPage.shares).toHaveLength(1);
    expect(secondPage.hasMore).toBe(false);
    expect(secondPage.nextCursor).toBeNull();
    expect(new Set([...firstPage.shares, ...secondPage.shares].map((share: { id: string }) => share.id)).size).toBe(3);

    const user = database.query("SELECT id, username FROM users WHERE username = ?").get(credentials.XIANGYING_USERNAME) as { id: string; username: string };
    const legacyList = await handleNoteShares(database, user, note.id, "GET", new URL("https://notes.example.com/api/notes"), environment);
    const legacyBody = await legacyList.json() as { shares: unknown[]; nextCursor?: unknown };
    expect(legacyBody.shares).toHaveLength(3);
    expect(legacyBody).not.toHaveProperty("nextCursor");
    // handleNoteShares runs synchronously through the initial read, then yields for token hashing.
    const pendingShare = handleNoteShares(database, user, note.id, "POST", new URL("https://notes.example.com/api/notes"), environment);
    database.query("UPDATE notes SET deleted_at = ?, version = version + 1 WHERE id = ? AND user_id = ?").run(Math.floor(Date.now() / 1000), note.id, user.id);
    const rejected = await pendingShare;
    expect(rejected.status).toBe(409);
    expect((await rejected.json() as { error: { code: string } }).error.code).toBe("NOTE_IN_TRASH");
    expect(database.query("SELECT COUNT(*) AS count FROM shares WHERE note_id = ?").get(note.id)).toMatchObject({ count: 3 });
  });

  test("creates, renames, and deletes a notebook while preserving its notes", async () => {
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
    const createdNote = toolData(note.body!).note;
    expect(createdNote.notebookId).toBe(notebook.id);
    expect(toolData(note.body!).note.contentMarkdown).toBeUndefined();

    const renamed = await callTool("update_notebook", {
      notebookId: notebook.id,
      name: "MCP 项目资料（已重命名）",
      color: "#62776a",
    }, 3, environment);
    expect(toolData(renamed.body!).notebook).toMatchObject({
      id: notebook.id,
      name: "MCP 项目资料（已重命名）",
      color: "#62776a",
    });

    const withoutConfirmation = await callTool("delete_notebook", { notebookId: notebook.id }, 4, environment);
    expect(resultOf(withoutConfirmation.body!).isError).toBe(true);

    const wrongCount = await callTool("delete_notebook", { notebookId: notebook.id, confirm: true, expectedNoteCount: 99 }, 4, environment);
    expect(toolData(wrongCount.body!).error.code).toBe("NOTEBOOK_COUNT_MISMATCH");

    const deleted = await callTool("delete_notebook", { notebookId: notebook.id, confirm: true }, 4, environment);
    expect(toolData(deleted.body!)).toMatchObject({ ok: true, movedCount: 1, versionsInvalidated: true });
    const preservedNote = toolData((await callTool("get_note", { noteId: createdNote.id }, 5, environment)).body!).note;
    expect(preservedNote.notebookId).not.toBe(notebook.id);
    expect(preservedNote.notebookName).toBe("收件箱");
    const inboxes = toolData((await callTool("list_notebooks", {}, 6, environment)).body!).notebooks;
    expect(inboxes.some((entry: { id: string }) => entry.id === notebook.id)).toBe(false);
    expect(inboxes[0].updatedAtISO).toBe(new Date(inboxes[0].updatedAt * 1000).toISOString());

    const systemNotebook = inboxes.find((entry: { isSystem: boolean }) => entry.isSystem);
    const rejectedDeletion = await callTool("delete_notebook", { notebookId: systemNotebook.id, confirm: true }, 7, environment);
    expect(resultOf(rejectedDeletion.body!).isError).toBe(true);
    expect(toolData(rejectedDeletion.body!).error.code).toBe("SYSTEM_NOTEBOOK");

    const missingNotebookCreate = await callTool("create_note", { title: "缺失笔记本", notebookId: "missing-notebook-id" }, 8, environment);
    expect(toolData(missingNotebookCreate.body!).error).toMatchObject({ code: "NOT_FOUND", target: "notebook", legacyCode: "NOTEBOOK_NOT_FOUND" });
    const existingNote = toolData((await callTool("create_note", { title: "笔记本错误码一致性" }, 9, environment)).body!).note;
    const missingNotebookUpdate = await callTool("note_operation", {
      action: "move",
      noteId: existingNote.id,
      version: existingNote.version,
      notebookId: "missing-notebook-id",
    }, 10, environment);
    expect(toolData(missingNotebookUpdate.body!).error).toMatchObject({ code: "NOT_FOUND", target: "notebook", legacyCode: "NOTEBOOK_NOT_FOUND" });
  });

  test("confirms notebook deletion against totalCount including trashed notes", async () => {
    const environment = { ...credentials, XIANGYING_MCP_TOKEN: token };
    const notebook = toolData((await callTool("create_notebook", { name: "含回收站笔记的笔记本" }, 1, environment)).body!).notebook;
    const created = toolData((await callTool("create_note", { title: "已删除的笔记", notebookId: notebook.id }, 2, environment)).body!).note;
    const deleted = await callTool("note_operation", { action: "trash", noteId: created.id, version: created.version }, 3, environment);
    const trashed = toolData(deleted.body!).note;

    const listed = toolData((await callTool("list_notebooks", {}, 4, environment)).body!).notebooks;
    const listedNotebook = listed.find((item: { id: string }) => item.id === notebook.id);
    expect(listedNotebook).toMatchObject({ count: 0, totalCount: 1 });

    const wrongCount = await callTool("delete_notebook", {
      notebookId: notebook.id,
      confirm: true,
      expectedNoteCount: listedNotebook.count,
    }, 5, environment);
    expect(toolData(wrongCount.body!).error).toMatchObject({
      code: "NOTEBOOK_COUNT_MISMATCH",
      actualCount: 1,
      expectedNoteCount: 0,
    });
    expect(toolData((await callTool("list_notebooks", {}, 6, environment)).body!).notebooks.some((item: { id: string }) => item.id === notebook.id)).toBe(true);

    const deletedNotebook = await callTool("delete_notebook", {
      notebookId: notebook.id,
      confirm: true,
      expectedNoteCount: listedNotebook.totalCount,
    }, 7, environment);
    expect(toolData(deletedNotebook.body!)).toMatchObject({ ok: true, movedCount: 1 });
    const movedNote = toolData((await callTool("get_note", { noteId: trashed.id }, 8, environment)).body!).note;
    expect(movedNote.notebookId).not.toBe(notebook.id);
    expect(movedNote.isDeleted).toBe(true);
  });

  test("adds requested tags on a clean line after trailing newlines", async () => {
    const environment = { ...credentials, XIANGYING_MCP_TOKEN: token };
    const trailingNewline = await callTool("create_note", {
      title: "标签换行格式",
      contentMarkdown: "正文末行\n",
      tags: ["格式标签"],
      includeContent: true,
    }, 1, environment);
    expect(toolData(trailingNewline.body!).note.contentMarkdown).toBe("正文末行\n#格式标签");

    const trailingWhitespace = await callTool("create_note", {
      title: "标签尾随空白格式",
      contentMarkdown: "正文末行\n  \t",
      tags: ["格式标签"],
      includeContent: true,
    }, 2, environment);
    expect(toolData(trailingWhitespace.body!).note.contentMarkdown).toBe("正文末行\n#格式标签");
  });

  test("appends, inserts by unique anchor, lists trash, and restores soft-deleted notes", async () => {
    const environment = { ...credentials, XIANGYING_MCP_TOKEN: token };
    const created = await callTool("create_note", { title: "追加与删除测试", contentMarkdown: "原有正文" }, 1, environment);
    const note = toolData(created.body!).note;
    expect(note.contentMarkdown).toBeUndefined();
    expect(note.isDeleted).toBe(false);

    const appended = await callTool("append_to_note", {
      noteId: note.id,
      version: note.version,
      contentMarkdown: "\n追加内容",
    }, 2, environment);
    const appendResult = toolData(appended.body!).note;
    expect(appendResult.version).toBe(2);
    expect(appendResult.contentMarkdown).toBeUndefined();
    expect(toolData((await callTool("get_note", { noteId: note.id }, 3, environment)).body!).note.contentMarkdown).toBe("原有正文\n追加内容");

    const inserted = await callTool("insert_into_note", {
      noteId: note.id,
      version: appendResult.version,
      anchor: "原有正文",
      contentMarkdown: "\n锚点插入",
      position: "after",
    }, 4, environment);
    const insertedNote = toolData(inserted.body!).note;
    expect(insertedNote.version).toBe(3);
    expect(toolData((await callTool("get_note", { noteId: note.id }, 5, environment)).body!).note.contentMarkdown).toBe("原有正文\n锚点插入\n追加内容");

    const duplicateAnchor = await callTool("insert_into_note", {
      noteId: note.id,
      version: insertedNote.version,
      anchor: "\n",
      contentMarkdown: "不应插入",
    }, 6, environment);
    expect(resultOf(duplicateAnchor.body!).isError).toBe(true);
    expect(toolData(duplicateAnchor.body!).error.code).toBe("AMBIGUOUS_MATCH");
    expect(toolData(duplicateAnchor.body!).error.target).toBe("anchor");
    expect(toolData(duplicateAnchor.body!).error.matchCount).toBe(2);
    expect(toolData(duplicateAnchor.body!).error.matches).toHaveLength(2);

    const staleInsert = await callTool("insert_into_note", {
      noteId: note.id,
      version: appendResult.version,
      anchor: "当前正文中不存在",
      contentMarkdown: "不应插入",
    }, 7, environment);
    expect(toolData(staleInsert.body!).error.code).toBe("VERSION_CONFLICT");

    const deleted = await callTool("note_operation", { action: "trash", noteId: note.id, version: insertedNote.version }, 8, environment);
    const deletedNote = toolData(deleted.body!).note;
    expect(deletedNote.deletedAt).not.toBeNull();
    expect(deletedNote.version).toBe(4);
    const deletedAgain = await callTool("note_operation", { action: "trash", noteId: note.id, version: deletedNote.version }, 9, environment);
    expect(toolData(deletedAgain.body!)).toMatchObject({ noop: true, note: { version: deletedNote.version, deletedAt: deletedNote.deletedAt } });
    const trash = await callTool("list_trash", { limit: 5, previewLength: 20 }, 10, environment);
    const trashedNote = toolData(trash.body!).notes.find((entry: { id: string }) => entry.id === note.id);
    expect(trashedNote).toMatchObject({ id: note.id, deletedAt: deletedNote.deletedAt, version: deletedNote.version });
    expect(trashedNote.updatedAtISO).toBe(new Date(trashedNote.updatedAt * 1000).toISOString());
    expect(Array.from(trashedNote.preview).length).toBeLessThanOrEqual(20);
    const reread = await callTool("get_note", { noteId: note.id }, 11, environment);
    expect(toolData(reread.body!).note.deletedAt).not.toBeNull();
    expect(toolData(reread.body!).note.isDeleted).toBe(true);
    const restored = await callTool("note_operation", { action: "restore", noteId: note.id, version: deletedNote.version }, 12, environment);
    const restoredNote = toolData(restored.body!).note;
    expect(restoredNote.deletedAt).toBeNull();
    expect(restoredNote.isDeleted).toBe(false);
    const alreadyRestored = await callTool("note_operation", { action: "restore", noteId: note.id, version: restoredNote.version }, 13, environment);
    expect(toolData(alreadyRestored.body!).noop).toBe(true);
    expect(toolData(alreadyRestored.body!).note.version).toBe(restoredNote.version);
  });

  test("batch restore supports deleted:false and marks repeated batch deletes as no-op", async () => {
    const environment = { ...credentials, XIANGYING_MCP_TOKEN: token };
    const first = toolData((await callTool("create_note", { title: "批量恢复甲" }, 1, environment)).body!).note;
    const second = toolData((await callTool("create_note", { title: "批量恢复乙" }, 2, environment)).body!).note;
    const trashedFirst = toolData((await callTool("note_operation", { action: "trash", noteId: first.id, version: first.version }, 3, environment)).body!).note;
    const trashedSecond = toolData((await callTool("note_operation", { action: "trash", noteId: second.id, version: second.version }, 4, environment)).body!).note;
    const notes = [trashedFirst, trashedSecond].map((note) => ({ noteId: note.id, version: note.version }));

    const repeatedDelete = await callTool("batch_update_notes", { notes, deleted: true }, 5, environment);
    const repeatedDeleteData = toolData(repeatedDelete.body!);
    expect(repeatedDeleteData.updatedCount).toBe(2);
    expect(repeatedDeleteData.results.map((result: Record<string, any>) => result.noop)).toEqual([true, true]);
    expect(repeatedDeleteData.results.map((result: Record<string, any>) => result.note.version)).toEqual([trashedFirst.version, trashedSecond.version]);

    const restored = await callTool("batch_update_notes", { notes, deleted: false }, 6, environment);
    const restoredData = toolData(restored.body!);
    expect(restoredData).toMatchObject({ updatedCount: 2, failedCount: 0 });
    expect(restoredData.results.map((result: Record<string, any>) => result.note.deletedAt)).toEqual([null, null]);
    expect(restoredData.results.map((result: Record<string, any>) => result.note.version)).toEqual([trashedFirst.version + 1, trashedSecond.version + 1]);
  });

  test("inserts separate lines at line boundaries and supports selecting an occurrence", async () => {
    const environment = { ...credentials, XIANGYING_MCP_TOKEN: token };
    const created = await callTool("create_note", {
      title: "按行插入",
      contentMarkdown: "开头\n锚点\n结尾\n行内锚点后缀",
    }, 1, environment);
    const note = toolData(created.body!).note;

    const before = await callTool("insert_into_note", {
      noteId: note.id,
      anchor: "锚点",
      occurrence: 1,
      contentMarkdown: "插入前",
      position: "before",
    }, 2, environment);
    expect(toolData(before.body!).note.version).toBe(2);

    const after = await callTool("insert_into_note", {
      noteId: note.id,
      anchor: "锚点",
      occurrence: 1,
      contentMarkdown: "插入后",
      position: "after",
    }, 3, environment);
    expect(toolData(after.body!).note.version).toBe(3);

    const inline = await callTool("insert_into_note", {
      noteId: note.id,
      anchor: "锚点",
      occurrence: 2,
      contentMarkdown: "-行内-",
      position: "after",
      includeContent: true,
    }, 4, environment);
    expect(toolData(inline.body!).note.contentMarkdown).toBe("开头\n插入前\n锚点\n插入后\n结尾\n行内锚点-行内-后缀");
  });

  test("unifies low-frequency note operations and makes favorite setting idempotent", async () => {
    const environment = { ...credentials, XIANGYING_MCP_TOKEN: token };
    const notebook = toolData((await callTool("create_notebook", { name: "专用工具目标" }, 1, environment)).body!).notebook;
    const created = await callTool("create_note", {
      title: "专用操作样本",
      contentMarkdown: "正文 #旧标签\n代码示例 `#代码标签`",
    }, 2, environment);
    let note = toolData(created.body!).note;

    const missingMoveTarget = await callTool("note_operation", { action: "move", noteId: note.id, version: note.version }, 2, environment);
    expect(toolData(missingMoveTarget.body!).error.code).toBe("INVALID_NOTE_OPERATION");
    const unexpectedTrashField = await callTool("note_operation", {
      action: "trash", noteId: note.id, version: note.version, isFavorite: true,
    }, 2, environment);
    expect(toolData(unexpectedTrashField.body!).error.code).toBe("INVALID_NOTE_OPERATION");

    const tagged = await callTool("note_operation", { action: "set_tags", noteId: note.id, version: note.version, tags: ["新标签"], mode: "replace" }, 3, environment);
    note = toolData(tagged.body!).note;
    expect(note.tags).toEqual(["新标签"]);
    expect(note.contentMarkdown).toBeUndefined();
    let fullNote = toolData((await callTool("get_note", { noteId: note.id }, 4, environment)).body!).note;
    expect(fullNote.contentMarkdown).toBe("正文\n代码示例 `#代码标签`\n#新标签");
    expect(fullNote.updatedAtISO).toBe(new Date(fullNote.updatedAt * 1000).toISOString());

    const favorited = await callTool("note_operation", { action: "set_favorite", noteId: note.id, version: note.version, isFavorite: true }, 5, environment);
    note = toolData(favorited.body!).note;
    expect(note.isFavorite).toBe(true);
    const favoritedVersion = note.version;

    const autoVersionFavorite = await callTool("note_operation", { action: "set_favorite", noteId: note.id, isFavorite: false }, 55, environment);
    note = toolData(autoVersionFavorite.body!).note;
    expect(note.isFavorite).toBe(false);
    expect(note.version).toBe(favoritedVersion + 1);
    const refavorited = await callTool("note_operation", { action: "set_favorite", noteId: note.id, isFavorite: true }, 56, environment);
    note = toolData(refavorited.body!).note;
    expect(note.version).toBe(favoritedVersion + 2);
    const favoriteAgain = await callTool("note_operation", { action: "set_favorite", noteId: note.id, version: note.version, isFavorite: true }, 6, environment);
    note = toolData(favoriteAgain.body!).note;
    expect(note.isFavorite).toBe(true);
    expect(note.version).toBe(favoritedVersion + 2);
    const staleFavorite = await callTool("note_operation", { action: "set_favorite", noteId: note.id, version: fullNote.version, isFavorite: false }, 7, environment);
    expect(toolData(staleFavorite.body!).error.code).toBe("VERSION_CONFLICT");

    const moved = await callTool("note_operation", { action: "move", noteId: note.id, version: note.version, notebookId: notebook.id }, 8, environment);
    note = toolData(moved.body!).note;
    expect(note.notebookId).toBe(notebook.id);
    expect(note.isFavorite).toBe(true);

    const cleared = await callTool("note_operation", { action: "set_tags", noteId: note.id, version: note.version, tags: [], mode: "replace" }, 9, environment);
    note = toolData(cleared.body!).note;
    expect(note.tags).toEqual([]);
    fullNote = toolData((await callTool("get_note", { noteId: note.id }, 10, environment)).body!).note;
    expect(fullNote.contentMarkdown).toBe("正文\n代码示例 `#代码标签`");

    const trashedResult = await callTool("note_operation", { action: "trash", noteId: note.id, version: fullNote.version }, 11, environment);
    const trashedNote = toolData(trashedResult.body!).note;
    const favoriteRejected = await callTool("note_operation", { action: "set_favorite", noteId: note.id, version: trashedNote.version, isFavorite: false }, 12, environment);
    expect(toolData(favoriteRejected.body!).error.code).toBe("NOTE_IN_TRASH");
    const tagsRejected = await callTool("note_operation", { action: "set_tags", noteId: note.id, version: trashedNote.version, tags: ["不应写入"], mode: "replace" }, 13, environment);
    expect(toolData(tagsRejected.body!).error.code).toBe("NOTE_IN_TRASH");
    const batchRejected = await callTool("batch_update_notes", {
      notes: [{ noteId: note.id, version: trashedNote.version }],
      isFavorite: false,
      tags: ["不应写入"],
    }, 14, environment);
    expect(toolData(batchRejected.body!).results[0].error.code).toBe("NOTE_IN_TRASH");
    const updateRejected = await callTool("update_note", {
      noteId: note.id,
      version: trashedNote.version,
      title: "不应改标题",
      contentMarkdown: "不应改正文",
    }, 15, environment);
    expect(toolData(updateRejected.body!).error.code).toBe("NOTE_IN_TRASH");
    const appendRejected = await callTool("append_to_note", { noteId: note.id, version: trashedNote.version, contentMarkdown: "不应追加" }, 16, environment);
    expect(toolData(appendRejected.body!).error.code).toBe("NOTE_IN_TRASH");
    const replaceRejected = await callTool("replace_in_note", { noteId: note.id, version: trashedNote.version, oldText: "不存在的正文片段", newText: "不应替换" }, 17, environment);
    expect(toolData(replaceRejected.body!).error.code).toBe("NOTE_IN_TRASH");
    const insertRejected = await callTool("insert_into_note", { noteId: note.id, version: trashedNote.version, anchor: "不存在的锚点", contentMarkdown: "不应插入" }, 18, environment);
    expect(toolData(insertRejected.body!).error.code).toBe("NOTE_IN_TRASH");
    const moveRejected = await callTool("note_operation", { action: "move", noteId: note.id, version: trashedNote.version, notebookId: "another-notebook" }, 19, environment);
    expect(toolData(moveRejected.body!).error.code).toBe("NOTE_IN_TRASH");
    const batchMoveRejected = await callTool("batch_update_notes", {
      notes: [{ noteId: note.id, version: trashedNote.version }],
      notebookId: "another-notebook",
    }, 20, environment);
    expect(toolData(batchMoveRejected.body!).results[0].error.code).toBe("NOTE_IN_TRASH");
    const unchanged = toolData((await callTool("get_note", { noteId: note.id }, 21, environment)).body!).note;
    expect(unchanged).toMatchObject({ isDeleted: true, version: trashedNote.version, isFavorite: true, tags: [] });
    const restored = toolData((await callTool("note_operation", { action: "restore", noteId: note.id, version: trashedNote.version }, 22, environment)).body!).note;
    expect(restored.isDeleted).toBe(false);
  });

  test("batch reads full notes with a bounded result count and reports missing IDs", async () => {
    const environment = { ...credentials, XIANGYING_MCP_TOKEN: token };
    const first = toolData((await callTool("create_note", { title: "批量读取甲", contentMarkdown: "甲正文\n完整内容" }, 1, environment)).body!).note;
    const second = toolData((await callTool("create_note", { title: "批量读取乙", contentMarkdown: "乙正文完整内容" }, 2, environment)).body!).note;
    const third = toolData((await callTool("create_note", { title: "批量读取丙", contentMarkdown: "丙正文完整内容" }, 3, environment)).body!).note;
    const small = toolData((await callTool("create_note", { title: "短正文笔记", contentMarkdown: "小" }, 4, environment)).body!).note;

    const limited = await callTool("get_notes_batch", { noteIds: [first.id, second.id, third.id], limit: 2 }, 4, environment);
    const limitedData = toolData(limited.body!);
    expect(limitedData.notes).toHaveLength(2);
    expect(limitedData.notes[0].contentMarkdown).toBe("甲正文\n完整内容");
    expect(limitedData.notes[1].contentMarkdown).toBe("乙正文完整内容");
    expect(limitedData.notes[0].preview).toBeUndefined();
    expect(limitedData.totalContentCharacters).toBe(Array.from("甲正文\n完整内容乙正文完整内容").length);
    expect(limitedData).toMatchObject({ checkedCount: 2, uncheckedCount: 1, skippedForCharacterLimit: false });
    expect(limitedData).not.toHaveProperty("stoppedForCharacterLimit");
    expect(limitedData.notes[0].updatedAtISO).toBe(new Date(limitedData.notes[0].updatedAt * 1000).toISOString());
    expect(limitedData.remainingIds).toEqual([third.id]);

    const notYetChecked = await callTool("get_notes_batch", { noteIds: [first.id, "missing-but-not-checked"], limit: 1 }, 7, environment);
    expect(toolData(notYetChecked.body!).remainingIds).toEqual(["missing-but-not-checked"]);
    expect(toolData(notYetChecked.body!).notFoundIds).toEqual([]);
    expect(toolData(notYetChecked.body!)).toMatchObject({ checkedCount: 1, uncheckedCount: 1 });

    const filledPastMissing = await callTool("get_notes_batch", {
      noteIds: ["missing-before-result", first.id, second.id],
      limit: 1,
    }, 71, environment);
    expect(toolData(filledPastMissing.body!)).toMatchObject({
      returnedCount: 1,
      checkedCount: 2,
      uncheckedCount: 1,
      notFoundIds: ["missing-before-result"],
      remainingIds: [second.id],
    });
    expect(toolData(filledPastMissing.body!).notes[0].id).toBe(first.id);

    const characterLimited = await callTool("get_notes_batch", {
      noteIds: [first.id, second.id, small.id],
      limit: 3,
      maxTotalCharacters: Array.from("甲正文\n完整内容小").length,
    }, 8, environment);
    const characterLimitedData = toolData(characterLimited.body!);
    expect(characterLimitedData.notes.map((note: { id: string }) => note.id)).toEqual([first.id, small.id]);
    expect(characterLimitedData.totalContentCharacters).toBe(Array.from("甲正文\n完整内容小").length);
    expect(characterLimitedData.remainingIds).toEqual([second.id]);
    expect(characterLimitedData.oversizedIds).toEqual([second.id]);
    expect(characterLimitedData).toMatchObject({ checkedCount: 3, uncheckedCount: 0, skippedForCharacterLimit: true });
    expect(characterLimitedData).not.toHaveProperty("stoppedForCharacterLimit");

    const firstExceedsBudget = await callTool("get_notes_batch", {
      noteIds: [first.id, small.id],
      maxTotalCharacters: 1,
    }, 9, environment);
    const firstExceedsBudgetData = toolData(firstExceedsBudget.body!);
    expect(firstExceedsBudgetData.notes.map((note: { id: string }) => note.id)).toEqual([small.id]);
    expect(firstExceedsBudgetData.oversizedIds).toEqual([first.id]);
    expect(firstExceedsBudgetData.remainingIds).toEqual([first.id]);
    expect(firstExceedsBudgetData).toMatchObject({ returnedCount: 1, checkedCount: 2, uncheckedCount: 0, totalContentCharacters: 1 });

    const remainder = await callTool("get_notes_batch", { noteIds: [third.id, "missing-note-id"], limit: 2 }, 10, environment);
    expect(toolData(remainder.body!).notes[0].contentMarkdown).toBe("丙正文完整内容");
    expect(toolData(remainder.body!).notFoundIds).toEqual(["missing-note-id"]);
    expect(toolData(remainder.body!)).toMatchObject({ checkedCount: 2, uncheckedCount: 0 });
  });

  test("appends before trailing tags to preserve the tag footer", async () => {
    const environment = { ...credentials, XIANGYING_MCP_TOKEN: token };
    const created = await callTool("create_note", {
      title: "标签行末尾追加",
      contentMarkdown: "第一行\n第二行",
      tags: ["乙标签"],
      includeContent: true,
    }, 1, environment);
    const note = toolData(created.body!).note;
    expect(note.contentMarkdown).toBe("第一行\n第二行\n#乙标签");

    const appended = await callTool("append_to_note", {
      noteId: note.id,
      version: note.version,
      contentMarkdown: "第三行（追加）",
      includeContent: true,
    }, 2, environment);
    const updated = toolData(appended.body!).note;
    expect(updated.contentMarkdown).toBe("第一行\n第二行\n第三行（追加）\n#乙标签");
    expect(updated.tags).toEqual(["乙标签"]);
  });

  test("removes tags without replacing the body and ignores stale inline-code tag indexes", async () => {
    const environment = { ...credentials, XIANGYING_MCP_TOKEN: token };
    const created = await callTool("create_note", {
      title: "标签清理与代码示例",
      contentMarkdown: "正文 #保留 #移除\n示例 `#代码标签` 和 #移除\n#单独一行标签\n后续内容",
    }, 1, environment);
    const note = toolData(created.body!).note;
    expect(note.tags).toEqual(["保留", "移除", "单独一行标签"]);

    const removed = await callTool("note_operation", {
      action: "set_tags",
      noteId: note.id,
      version: note.version,
      tags: ["保留"],
      mode: "replace",
    }, 2, environment);
    expect(toolData(removed.body!).note.tags).toEqual(["保留"]);
    const read = toolData((await callTool("get_note", { noteId: note.id }, 3, environment)).body!).note;
    expect(read.contentMarkdown).toBe("正文\n示例 `#代码标签` 和\n后续内容\n#保留");
    expect(read.tags).toEqual(["保留"]);

    // Simulate an index created by the earlier parser, which treated code as a tag.
    const user = database.query("SELECT id FROM users WHERE username = ?").get(credentials.XIANGYING_USERNAME) as { id: string };
    database.query("INSERT INTO note_tags (note_id, user_id, tag_normalized, tag, position) VALUES (?, ?, ?, ?, ?)")
      .run(note.id, user.id, "代码标签", "代码标签", 1);
    const codeTagSearch = await callTool("search_notes", { tag: "代码标签" }, 4, environment);
    expect(toolData(codeTagSearch.body!).notes.some((entry: { id: string }) => entry.id === note.id)).toBe(false);
    expect(database.query("SELECT 1 FROM note_tags WHERE note_id = ? AND tag_normalized = ?").get(note.id, "代码标签")).toBeNull();
  });

  test("reads a unique title match and reports ambiguous title matches", async () => {
    const environment = { ...credentials, XIANGYING_MCP_TOKEN: token };
    const exact = await callTool("create_note", { title: "季度复盘", contentMarkdown: "exact" }, 1, environment);
    await callTool("create_note", { title: "季度计划草稿", contentMarkdown: "first" }, 2, environment);
    await callTool("create_note", { title: "季度计划定稿", contentMarkdown: "second" }, 3, environment);

    const byTitle = await callTool("get_note", { title: "季度复盘" }, 4, environment);
    expect(toolData(byTitle.body!).note.id).toBe(toolData(exact.body!).note.id);
    const ambiguous = await callTool("get_note", { title: "季度计划" }, 5, environment);
    expect(resultOf(ambiguous.body!).isError).toBe(true);
    expect(toolData(ambiguous.body!).error.code).toBe("AMBIGUOUS_MATCH");
    expect(toolData(ambiguous.body!).error.target).toBe("title");
    expect(toolData(ambiguous.body!).error.matches).toHaveLength(2);

    await callTool("create_note", { title: "重复标题消歧", contentMarkdown: "候选正文甲，有独特信息" }, 6, environment);
    await callTool("create_note", { title: "重复标题消歧", contentMarkdown: "候选正文乙，另一段信息" }, 7, environment);
    const duplicateTitle = toolData((await callTool("get_note", { title: "重复标题消歧" }, 8, environment)).body!).error;
    expect(duplicateTitle.truncated).toBe(false);
    expect(duplicateTitle.matches).toHaveLength(2);
    expect(duplicateTitle.matches.map((match: { preview: string }) => match.preview)).toContain("候选正文甲，有独特信息");
    expect(duplicateTitle.matches.map((match: { preview: string }) => match.preview)).toContain("候选正文乙，另一段信息");
    expect(typeof duplicateTitle.matches[0].updatedAtISO).toBe("string");
    expect(typeof duplicateTitle.matches[0].createdAtISO).toBe("string");
    for (let index = 0; index < 4; index += 1) {
      await callTool("create_note", { title: "重复标题消歧", contentMarkdown: `后续候选正文${index}` }, 9 + index, environment);
    }
    const truncatedTitle = toolData((await callTool("get_note", { title: "重复标题消歧" }, 13, environment)).body!).error;
    expect(truncatedTitle).toMatchObject({ matchCount: 6, truncated: true });
    expect(truncatedTitle.matches).toHaveLength(5);
  });

  test("batch-updates notebooks and tags, and bounds search results", async () => {
    const environment = { ...credentials, XIANGYING_MCP_TOKEN: token };
    const notebook = toolData((await callTool("create_notebook", { name: "批量资料" }, 1, environment)).body!).notebook;
    const first = toolData((await callTool("create_note", { title: "批量样本甲", contentMarkdown: "searchable marker long preview text" }, 2, environment)).body!).note;
    const second = toolData((await callTool("create_note", { title: "批量样本乙", contentMarkdown: "searchable marker long preview text" }, 3, environment)).body!).note;

    const batch = await callTool("batch_update_notes", {
      notes: [{ noteId: first.id, version: first.version }, { noteId: second.id, version: second.version }],
      notebookId: notebook.id,
      tags: ["batch-tag"],
    }, 4, environment);
    const batchData = toolData(batch.body!);
    expect(batchData.updatedCount).toBe(2);
    expect(batchData.failedCount).toBe(0);

    const search = await callTool("search_notes", { query: "searchable marker", tag: "batch-tag", limit: 1, previewLength: 6 }, 5, environment);
    const searchData = toolData(search.body!);
    expect(searchData.notes).toHaveLength(1);
    expect(Array.from(searchData.notes[0].preview).length).toBeLessThanOrEqual(6);
    expect(typeof searchData.nextCursor).toBe("string");
    expect(searchData.total).toBe(2);

    const removal = await callTool("batch_update_notes", {
      notes: batchData.results.map((entry: { noteId: string; note: { version: number } }) => ({ noteId: entry.noteId, version: entry.note.version })),
      removeTags: ["batch-tag"],
    }, 6, environment);
    expect(toolData(removal.body!).updatedCount).toBe(2);
    const removedSearch = await callTool("search_notes", { tag: "batch-tag" }, 7, environment);
    expect(toolData(removedSearch.body!).notes).toHaveLength(0);

    const currentNotes = toolData(removal.body!).results.map((entry: { noteId: string; note: { version: number } }) => ({ noteId: entry.noteId, version: entry.note.version }));
    const replacedTags = await callTool("batch_update_notes", { notes: currentNotes, replaceTags: ["统一标签", "迁移标签"] }, 8, environment);
    expect(toolData(replacedTags.body!).updatedCount).toBe(2);
    const replacementResults = toolData(replacedTags.body!).results;
    expect(replacementResults.every((entry: { note: { tags: string[] } }) => JSON.stringify(entry.note.tags) === JSON.stringify(["统一标签", "迁移标签"]))).toBe(true);
    const incompatible = await callTool("batch_update_notes", {
      notes: replacementResults.map((entry: { noteId: string; note: { version: number } }) => ({ noteId: entry.noteId, version: entry.note.version })),
      replaceTags: ["替换"],
      tags: ["追加"],
    }, 9, environment);
    expect(toolData(incompatible.body!).error.code).toBe("INCOMPATIBLE_TAG_OPERATIONS");
    const cleared = await callTool("batch_update_notes", {
      notes: replacementResults.map((entry: { noteId: string; note: { version: number } }) => ({ noteId: entry.noteId, version: entry.note.version })),
      replaceTags: [],
    }, 10, environment);
    expect(toolData(cleared.body!).updatedCount).toBe(2);
    expect(toolData(cleared.body!).results.every((entry: { note: { tags: string[] } }) => entry.note.tags.length === 0)).toBe(true);
  });

  test("update_note reads the current version when the caller omits it", async () => {
    const environment = { ...credentials, XIANGYING_MCP_TOKEN: token };
    const created = toolData((await callTool("create_note", { title: "自动版本更新", contentMarkdown: "正文保持完整" }, 1, environment)).body!).note;
    const updated = await callTool("update_note", { noteId: created.id, title: "自动版本更新完成" }, 2, environment);
    expect(toolData(updated.body!).note).toMatchObject({ id: created.id, title: "自动版本更新完成", version: created.version + 1 });
    expect(toolData((await callTool("get_note", { noteId: created.id }, 3, environment)).body!).note.contentMarkdown).toBe("正文保持完整");
  });

  test("get_note reads trashed notes by ID without includeDeleted", async () => {
    const environment = { ...credentials, XIANGYING_MCP_TOKEN: token };
    const created = toolData((await callTool("create_note", { title: "按 ID 读取回收站", contentMarkdown: "回收站正文" }, 1, environment)).body!).note;
    const trashed = toolData((await callTool("note_operation", { action: "trash", noteId: created.id, version: created.version }, 2, environment)).body!).note;
    const byId = toolData((await callTool("get_note", { noteId: created.id, includeContent: false }, 3, environment)).body!).note;
    expect(byId).toMatchObject({ id: created.id, version: trashed.version, isDeleted: true, deletedAt: expect.any(Number) });
  });

  test("keeps per-item batch version conflicts bounded while preserving recovery metadata", async () => {
    const environment = { ...credentials, XIANGYING_MCP_TOKEN: token };
    const created = toolData((await callTool("create_note", { title: "批量冲突回执", contentMarkdown: "旧正文" }, 1, environment)).body!).note;
    await callTool("update_note", { noteId: created.id, version: created.version, contentMarkdown: "新正文" }, 2, environment);

    const conflict = await callTool("batch_update_notes", {
      notes: [{ noteId: created.id, version: created.version }],
      isFavorite: true,
    }, 3, environment);
    const data = toolData(conflict.body!);
    expect(data.failedCount).toBe(1);
    expect(data.results[0].error.code).toBe("VERSION_CONFLICT");
    expect(data.results[0].error.current).not.toHaveProperty("contentMarkdown");
    expect(data.results[0].error.current).toMatchObject({ version: 2, contentLength: 3, preview: "新正文" });
  });

  test("treats escaped hashtag text as literal content while keeping real tags searchable", async () => {
    const environment = { ...credentials, XIANGYING_MCP_TOKEN: token };
    const created = await callTool("create_note", {
      title: "井号字面量和标签",
      contentMarkdown: "C\\#Sharp 与话题 \\#技术；实际标签 #可检索",
    }, 1, environment);
    const note = toolData(created.body!).note;
    expect(note.tags).toEqual(["可检索"]);

    expect(toolData((await callTool("search_notes", { tag: "CSharp" }, 2, environment)).body!).notes).toHaveLength(0);
    expect(toolData((await callTool("search_notes", { tag: "技术" }, 3, environment)).body!).notes).toHaveLength(0);
    expect(toolData((await callTool("search_notes", { tag: "可检索" }, 4, environment)).body!).notes.map((entry: { id: string }) => entry.id)).toEqual([note.id]);
  });

  test("replaces one exact text span without returning or resending the full body", async () => {
    const environment = { ...credentials, XIANGYING_MCP_TOKEN: token };
    const originalBody = "报告中的占位符：待修正；其余正文保持原样";
    const created = await callTool("create_note", { title: "局部替换", contentMarkdown: originalBody }, 1, environment);
    const note = toolData(created.body!).note;
    expect(note.contentMarkdown).toBeUndefined();
    expect(note.contentLength).toBe(Array.from(originalBody).length);

    const replaced = await callTool("replace_in_note", {
      noteId: note.id,
      oldText: "待修正",
      newText: "已修正",
    }, 2, environment);
    const replacedNote = toolData(replaced.body!).note;
    expect(replacedNote.version).toBe(2);
    expect(replacedNote.contentMarkdown).toBeUndefined();
    expect(replacedNote.contentLength).toBe(Array.from("报告中的占位符：已修正；其余正文保持原样").length);
    expect(toolData((await callTool("get_note", { noteId: note.id }, 3, environment)).body!).note.contentMarkdown).toBe("报告中的占位符：已修正；其余正文保持原样");

    const stale = await callTool("replace_in_note", {
      noteId: note.id,
      version: note.version,
      oldText: "已修正",
      newText: "再次修正",
    }, 4, environment);
    expect(toolData(stale.body!).error.code).toBe("VERSION_CONFLICT");
    expect(toolData(stale.body!).error.current.contentMarkdown).toBe("报告中的占位符：已修正；其余正文保持原样");

    const forced = await callTool("replace_in_note", {
      noteId: note.id,
      version: note.version,
      force: true,
      oldText: "已修正",
      newText: "最终修正",
    }, 5, environment);
    expect(toolData(forced.body!).note.version).toBe(3);
    expect(toolData((await callTool("get_note", { noteId: note.id }, 6, environment)).body!).note.contentMarkdown).toBe("报告中的占位符：最终修正；其余正文保持原样");
  });

  test("replace_in_note can replace every non-overlapping match in one call", async () => {
    const environment = { ...credentials, XIANGYING_MCP_TOKEN: token };
    const originalBody = "复X、复X、复X";
    const created = toolData((await callTool("create_note", { title: "全局术语替换", contentMarkdown: originalBody }, 1, environment)).body!).note;
    const replaced = await callTool("replace_in_note", { noteId: created.id, oldText: "复X", newText: "统一术语", replaceAll: true }, 2, environment);
    expect(toolData(replaced.body!)).toMatchObject({ replacedCount: 3, note: { version: created.version + 1 } });
    expect(toolData((await callTool("get_note", { noteId: created.id }, 3, environment)).body!).note.contentMarkdown).toBe("统一术语、统一术语、统一术语");

    const invalid = await callTool("replace_in_note", { noteId: created.id, oldText: "统一术语", newText: "不应写入", replaceAll: true, occurrence: 1 }, 4, environment);
    expect(toolData(invalid.body!).error.code).toBe("INVALID_REPLACEMENT_SELECTOR");
    expect(toolData((await callTool("get_note", { noteId: created.id }, 5, environment)).body!).note.contentMarkdown).toBe("统一术语、统一术语、统一术语");

    const short = toolData((await callTool("create_note", { title: "替换扩容上限", contentMarkdown: "xx" }, 6, environment)).body!).note;
    const tooLarge = await callTool("replace_in_note", { noteId: short.id, oldText: "x", newText: "y".repeat(600_000), replaceAll: true }, 7, environment);
    expect(toolData(tooLarge.body!).error.code).toBe("NOTE_TOO_LARGE");
    expect(toolData((await callTool("get_note", { noteId: short.id }, 8, environment)).body!).note.contentMarkdown).toBe("xx");
  });

  test("insert_into_note can insert at every non-overlapping anchor in one call", async () => {
    const environment = { ...credentials, XIANGYING_MCP_TOKEN: token };
    const created = toolData((await callTool("create_note", { title: "全部锚点插入", contentMarkdown: "a--a--a." }, 1, environment)).body!).note;
    const inserted = await callTool("insert_into_note", { noteId: created.id, anchor: "a", contentMarkdown: "X", insertAll: true }, 2, environment);
    expect(toolData(inserted.body!)).toMatchObject({ insertedCount: 3, note: { version: created.version + 1 } });
    expect(toolData((await callTool("get_note", { noteId: created.id }, 3, environment)).body!).note.contentMarkdown).toBe("aX--aX--aX.");

    const invalid = await callTool("insert_into_note", { noteId: created.id, anchor: "a", contentMarkdown: "Y", insertAll: true, occurrence: 1 }, 4, environment);
    expect(toolData(invalid.body!).error.code).toBe("INVALID_INSERTION_SELECTOR");
    expect(toolData((await callTool("get_note", { noteId: created.id }, 5, environment)).body!).note.contentMarkdown).toBe("aX--aX--aX.");
  });

  test("reports bounded match contexts and replaces a requested occurrence", async () => {
    const environment = { ...credentials, XIANGYING_MCP_TOKEN: token };
    const body = "前文 目标 后文\n再前 目标 再后";
    const created = toolData((await callTool("create_note", { title: "重复片段消歧", contentMarkdown: body }, 1, environment)).body!).note;

    const ambiguous = await callTool("replace_in_note", {
      noteId: created.id,
      oldText: "目标",
      newText: "替换",
    }, 2, environment);
    const ambiguousError = toolData(ambiguous.body!).error;
    expect(ambiguousError.code).toBe("AMBIGUOUS_MATCH");
    expect(ambiguousError.target).toBe("text");
    expect(ambiguousError.matchCount).toBe(2);
    expect(ambiguousError.matches).toHaveLength(2);
    expect(ambiguousError.matches[0].before).toContain("前文");
    expect(ambiguousError.matches[1].after).toContain("再后");
    expect(ambiguousError.truncated).toBe(false);

    const replaced = await callTool("replace_in_note", {
      noteId: created.id,
      occurrence: 2,
      oldText: "目标",
      newText: "替换",
      includeContent: true,
    }, 3, environment);
    expect(toolData(replaced.body!).note.contentMarkdown).toBe("前文 目标 后文\n再前 替换 再后");
    expect(toolData(replaced.body!).note.contentLength).toBe(Array.from("前文 目标 后文\n再前 替换 再后").length);

    const missingOccurrence = await callTool("replace_in_note", {
      noteId: created.id,
      occurrence: 3,
      oldText: "目标",
      newText: "不应写入",
    }, 4, environment);
    expect(toolData(missingOccurrence.body!).error.code).toBe("NOT_FOUND");
    expect(toolData(missingOccurrence.body!).error.target).toBe("occurrence");
    expect(toolData(missingOccurrence.body!).error.matchCount).toBe(1);

    const missingText = await callTool("replace_in_note", {
      noteId: created.id,
      oldText: "正文中不存在的片段",
      newText: "不应写入",
    }, 5, environment);
    expect(toolData(missingText.body!).error.code).toBe("NOT_FOUND");
    expect(toolData(missingText.body!).error.target).toBe("text");
  });

  test("supports official chunked writing with a length receipt and returned versions", async () => {
    const environment = { ...credentials, XIANGYING_MCP_TOKEN: token };
    const created = await callTool("create_note", { title: "分段长文骨架" }, 1, environment);
    let note = toolData(created.body!).note;
    expect(note.contentLength).toBe(0);

    const chunks = ["第一段长文内容", "第二段长文内容\n末尾"];
    for (const [index, contentMarkdown] of chunks.entries()) {
      const appended = await callTool("append_to_note", {
        noteId: note.id,
        version: note.version,
        contentMarkdown,
      }, index + 2, environment);
      note = toolData(appended.body!).note;
      expect(note.contentLength).toBe(Array.from(chunks.slice(0, index + 1).join("")).length);
    }
    expect(toolData((await callTool("get_note", { noteId: note.id }, 4, environment)).body!).note.contentMarkdown).toBe(chunks.join(""));
  });

  test("normalizes unescaped control characters and rejects truncated nested JSON", async () => {
    const environment = { ...credentials, XIANGYING_MCP_TOKEN: token };
    const valid = modernMcpRequest("tools/call", 1, {
      name: "create_note",
      arguments: { title: "原始换行", contentMarkdown: "第一行\n第二行" },
    }, "create_note");
    const validText = await valid.clone().text();
    const rawNewline = validText.replace("第一行\\n第二行", "第一行\n第二行");
    expect(rawNewline).not.toBe(validText);
    const created = await callMcp(requestWithBody(valid, rawNewline), environment);
    const createdNote = toolData(created.body!).note;
    expect(toolData((await callTool("get_note", { noteId: createdNote.id }, 2, environment)).body!).note.contentMarkdown).toBe("第一行\n第二行");

    const encodedArguments = modernMcpRequest("tools/call", 3, {
      name: "create_note",
      arguments: JSON.stringify({ title: "序列化参数兼容", contentMarkdown: "内部换行\n保留" }),
    }, "create_note");
    const encodedResult = await callMcp(encodedArguments, environment);
    const encodedNote = toolData(encodedResult.body!).note;
    expect(toolData((await callTool("get_note", { noteId: encodedNote.id }, 4, environment)).body!).note.contentMarkdown).toBe("内部换行\n保留");

    const truncatedArguments = `{"title":"不完整 JSON","contentMarkdown":"第一行\n第二行"`;
    const malformed = modernMcpRequest("tools/call", 5, { name: "create_note", arguments: truncatedArguments }, "create_note");
    const malformedText = await malformed.clone().text();
    const rawControl = malformedText.replace("第一行\\n第二行", "第一行\n第二行");
    const rejected = await callMcp(requestWithBody(malformed, rawControl), environment);
    expect(rejected.response.status).toBe(400);
    expect(rejected.body?.error.message).toContain("字符串中存在未转义的控制字符");
    expect(rejected.body?.error.message).toContain("完整 JSON 对象");

    const oversized = await callMcp(modernMcpRequest("tools/call", 6, {
      name: "create_note",
      arguments: { title: "超长正文", contentMarkdown: "a".repeat(1_000_001) },
    }, "create_note"), environment);
    expect(oversized.response.status).toBe(400);
    expect(oversized.body?.error.message).toContain("超过单次字段 1,000,000 个 UTF-16 code units 上限");
    expect(oversized.body?.error.message).toContain("分段追加仍受单篇笔记正文总长度上限约束");
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
      tags: ["mcp-explicit-tag"],
      includeContent: true,
    }, 2, environment);
    const createdNote = toolData(created.body!).note;
    expect(createdNote.title).toBe("MCP 测试记录");
    expect(createdNote.notebookId).toBe(inbox.id);
    expect(createdNote.version).toBe(1);
    expect(createdNote.contentMarkdown).toContain("#mcp-explicit-tag");
    expect(createdNote.tags).toContain("mcp-explicit-tag");
    expect(createdNote.contentLength).toBe(Array.from(createdNote.contentMarkdown).length);

    const search = await callTool("search_notes", { query: "mcp-test" }, 3, environment);
    expect(toolData(search.body!).notes.map((note: { id: string }) => note.id)).toContain(createdNote.id);
    const tagSearch = await callTool("search_notes", { tag: "mcp-explicit-tag" }, 4, environment);
    expect(toolData(tagSearch.body!).notes.map((note: { id: string }) => note.id)).toContain(createdNote.id);

    const fetched = await callTool("get_note", { noteId: createdNote.id }, 5, environment);
    const fetchedNote = toolData(fetched.body!).note;
    expect(fetchedNote.contentMarkdown).toContain("可搜索正文");
    expect(fetchedNote.version).toBe(1);

    const updated = await callTool("update_note", {
      noteId: createdNote.id,
      version: fetchedNote.version,
      title: "MCP 更新记录",
      contentMarkdown: "更新后的正文",
    }, 6, environment);
    const updatedNote = toolData(updated.body!).note;
    expect(updatedNote.title).toBe("MCP 更新记录");
    expect(updatedNote.version).toBe(2);
    expect(updatedNote.contentMarkdown).toBeUndefined();
    expect(updatedNote.tags).toEqual([]);

    const staleUpdate = await callTool("update_note", {
      noteId: createdNote.id,
      version: fetchedNote.version,
      contentMarkdown: "这次不应覆盖当前正文",
    }, 7, environment);
    const staleResult = resultOf(staleUpdate.body!);
    expect(staleResult.isError).toBe(true);
    expect(toolData(staleUpdate.body!).error.code).toBe("VERSION_CONFLICT");
    expect(toolData(staleUpdate.body!).error.current.version).toBe(2);

    const reread = await callTool("get_note", { noteId: createdNote.id }, 8, environment);
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
    const created = await callTool("create_note", { title: "图片引用笔记", contentMarkdown: markdown, includeContent: true }, 2, environment);
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

    const updated = await callTool("update_note", { noteId: createdNote.id, version: createdNote.version, contentMarkdown: `${markdown}\n补充`, includeContent: true }, 5, environment);
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

    const defaultPage = await callTool("search_notes", { query: "pagination" }, 1, environment);
    const defaultPageData = toolData(defaultPage.body!);
    expect(defaultPageData.notes).toHaveLength(20);
    expect(Array.from(defaultPageData.notes[0].preview).length).toBeLessThanOrEqual(120);
    expect(defaultPageData.notes[0].updatedAtISO).toBe(new Date(defaultPageData.notes[0].updatedAt * 1000).toISOString());

    const firstPage = await callTool("search_notes", { query: "pagination", limit: 100 }, 2, environment);
    const firstPageData = toolData(firstPage.body!);
    expect(firstPageData.notes).toHaveLength(100);
    expect(typeof firstPageData.nextCursor).toBe("string");

    const secondPage = await callTool("search_notes", { query: "pagination", cursor: firstPageData.nextCursor, limit: 100 }, 3, environment);
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
    expect(toolData(missingNote.body!).error).toMatchObject({ code: "NOT_FOUND", target: "note", legacyCode: "NOTE_NOT_FOUND" });
  });

  test("searches the trash by query through list_trash and search_notes", async () => {
    const environment = { ...credentials, XIANGYING_MCP_TOKEN: token };
    const kept = toolData((await callTool("create_note", { title: "留存笔记", contentMarkdown: "正文关键词" }, 1, environment)).body!).note;
    const trashed = toolData((await callTool("create_note", { title: "待恢复的会议记录", contentMarkdown: "关键词在回收站" }, 2, environment)).body!).note;
    await callTool("note_operation", { action: "trash", noteId: trashed.id, version: trashed.version }, 3, environment);

    const trashQuery = toolData((await callTool("list_trash", { query: "会议记录" }, 4, environment)).body!).notes;
    expect(trashQuery.map((note: { id: string }) => note.id)).toEqual([trashed.id]);

    const trashSearch = toolData((await callTool("search_notes", { query: "关键词", view: "trash" }, 5, environment)).body!).notes;
    expect(trashSearch.map((note: { id: string }) => note.id)).toEqual([trashed.id]);

    const allSearch = toolData((await callTool("search_notes", { query: "关键词" }, 6, environment)).body!).notes;
    expect(allSearch.map((note: { id: string }) => note.id)).toEqual([kept.id]);

    const restoredByTitle = toolData((await callTool("get_note", { title: "待恢复的会议记录", includeDeleted: true }, 7, environment)).body!).note;
    expect(restoredByTitle.id).toBe(trashed.id);
    expect(restoredByTitle.isDeleted).toBe(true);

    const hiddenByDefault = await callTool("get_note", { title: "待恢复的会议记录" }, 8, environment);
    expect(resultOf(hiddenByDefault.body!).isError).toBe(true);
    expect(toolData(hiddenByDefault.body!).error.code).toBe("NOT_FOUND");
  });

  test("keeps existing tags when set_tags uses add or remove mode", async () => {
    const environment = { ...credentials, XIANGYING_MCP_TOKEN: token };
    const created = toolData((await callTool("create_note", { title: "标签语义", contentMarkdown: "正文", tags: ["甲"] }, 1, environment)).body!).note;

    const added = await callTool("note_operation", { action: "set_tags", noteId: created.id, version: created.version, tags: ["乙"], mode: "add" }, 2, environment);
    expect(toolData(added.body!).mode).toBe("add");
    const afterAdd = toolData((await callTool("get_note", { noteId: created.id }, 3, environment)).body!).note;
    expect(afterAdd.tags).toEqual(["甲", "乙"]);

    const removed = await callTool("note_operation", { action: "set_tags", noteId: afterAdd.id, version: afterAdd.version, tags: ["甲"], mode: "remove" }, 4, environment);
    const afterRemove = toolData((await callTool("get_note", { noteId: created.id }, 5, environment)).body!).note;
    expect(afterRemove.tags).toEqual(["乙"]);
    expect(removed.response.status).toBe(200);

    const missingMode = await callTool("note_operation", { action: "set_tags", noteId: created.id, version: afterRemove.version, tags: ["丙"] }, 6, environment);
    expect(toolData(missingMode.body!).error.code).toBe("INVALID_NOTE_OPERATION");
    expect(toolData(missingMode.body!).error.message).toContain("action=set_tags 时必须显式传 mode=replace、add 或 remove");
    expect(toolData(missingMode.body!).error.message).not.toContain("需 tags");
    const replaced = await callTool("note_operation", { action: "set_tags", noteId: created.id, version: afterRemove.version, tags: ["丙"], mode: "replace" }, 7, environment);
    expect(toolData(replaced.body!).mode).toBe("replace");
    const afterReplace = toolData((await callTool("get_note", { noteId: created.id }, 8, environment)).body!).note;
    expect(afterReplace.tags).toEqual(["丙"]);
  });

  test("refuses to create MCP shares for trashed notes while keeping existing links auditable", async () => {
    const environment = { ...credentials, XIANGYING_MCP_TOKEN: token };
    const note = toolData((await callTool("create_note", { title: "回收站分享保护", contentMarkdown: "正文" }, 1, environment)).body!).note;
    const createdShare = toolData((await callTool("create_share", { noteId: note.id }, 2, environment)).body!).share;
    const trashed = toolData((await callTool("note_operation", { action: "trash", noteId: note.id, version: note.version }, 3, environment)).body!).note;

    const refused = await callTool("create_share", { noteId: note.id }, 4, environment);
    expect(refused.response.status).toBe(200);
    expect(refused.body?.result?.isError).toBe(true);
    expect(toolData(refused.body!).error.code).toBe("NOTE_IN_TRASH");

    const listed = toolData((await callTool("list_shares", { noteId: note.id }, 5, environment)).body!).shares;
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(createdShare.id);
    const sharedSearch = toolData((await callTool("search_notes", { view: "shared" }, 6, environment)).body!).notes;
    expect(sharedSearch.some((entry: { id: string }) => entry.id === note.id)).toBe(false);
    expect(trashed.deletedAt).not.toBeNull();
  });

  test("omits note content on request and exposes ISO timestamps", async () => {
    const environment = { ...credentials, XIANGYING_MCP_TOKEN: token };
    const created = toolData((await callTool("create_note", { title: "精简读取", contentMarkdown: "很长的一段正文" }, 1, environment)).body!).note;

    const summary = await callTool("get_note", { noteId: created.id, includeContent: false }, 2, environment);
    const summaryNote = toolData(summary.body!).note;
    expect(summaryNote.contentMarkdown).toBeUndefined();
    expect(summaryNote.version).toBe(created.version);
    expect(summaryNote.createdAtISO).toBe(new Date(summaryNote.createdAt * 1000).toISOString());

    const full = toolData((await callTool("get_note", { noteId: created.id }, 3, environment)).body!).note;
    expect(full.contentMarkdown).toBe("很长的一段正文");
  });

  test("reports partial batch failures without failing the whole call", async () => {
    const environment = { ...credentials, XIANGYING_MCP_TOKEN: token };
    const first = toolData((await callTool("create_note", { title: "批量一" }, 1, environment)).body!).note;
    const second = toolData((await callTool("create_note", { title: "批量二" }, 2, environment)).body!).note;

    const partial = await callTool("batch_update_notes", {
      notes: [
        { noteId: first.id, version: first.version },
        { noteId: second.id, version: 99 },
      ],
      isFavorite: true,
    }, 3, environment);
    const partialData = toolData(partial.body!);
    expect(resultOf(partial.body!).isError).toBeUndefined();
    expect(partialData).toMatchObject({ updatedCount: 1, failedCount: 1, partial: true });
    expect(partialData.results[0].ok).toBe(true);
    expect(partialData.results[1].error.code).toBe("VERSION_CONFLICT");
  });
});
