import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations, openDatabase, type SqliteDatabase } from "../server/db";
import { handleRequest, redactSensitivePath } from "../server/index";
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
  expect(result.content).toHaveLength(1);
  expect(result.content[0].type).toBe("text");
  expect(result.content[0].text.length).toBeLessThan(200);
  expect(result.content[0].text).toMatch(/[\u4e00-\u9fff]/);
  expect(() => JSON.parse(result.content[0].text)).toThrow();
  const data = result.structuredContent as Record<string, any>;
  expect(typeof data.ok).toBe("boolean");
  if (data.error) {
    expect(data.ok).toBe(false);
    expect(typeof data.error.recoverable).toBe("boolean");
    if (["NOTE_EXISTS", "NOTEBOOK_EXISTS", "AMBIGUOUS_NOTE", "AMBIGUOUS_MATCH", "AMBIGUOUS_SECTION", "VERSION_CONFLICT", "NOTE_IN_TRASH", "NOT_FOUND", "SECTION_NOT_FOUND", "NOTEBOOK_COUNT_MISMATCH", "SYSTEM_NOTEBOOK"].includes(data.error.code)) {
      expect(data.error.recoverable).toBe(true);
    }
    if (["INVALID_ARGUMENT", "INVALID_NOTEBOOK_SELECTOR", "VERSION_REQUIRED", "EMPTY_UPDATE", "CONFIRMATION_REQUIRED"].includes(data.error.code)) {
      expect(data.error.recoverable).toBe(false);
    }
    expect(data.error.legacyCode).toBeUndefined();
    if (data.error.recoverable) {
      expect(result.isError).toBeUndefined();
      expect(typeof data.error.suggestedAction).toBe("string");
      expect(data.error.suggestedAction.length).toBeGreaterThan(0);
    } else {
      expect(result.isError).toBe(true);
    }
    if (data.error.current?.version !== undefined) {
      expect(data.error.currentVersion).toBe(data.error.current.version);
      expect(data.error.current.contentMarkdown).toBeUndefined();
    }
  }
  if (data.failedCount !== undefined) {
    expect(data.ok).toBe(data.failedCount === 0);
    expect(typeof data.partial).toBe("boolean");
    expect(data.partial).toBe(data.failedCount > 0 && data.results.some((entry: { ok: boolean }) => entry.ok));
    expect(result.isError).toBeUndefined();
    for (const entry of data.results) {
      if (!entry.ok) {
        expect(typeof entry.error.recoverable).toBe("boolean");
        if (entry.error.recoverable) expect(typeof entry.error.suggestedAction).toBe("string");
        if (entry.error.current?.version !== undefined) expect(entry.error.currentVersion).toBe(entry.error.current.version);
      }
    }
  }
  return data;
}

describe("remote MCP endpoint", () => {
  test("keeps long note bodies only in structured results across save, read, outline, section, and search", async () => {
    const body = "唯一正文标记".repeat(2_000);
    const markdown = `# 长正文\n\n## 第一节\n\n${body}\n\n## 第二节\n尾声`;
    const save = await callTool("save_note", { title: "长正文回执", contentMarkdown: markdown, includeContent: true });
    const note = toolData(save.body!).note;
    expect(note.contentMarkdown).toBe(markdown);
    const read = await callTool("get_note", { noteId: note.id });
    expect(toolData(read.body!).note.contentMarkdown).toBe(markdown);
    const outline = await callTool("get_note_outline", { noteId: note.id });
    expect(toolData(outline.body!).headings).toHaveLength(3);
    const section = await callTool("get_note_section", { noteId: note.id, heading: "第一节" });
    expect(toolData(section.body!).section.contentMarkdown).toContain(body);
    const search = await callTool("search_notes", { query: "长正文回执" });
    expect(toolData(search.body!).notes[0].id).toBe(note.id);
    for (const response of [save, read, outline, section, search]) {
      expect(resultOf(response.body!).content[0].text).not.toContain("唯一正文标记");
    }
  });

  test("rejects removed tag and force inputs without changing notes", async () => {
    const note = toolData((await callTool("create_note", { title: "严格新参数", contentMarkdown: "保留正文", tags: ["标签"], includeContent: true })).body!).note;
    for (const [name, argumentsValue] of [
      ["search_notes", { tag: "标签" }],
      ["replace_in_note", { noteId: note.id, oldText: "保留", newText: "损坏", force: true }],
    ] as const) {
      const rejected = await callTool(name, argumentsValue);
      expect(resultOf(rejected.body!).isError).toBe(true);
    }
    expect(toolData((await callTool("get_note", { noteId: note.id })).body!).note).toMatchObject({ version: note.version, contentMarkdown: note.contentMarkdown });
    expect(toolData((await callTool("search_notes", { tags: ["标签"] })).body!).notes.map((entry: { id: string }) => entry.id)).toEqual([note.id]);
  });

  test("applyToLatest replaces the latest body and preserves changes after the supplied version", async () => {
    const original = toolData((await callTool("create_note", { title: "最新正文替换", contentMarkdown: "原有片段" })).body!).note;
    const latest = toolData((await callTool("append_to_note", { noteId: original.id, contentMarkdown: "\n独立新增内容", expectedVersion: original.version })).body!).note;
    const stale = toolData((await callTool("replace_in_note", { noteId: original.id, oldText: "原有片段", newText: "替换片段", expectedVersion: original.version })).body!);
    expect(stale.error).toMatchObject({ code: "VERSION_CONFLICT", recoverable: true, currentVersion: latest.version });
    const updated = toolData((await callTool("replace_in_note", { noteId: original.id, oldText: "原有片段", newText: "替换片段", expectedVersion: original.version, applyToLatest: true, includeContent: true })).body!).note;
    expect(updated.version).toBe(latest.version + 1);
    expect(updated.contentMarkdown).toContain("替换片段");
    expect(updated.contentMarkdown).toContain("独立新增内容");
  });

  test("ensures notebooks idempotently and saves into a missing notebook in one call", async () => {
    const saved = toolData((await callTool("save_note", {
      title: "文案初稿", contentMarkdown: "完整正文", notebook: { notebookName: "文案", createIfMissing: true }, tags: ["初稿"],
    })).body!);
    expect(saved.created).toBe(true);
    expect(saved.note).toMatchObject({ title: "文案初稿", notebookName: "文案", tags: ["初稿"] });
    expect(saved.note.contentMarkdown).toBeUndefined();
    const ensured = toolData((await callTool("ensure_notebook", { name: "文案" })).body!);
    expect(ensured).toMatchObject({ created: false, notebook: { id: saved.note.notebookId } });
    const first = toolData((await callTool("ensure_notebook", { name: "资料", color: "#52675b", icon: "briefcase" })).body!);
    const again = toolData((await callTool("ensure_notebook", { name: "资料" })).body!);
    expect(first).toMatchObject({ created: true, notebook: { name: "资料", color: "#52675b", icon: "briefcase" } });
    expect(again).toMatchObject({ created: false, notebook: { id: first.notebook.id } });
    expect(toolData((await callTool("get_note", { noteId: saved.note.id })).body!).note.contentMarkdown).toContain("完整正文");
  });

  test("upserts only exact titles inside a specified notebook with full-content version protection", async () => {
    const args = { title: "同名报告", notebook: { notebookName: "报告", createIfMissing: true }, mode: "upsert" };
    const first = toolData((await callTool("save_note", { ...args, contentMarkdown: "第一版" })).body!);
    expect(first.created).toBe(true);
    await callTool("create_note", { title: "同名报告扩展", notebookName: "报告" });
    const other = toolData((await callTool("save_note", { ...args, contentMarkdown: "另一本正文", notebook: { notebookName: "其他报告", createIfMissing: true } })).body!);
    expect(other.created).toBe(true);
    expect(other.note.id).not.toBe(first.note.id);
    const withoutVersion = toolData((await callTool("save_note", { ...args, contentMarkdown: "不应覆盖" })).body!);
    expect(withoutVersion.error.code).toBe("VERSION_REQUIRED");
    const second = toolData((await callTool("save_note", { ...args, contentMarkdown: "第二版", expectedVersion: first.note.version, includeContent: true })).body!);
    expect(second.created).toBe(false);
    expect(second.note).toMatchObject({ id: first.note.id, contentMarkdown: "第二版", version: first.note.version + 1 });
    const conflict = toolData((await callTool("save_note", { ...args, contentMarkdown: "过期正文", expectedVersion: first.note.version })).body!);
    expect(conflict.error.code).toBe("VERSION_CONFLICT");
    expect(conflict.error.current.contentMarkdown).toBeUndefined();
    await callTool("create_note", { title: "同名报告", notebookName: "报告" });
    const ambiguous = toolData((await callTool("save_note", { ...args, contentMarkdown: "不应写入", expectedVersion: second.note.version })).body!);
    expect(ambiguous.error.code).toBe("AMBIGUOUS_NOTE");
    const noNotebook = await callTool("save_note", { title: "同名报告", contentMarkdown: "无范围", mode: "upsert" });
    expect(resultOf(noNotebook.body!).isError).toBe(true);
    const missing = toolData((await callTool("save_note", { title: "不存在", contentMarkdown: "正文", notebook: { notebookName: "未创建" } })).body!);
    expect(missing.error).toMatchObject({ code: "NOT_FOUND", target: "notebook" });
  });

  test("resolves notebook names for creation, reads, search, management, and batch moves with ID precedence", async () => {
    const first = toolData((await callTool("ensure_notebook", { name: "第一本" })).body!).notebook;
    const second = toolData((await callTool("ensure_notebook", { name: "第二本" })).body!).notebook;
    const note = toolData((await callTool("create_note", { title: "按名归档", notebookName: first.name })).body!).note;
    expect(note.notebookId).toBe(first.id);
    expect(toolData((await callTool("get_note", { title: "按名归档", notebookName: first.name })).body!).note.id).toBe(note.id);
    expect(toolData((await callTool("search_notes", { notebookName: first.name })).body!).notes.map((item: { id: string }) => item.id)).toEqual([note.id]);
    const moved = toolData((await callTool("manage_note", { action: "move", noteId: note.id, notebookName: second.name })).body!).note;
    expect(moved.notebookId).toBe(second.id);
    const batch = toolData((await callTool("batch_update_notes", { notes: [{ noteId: note.id, expectedVersion: moved.version }], notebookName: first.name })).body!);
    expect(batch.results[0].note.notebookId).toBe(first.id);
    const idWins = toolData((await callTool("create_note", { title: "ID 优先", notebookId: second.id, notebookName: "不存在的名字" })).body!).note;
    expect(idWins.notebookId).toBe(second.id);
    const saveIdWins = toolData((await callTool("save_note", { title: "保存 ID 优先", contentMarkdown: "正文", notebook: { notebookId: second.id, notebookName: "不存在的名字" } })).body!).note;
    expect(saveIdWins.notebookId).toBe(second.id);
  });

  test("serializes concurrent title upserts without creating duplicate notes", async () => {
    const notebook = toolData((await callTool("ensure_notebook", { name: "并发保存" })).body!).notebook;
    const args = { title: "同时写入", contentMarkdown: "正文", mode: "upsert", notebook: { notebookId: notebook.id } };
    const responses = await Promise.all([callTool("save_note", args, 2), callTool("save_note", args, 3)]);
    const results = responses.map((response) => toolData(response.body!));
    expect(results.filter((result) => result.created === true)).toHaveLength(1);
    expect(results.filter((result) => result.error?.code === "VERSION_REQUIRED")).toHaveLength(1);
    const notes = toolData((await callTool("search_notes", { notebookId: notebook.id })).body!).notes;
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe(args.title);
  });

  test("rejects default and explicit create duplicates in their target notebook with recovery metadata", async () => {
    const first = toolData((await callTool("save_note", { title: "Alpha", contentMarkdown: "原正文" })).body!).note;
    for (const extra of [{}, { mode: "create" }, { title: "alpha" }, { title: " Alpha " }]) {
      const duplicate = toolData((await callTool("save_note", { title: "Alpha", contentMarkdown: "不应写入", ...extra })).body!);
      expect(duplicate.error.code).toBe("NOTE_EXISTS");
      expect(duplicate.error.matches).toEqual([expect.objectContaining({ id: first.id, version: first.version, notebookName: first.notebookName })]);
    }
    expect(toolData((await callTool("get_note", { title: "Alpha" })).body!).note).toMatchObject({ id: first.id, version: first.version, contentMarkdown: "原正文" });
    const notebook = toolData((await callTool("ensure_notebook", { name: "另一本" })).body!).notebook;
    const other = toolData((await callTool("save_note", { title: "Alpha", contentMarkdown: "另一本正文", notebook: { notebookId: notebook.id } })).body!).note;
    expect(other.id).not.toBe(first.id);
    const namedDuplicate = toolData((await callTool("save_note", { title: "alpha", contentMarkdown: "不应覆盖", notebook: { notebookName: notebook.name } })).body!);
    expect(namedDuplicate.error).toMatchObject({ code: "NOTE_EXISTS", matches: [expect.objectContaining({ id: other.id, version: other.version, notebookName: notebook.name })] });
    expect(toolData((await callTool("search_notes", { query: "Alpha", view: "all" })).body!).notes).toHaveLength(2);
  });

  test("serializes default create saves and excludes trash from duplicate checks", async () => {
    const args = { title: "并发创建", contentMarkdown: "正文" };
    const results = (await Promise.all([callTool("save_note", args, 2), callTool("save_note", args, 3)])).map((response) => toolData(response.body!));
    const created = results.find((result) => result.created === true)!.note;
    expect(results.filter((result) => result.created === true)).toHaveLength(1);
    expect(results.filter((result) => result.error?.code === "NOTE_EXISTS")).toHaveLength(1);
    expect(toolData((await callTool("search_notes", { query: args.title, view: "inbox" })).body!).notes).toHaveLength(1);
    await callTool("manage_note", { action: "trash", noteId: created.id, expectedVersion: created.version });
    const recreated = toolData((await callTool("save_note", args)).body!);
    expect(recreated.created).toBe(true);
    expect(recreated.note.id).not.toBe(created.id);
    expect(toolData((await callTool("search_notes", { view: "trash" })).body!).notes).toHaveLength(1);
  });

  test("requires expectedVersion for full updates and rejects former version aliases without writes", async () => {
    const note = toolData((await callTool("create_note", { title: "乐观锁", contentMarkdown: "初始正文" })).body!).note;
    const rejected = toolData((await callTool("update_note", { noteId: note.id, contentMarkdown: "没有版本" })).body!);
    expect(rejected.error.code).toBe("VERSION_REQUIRED");
    expect(toolData((await callTool("get_note", { noteId: note.id })).body!).note.contentMarkdown).toBe("初始正文");
    const updated = toolData((await callTool("update_note", { noteId: note.id, expectedVersion: note.version, contentMarkdown: "新正文" })).body!).note;
    for (const alias of ["version", "baseVersion"]) {
      const legacy = await callTool("update_note", { noteId: note.id, [alias]: updated.version, contentMarkdown: "不应覆盖" });
      expect(resultOf(legacy.body!).isError).toBe(true);
      expect(resultOf(legacy.body!).content[0].text).toContain(alias);
      expect(toolData((await callTool("get_note", { noteId: note.id })).body!).note).toMatchObject({ contentMarkdown: "新正文", version: updated.version });
    }
    const stale = toolData((await callTool("update_note", { noteId: note.id, expectedVersion: note.version, contentMarkdown: "旧版本覆盖" })).body!);
    expect(stale.error).toMatchObject({ code: "VERSION_CONFLICT", current: { version: updated.version } });
    expect(stale.error.current.contentMarkdown).toBeUndefined();
    const based = toolData((await callTool("update_note", { noteId: note.id, expectedVersion: updated.version, contentMarkdown: "基准正文" })).body!).note;
    const renamed = toolData((await callTool("update_note", { noteId: note.id, title: "仅修改标题" })).body!).note;
    expect(renamed.version).toBe(based.version + 1);
  });

  test("rejects obsolete version names on local writes and requires each batch expectedVersion", async () => {
    const note = toolData((await callTool("create_note", { title: "版本参数", contentMarkdown: "# 标题\n\n正文" })).body!).note;
    const writes = [
      ["append_to_note", { contentMarkdown: "追加" }],
      ["insert_into_note", { anchor: "正文", contentMarkdown: "插入", position: "after" }],
      ["replace_in_note", { oldText: "正文", newText: "替换" }],
      ["replace_note_section", { heading: "标题", contentMarkdown: "# 标题\n替换" }],
      ["manage_note", { action: "trash" }],
    ] as const;
    for (const [name, args] of writes) {
      const result = await callTool(name, { noteId: note.id, version: note.version, ...args });
      expect(resultOf(result.body!).isError).toBe(true);
      expect(resultOf(result.body!).content[0].text).toContain("version");
    }
    for (const entry of [{ noteId: note.id }, { noteId: note.id, version: note.version }]) {
      const result = await callTool("batch_update_notes", { notes: [entry], isFavorite: true });
      expect(resultOf(result.body!).isError).toBe(true);
    }
    expect(toolData((await callTool("get_note", { noteId: note.id })).body!).note).toMatchObject({ version: note.version, contentMarkdown: "# 标题\n\n正文", isFavorite: false, isDeleted: false });
  });

  test("reads headings outside fences and edits only a selected Markdown section", async () => {
    const markdown = "# 总览\n\n开场\n\n## 结论\n\n旧结论\n\n### 子节\n\n子内容\n\n## 尾声\n\n保留尾声\n\n```md\n# 代码里的标题\n```\n";
    const note = toolData((await callTool("create_note", { title: "章节编辑", contentMarkdown: markdown })).body!).note;
    const outline = toolData((await callTool("get_note_outline", { noteId: note.id })).body!);
    expect(outline.headings.map((heading: { text: string }) => heading.text)).toEqual(["总览", "结论", "子节", "尾声"]);
    expect(outline.headings.map((heading: { level: number }) => heading.level)).toEqual([1, 2, 3, 2]);
    const sectionId = outline.headings[1].sectionId;
    const section = toolData((await callTool("get_note_section", { noteId: note.id, sectionId })).body!).section;
    expect(section.contentMarkdown).toContain("旧结论");
    expect(section.contentMarkdown).toContain("子内容");
    expect(section.contentMarkdown).not.toContain("保留尾声");
    const replaced = toolData((await callTool("replace_note_section", {
      noteId: note.id, heading: "结论", contentMarkdown: "## 结论\n\n新的结论\n\n", expectedVersion: note.version,
    })).body!).note;
    expect(replaced.contentMarkdown).toBeUndefined();
    const final = toolData((await callTool("get_note", { noteId: note.id })).body!).note.contentMarkdown;
    expect(final).toBe(markdown.replace("## 结论\n\n旧结论\n\n### 子节\n\n子内容\n\n", "## 结论\n\n新的结论\n\n"));
    const stale = toolData((await callTool("replace_note_section", { noteId: note.id, heading: "结论", contentMarkdown: "## 结论\n旧版本", expectedVersion: note.version })).body!);
    expect(stale.error.code).toBe("VERSION_CONFLICT");
    expect(stale.error.current.contentMarkdown).toBeUndefined();
  });

  test("requires disambiguation for repeated headings and supports selecting an occurrence", async () => {
    const note = toolData((await callTool("create_note", { title: "重复章节", contentMarkdown: "## 结论\n甲\n\n## 结论\n乙\n" })).body!).note;
    const ambiguous = await callTool("get_note_section", { noteId: note.id, heading: "结论" });
    expect(toolData(ambiguous.body!).error.code).toBe("AMBIGUOUS_SECTION");
    const second = toolData((await callTool("get_note_section", { noteId: note.id, heading: "结论", occurrence: 2 })).body!).section;
    expect(second.contentMarkdown).toContain("乙");
    expect(second.contentMarkdown).not.toContain("甲");
    const replaced = toolData((await callTool("replace_note_section", { noteId: note.id, heading: "结论", occurrence: 2, contentMarkdown: "## 结论\n丙\n", includeContent: true })).body!).note;
    expect(replaced.contentMarkdown).toBe("## 结论\n甲\n\n## 结论\n丙\n");
    expect(toolData((await callTool("get_note_section", { noteId: note.id, sectionId: "missing" })).body!).error.code).toBe("SECTION_NOT_FOUND");
  });

  test("keeps a following Setext heading separate when section replacement has no trailing newline", async () => {
    const note = toolData((await callTool("create_note", { title: "Setext 章节边界", contentMarkdown: "# A\nx\n\nB\n===\ny" })).body!).note;
    await callTool("replace_note_section", { noteId: note.id, heading: "A", contentMarkdown: "# A\nnew", expectedVersion: note.version });
    const outline = toolData((await callTool("get_note_outline", { noteId: note.id })).body!);
    expect(outline.headings.map((heading: { text: string; level: number }) => ({ text: heading.text, level: heading.level }))).toEqual([
      { text: "A", level: 1 }, { text: "B", level: 1 },
    ]);
    const second = toolData((await callTool("get_note_section", { noteId: note.id, heading: "B" })).body!).section;
    expect(second.contentMarkdown).toBe("B\n===\ny");
    const current = toolData((await callTool("get_note", { noteId: note.id })).body!).note;
    expect(current.contentMarkdown).toBe("# A\nnew\n\nB\n===\ny");
  });

  test("rejects old section IDs after body changes and counts emoji as Unicode characters", async () => {
    const note = toolData((await callTool("create_note", { title: "章节标识安全", contentMarkdown: "## 标题\n😀😀\n" })).body!).note;
    expect(note.contentLength).toBe(Array.from("## 标题\n😀😀\n").length);
    const outline = toolData((await callTool("get_note_outline", { noteId: note.id })).body!);
    const oldId = outline.headings[0].sectionId;
    const appended = toolData((await callTool("append_to_note", { noteId: note.id, contentMarkdown: "补充" })).body!).note;
    expect(appended.contentLength).toBe(Array.from("## 标题\n😀😀\n补充").length);
    const obsolete = toolData((await callTool("replace_note_section", { noteId: note.id, sectionId: oldId, contentMarkdown: "## 标题\n不应覆盖" })).body!);
    expect(obsolete.error.code).toBe("SECTION_NOT_FOUND");
    const current = toolData((await callTool("get_note", { noteId: note.id })).body!).note;
    expect(current.contentMarkdown).toBe("## 标题\n😀😀\n补充");
  });

  test("combines tag filters, sorts searches, and explains matching fields", async () => {
    const first = toolData((await callTool("create_note", { title: "题目命中", contentMarkdown: "普通正文", tags: ["甲", "乙"] })).body!).note;
    const second = toolData((await callTool("create_note", { title: "另一篇", contentMarkdown: "正文中有命中", tags: ["乙"] })).body!).note;
    database.query("UPDATE notes SET created_at = ?, updated_at = ? WHERE id = ?").run(100, 300, first.id);
    database.query("UPDATE notes SET created_at = ?, updated_at = ? WHERE id = ?").run(200, 250, second.id);
    const allTags = toolData((await callTool("search_notes", { tags: ["甲", "乙"], tagMode: "all" })).body!);
    expect(allTags.notes.map((item: { id: string }) => item.id)).toEqual([first.id]);
    const anyTags = toolData((await callTool("search_notes", { tags: ["甲", "乙"], tagMode: "any", sort: "created_desc" })).body!);
    expect(anyTags.notes.map((item: { id: string }) => item.id)).toEqual([second.id, first.id]);
    const updated = toolData((await callTool("search_notes", { tags: ["乙"], sort: "updated_desc" })).body!);
    expect(updated.notes.map((item: { id: string }) => item.id)).toEqual([first.id, second.id]);
    const firstPage = toolData((await callTool("search_notes", { tags: ["乙"], sort: "created_desc", limit: 1 })).body!);
    const secondPage = toolData((await callTool("search_notes", { tags: ["乙"], sort: "created_desc", limit: 1, cursor: firstPage.nextCursor })).body!);
    expect(firstPage.notes.map((item: { id: string }) => item.id)).toEqual([second.id]);
    expect(secondPage.notes.map((item: { id: string }) => item.id)).toEqual([first.id]);
    const matches = toolData((await callTool("search_notes", { query: "命中", sort: "relevance" })).body!).notes;
    expect(matches.find((item: { id: string }) => item.id === first.id).match.field).toBe("title");
    expect(matches.find((item: { id: string }) => item.id === second.id).match.field).toBe("content");
    const tags = toolData((await callTool("search_notes", { tags: ["甲"] })).body!).notes;
    expect(tags[0].match.field).toBe("tag");
  });

  test("previews notebook deletion without mutation or confirmation and includes trashed notes", async () => {
    const notebook = toolData((await callTool("ensure_notebook", { name: "旧资料" })).body!).notebook;
    const note = toolData((await callTool("create_note", { title: "保留笔记", notebookName: notebook.name })).body!).note;
    await callTool("manage_note", { action: "trash", noteId: note.id });
    const preview = toolData((await callTool("delete_notebook", { notebookName: notebook.name, dryRun: true })).body!);
    expect(preview).toMatchObject({ wouldDeleteNotebook: notebook.name, wouldMoveNotes: 1 });
    expect(toolData((await callTool("get_note", { noteId: note.id })).body!).note.notebookId).toBe(notebook.id);
    expect(toolData((await callTool("list_notebooks", {})).body!).notebooks.some((item: { id: string }) => item.id === notebook.id)).toBe(true);
  });

  test("returns note links only from a configured valid public URL", async () => {
    const withoutOrigin = toolData((await callTool("create_note", { title: "无公共链接" })).body!).note;
    expect(withoutOrigin.webUrl).toBeUndefined();
    expect(withoutOrigin.deepLink).toBeUndefined();
    const environment = { ...credentials, XIANGYING_MCP_TOKEN: token, PUBLIC_URL: "https://notes.example.com" };
    const note = toolData((await callTool("save_note", { title: "公共链接", contentMarkdown: "正文" }, 2, environment)).body!).note;
    expect(note.webUrl).toBe(`https://notes.example.com/app?note=${note.id}`);
    expect(note.deepLink).toBeUndefined();
    expect(toolData((await callTool("get_note", { noteId: note.id }, 3, environment)).body!).note.webUrl).toBe(note.webUrl);
    const invalidEnvironment = { ...environment, PUBLIC_URL: "javascript:alert(1)" };
    const invalid = toolData((await callTool("get_note", { noteId: note.id }, 4, invalidEnvironment)).body!).note;
    expect(invalid.webUrl).toBeUndefined();
  });

  test("rejects removed tool names rather than redirecting them", async () => {
    for (const name of ["note_operation", "list_trash"]) {
      const result = await callTool(name, {});
      expect(result.body?.error).toBeDefined();
      expect(result.body?.result).toBeUndefined();
    }
  });

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
    expect(tools.map((tool: { name: string }) => tool.name).sort()).toEqual([
      "list_notebooks", "ensure_notebook", "create_notebook", "update_notebook", "delete_notebook", "search_notes", "get_note", "get_notes_batch", "get_note_outline", "get_note_section", "save_note", "create_note", "update_note", "replace_in_note", "replace_note_section", "manage_note", "append_to_note", "insert_into_note", "batch_update_notes",
    ].sort());
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
    expect(Object.keys(updateSchema.properties)).toEqual(["noteId", "expectedVersion", "title", "contentMarkdown", "includeContent"]);
    expect(updateSchema.required).toEqual(["noteId"]);
    expect(updateSchema.additionalProperties).toBe(false);
    const noteOperation = tools.find((tool: { name: string }) => tool.name === "manage_note");
    expect(noteOperation.inputSchema.type).toBe("object");
    expect(noteOperation.inputSchema.oneOf).toBeUndefined();
    expect(noteOperation.inputSchema.anyOf).toBeUndefined();
    expect(noteOperation.inputSchema.additionalProperties).toBe(false);
    expect(Object.keys(noteOperation.inputSchema.properties)).toEqual(expect.arrayContaining([
      "action", "noteId", "expectedVersion", "notebookId", "notebookName", "isFavorite", "tags", "mode",
    ]));
    expect(noteOperation.inputSchema.properties.action.enum).toEqual([
      "move", "set_favorite", "set_tags", "trash", "restore",
    ]);
    expect(noteOperation.inputSchema.required).toEqual(["action", "noteId"]);
    const createNoteTool = tools.find((tool: { name: string }) => tool.name === "create_note");
    expect(createNoteTool.description.length).toBeLessThan(200);
    for (const tool of tools) expect(tool.description.length).toBeLessThan(400);
    const searchTool = tools.find((tool: { name: string }) => tool.name === "search_notes");
    expect(tools.some((tool: { name: string }) => ["create_share", "list_shares", "revoke_share"].includes(tool.name))).toBe(false);
    expect(searchTool.inputSchema.properties.view.enum).toEqual(["all", "inbox", "favorites", "trash"]);
    expect(searchTool.inputSchema.properties.sort.enum).toEqual(["relevance", "updated_desc", "created_desc"]);
    expect(searchTool.inputSchema.properties.tagMode.enum).toEqual(["all", "any"]);
    expect(searchTool.inputSchema.properties.tag).toBeUndefined();
    expect(searchTool.inputSchema.properties.tags.type).toBe("array");
    expect(tools.some((tool: { name: string }) => ["note_operation", "list_trash"].includes(tool.name))).toBe(false);
    const replaceSchema = tools.find((tool: { name: string }) => tool.name === "replace_in_note").inputSchema;
    expect(Object.keys(replaceSchema.properties)).toEqual(["noteId", "oldText", "newText", "replaceAll", "occurrence", "expectedVersion", "applyToLatest", "includeContent"]);
    const insertSchema = tools.find((tool: { name: string }) => tool.name === "insert_into_note").inputSchema;
    expect(Object.keys(insertSchema.properties)).toContain("insertAll");
    const batchUpdateTool = tools.find((tool: { name: string }) => tool.name === "batch_update_notes");
    expect(batchUpdateTool.inputSchema.properties.notebookName.type).toBe("string");
    expect(batchUpdateTool.inputSchema.properties.notes.items.required).toEqual(["noteId", "expectedVersion"]);
    expect(batchUpdateTool.description).toContain("partial");
    const saveTool = tools.find((tool: { name: string }) => tool.name === "save_note");
    expect(saveTool.inputSchema.properties.mode.default).toBe("create");
    expect(saveTool.description).toContain("create");
    expect(saveTool.description).toContain("NOTE_EXISTS");
    for (const name of ["save_note", "create_note", "update_note", "replace_in_note", "replace_note_section", "append_to_note", "insert_into_note"]) {
      const tool = tools.find((entry: { name: string }) => entry.name === name);
      expect(tool.description).toContain("图片");
    }
    const getNoteTool = tools.find((tool: { name: string }) => tool.name === "get_note");
    expect(getNoteTool.inputSchema.properties.notebookName.type).toBe("string");
    expect(getNoteTool.description).toContain("ASCII");
    expect(getNoteTool.description).toContain("首尾空白");
    expect(getNoteTool.description).toContain("includeContent");
    expect(getNoteTool.description).toContain("matchCount");

    const validOriginRequest = modernMcpRequest("tools/list", 2);
    validOriginRequest.headers.set("Origin", "https://notes.example.com");
    const validOrigin = await callMcp(validOriginRequest, environment);
    expect(validOrigin.response.status).toBe(200);
  });

  test("provides server-level usage instructions during discovery", async () => {
    const discovered = await callMcp(modernMcpRequest("server/discover", 1), { ...credentials, XIANGYING_MCP_TOKEN: token });
    expect(discovered.response.status).toBe(200);
    expect(resultOf(discovered.body!).instructions).toContain("expectedVersion");
    expect(resultOf(discovered.body!).instructions).toContain("save_note");
    expect(resultOf(discovered.body!).instructions).toContain("换行写作 \\n");
    expect(resultOf(discovered.body!).instructions).toContain("工具参数必须是 JSON 对象");
    expect(resultOf(discovered.body!).instructions).toContain("客户端会先校验参数");
    expect(resultOf(discovered.body!).instructions).toContain("ensure_notebook");
    expect(resultOf(discovered.body!).instructions).toContain("delete_notebook");
    expect(resultOf(discovered.body!).instructions).toContain("get_notes_batch");
    expect(resultOf(discovered.body!).instructions).toContain("MCP 不提供永久删除笔记或清空回收站");
    expect(resultOf(discovered.body!).instructions).toContain("manage_note");
    expect(resultOf(discovered.body!).instructions).toContain("set_tags");
    expect(resultOf(discovered.body!).instructions).toContain("不构成同一时刻快照");
    expect(resultOf(discovered.body!).instructions).toContain("4.5 MB");
    expect(resultOf(discovered.body!).instructions).not.toContain("8,000");
    expect(resultOf(discovered.body!).instructions).toContain("保留字面井号");
    expect(resultOf(discovered.body!).instructions).toContain("contentLength 回执与批量读取字符预算按 Unicode code points 计算");
    expect(resultOf(discovered.body!).instructions).toContain("统一错误码 INVALID_ARGUMENT，并通过 field 指明字段");
    expect(resultOf(discovered.body!).instructions).toContain("field 取值为 name、color、icon、tags");
  });

  test("keeps tag and color validation on the server without publishing regex patterns", async () => {
    const environment = { ...credentials, XIANGYING_MCP_TOKEN: token };
    const listed = await callMcp(modernMcpRequest("tools/list", 1), environment);
    const tools = resultOf(listed.body!).tools as Array<{ name: string; inputSchema: Record<string, any> }>;
    const search = tools.find((tool) => tool.name === "search_notes")!;
    expect(search.inputSchema.properties.tag).toBeUndefined();
    expect(search.inputSchema.properties.tags.items).toMatchObject({ type: "string", minLength: 1, maxLength: 40 });
    expect(search.inputSchema.properties.tags.items.pattern).toBeUndefined();
    const updateNotebookTool = tools.find((tool) => tool.name === "update_notebook")!;
    expect(updateNotebookTool.inputSchema.properties.color.minLength).toBeUndefined();
    expect(updateNotebookTool.inputSchema.properties.color.maxLength).toBeUndefined();

    const invalidSearchTag = await callTool("search_notes", { tags: ["bad tag"] }, 2, environment);
    expect(toolData(invalidSearchTag.body!).error).toMatchObject({ code: "INVALID_ARGUMENT", field: "tags", invalidTags: ["bad tag"] });

    const invalidCreateTag = await callTool("create_note", {
      title: "非法标签不会写入",
      contentMarkdown: "正文",
      tags: ["含空格 标签", "正常标签"],
    }, 3, environment);
    expect(toolData(invalidCreateTag.body!).error).toMatchObject({ code: "INVALID_ARGUMENT", field: "tags", invalidTags: ["含空格 标签"] });

    const validNote = toolData((await callTool("create_note", { title: "批量非法标签定位" }, 7, environment)).body!).note;
    const invalidBatchTags = await callTool("batch_update_notes", {
      notes: [{ noteId: validNote.id, expectedVersion: validNote.version }],
      tags: ["bad tag", "valid_tag"],
    }, 8, environment);
    expect(toolData(invalidBatchTags.body!).error).toMatchObject({ code: "INVALID_ARGUMENT", field: "tags", invalidTags: ["bad tag"] });

    const invalidNotebookColor = await callTool("create_notebook", {
      name: "非法颜色校验",
      color: "#GGGGGG",
    }, 4, environment);
    expect(toolData(invalidNotebookColor.body!).error).toMatchObject({ code: "INVALID_ARGUMENT", field: "color", message: "请输入有效的六位十六进制颜色" });

    const notebook = toolData((await callTool("create_notebook", { name: "更新颜色校验" }, 5, environment)).body!).notebook;
    const invalidUpdatedNotebookColor = await callTool("update_notebook", {
      notebookId: notebook.id,
      color: "#xyz",
    }, 6, environment);
    expect(toolData(invalidUpdatedNotebookColor.body!).error).toMatchObject({ code: "INVALID_ARGUMENT", field: "color", message: "请输入有效的六位十六进制颜色" });
  });

  test("redacts MCP path tokens from application error log paths", () => {
    expect(redactSensitivePath(`${MCP_PATH}/${token}`)).toBe(`${MCP_PATH}/[REDACTED]`);
    expect(redactSensitivePath(`${MCP_PATH}/${token}/extra`)).toBe(`${MCP_PATH}/[REDACTED]/extra`);
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
    expect(resultOf(rejectedDeletion.body!).isError).toBeUndefined();
    expect(toolData(rejectedDeletion.body!).error.code).toBe("SYSTEM_NOTEBOOK");

    const missingNotebookCreate = await callTool("create_note", { title: "缺失笔记本", notebookId: "missing-notebook-id" }, 8, environment);
    expect(toolData(missingNotebookCreate.body!).error).toMatchObject({ code: "NOT_FOUND", target: "notebook" });
    const existingNote = toolData((await callTool("create_note", { title: "笔记本错误码一致性" }, 9, environment)).body!).note;
    const missingNotebookUpdate = await callTool("manage_note", {
      action: "move",
      noteId: existingNote.id,
      expectedVersion: existingNote.version,
      notebookId: "missing-notebook-id",
    }, 10, environment);
    expect(toolData(missingNotebookUpdate.body!).error).toMatchObject({ code: "NOT_FOUND", target: "notebook" });
  });

  test("confirms notebook deletion against totalCount including trashed notes", async () => {
    const environment = { ...credentials, XIANGYING_MCP_TOKEN: token };
    const notebook = toolData((await callTool("create_notebook", { name: "含回收站笔记的笔记本" }, 1, environment)).body!).notebook;
    const created = toolData((await callTool("create_note", { title: "已删除的笔记", notebookId: notebook.id }, 2, environment)).body!).note;
    const deleted = await callTool("manage_note", { action: "trash", noteId: created.id, expectedVersion: created.version }, 3, environment);
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
      expectedVersion: note.version,
      contentMarkdown: "\n追加内容",
    }, 2, environment);
    const appendResult = toolData(appended.body!).note;
    expect(appendResult.version).toBe(2);
    expect(appendResult.contentMarkdown).toBeUndefined();
    expect(toolData((await callTool("get_note", { noteId: note.id }, 3, environment)).body!).note.contentMarkdown).toBe("原有正文\n追加内容");

    const inserted = await callTool("insert_into_note", {
      noteId: note.id,
      expectedVersion: appendResult.version,
      anchor: "原有正文",
      contentMarkdown: "\n锚点插入",
      position: "after",
    }, 4, environment);
    const insertedNote = toolData(inserted.body!).note;
    expect(insertedNote.version).toBe(3);
    expect(toolData((await callTool("get_note", { noteId: note.id }, 5, environment)).body!).note.contentMarkdown).toBe("原有正文\n锚点插入\n追加内容");

    const duplicateAnchor = await callTool("insert_into_note", {
      noteId: note.id,
      expectedVersion: insertedNote.version,
      anchor: "\n",
      contentMarkdown: "不应插入",
    }, 6, environment);
    expect(resultOf(duplicateAnchor.body!).isError).toBeUndefined();
    expect(toolData(duplicateAnchor.body!).error.code).toBe("AMBIGUOUS_MATCH");
    expect(toolData(duplicateAnchor.body!).error.target).toBe("anchor");
    expect(toolData(duplicateAnchor.body!).error.matchCount).toBe(2);
    expect(toolData(duplicateAnchor.body!).error.matches).toHaveLength(2);

    const staleInsert = await callTool("insert_into_note", {
      noteId: note.id,
      expectedVersion: appendResult.version,
      anchor: "当前正文中不存在",
      contentMarkdown: "不应插入",
    }, 7, environment);
    expect(toolData(staleInsert.body!).error.code).toBe("VERSION_CONFLICT");

    const deleted = await callTool("manage_note", { action: "trash", noteId: note.id, expectedVersion: insertedNote.version }, 8, environment);
    const deletedNote = toolData(deleted.body!).note;
    expect(deletedNote.deletedAt).not.toBeNull();
    expect(deletedNote.version).toBe(4);
    const deletedAgain = await callTool("manage_note", { action: "trash", noteId: note.id, expectedVersion: deletedNote.version }, 9, environment);
    expect(toolData(deletedAgain.body!)).toMatchObject({ noop: true, note: { version: deletedNote.version, deletedAt: deletedNote.deletedAt } });
    const trash = await callTool("search_notes", { view: "trash", limit: 5, previewLength: 20 }, 10, environment);
    const trashedNote = toolData(trash.body!).notes.find((entry: { id: string }) => entry.id === note.id);
    expect(trashedNote).toMatchObject({ id: note.id, deletedAt: deletedNote.deletedAt, version: deletedNote.version });
    expect(trashedNote.updatedAtISO).toBe(new Date(trashedNote.updatedAt * 1000).toISOString());
    expect(Array.from(trashedNote.preview).length).toBeLessThanOrEqual(20);
    const reread = await callTool("get_note", { noteId: note.id }, 11, environment);
    expect(toolData(reread.body!).note.deletedAt).not.toBeNull();
    expect(toolData(reread.body!).note.isDeleted).toBe(true);
    const restored = await callTool("manage_note", { action: "restore", noteId: note.id, expectedVersion: deletedNote.version }, 12, environment);
    const restoredNote = toolData(restored.body!).note;
    expect(restoredNote.deletedAt).toBeNull();
    expect(restoredNote.isDeleted).toBe(false);
    const alreadyRestored = await callTool("manage_note", { action: "restore", noteId: note.id, expectedVersion: restoredNote.version }, 13, environment);
    expect(toolData(alreadyRestored.body!).noop).toBe(true);
    expect(toolData(alreadyRestored.body!).note.version).toBe(restoredNote.version);
  });

  test("batch restore supports deleted:false and marks repeated batch deletes as no-op", async () => {
    const environment = { ...credentials, XIANGYING_MCP_TOKEN: token };
    const first = toolData((await callTool("create_note", { title: "批量恢复甲" }, 1, environment)).body!).note;
    const second = toolData((await callTool("create_note", { title: "批量恢复乙" }, 2, environment)).body!).note;
    const trashedFirst = toolData((await callTool("manage_note", { action: "trash", noteId: first.id, expectedVersion: first.version }, 3, environment)).body!).note;
    const trashedSecond = toolData((await callTool("manage_note", { action: "trash", noteId: second.id, expectedVersion: second.version }, 4, environment)).body!).note;
    const notes = [trashedFirst, trashedSecond].map((note) => ({ noteId: note.id, expectedVersion: note.version }));

    const repeatedDelete = await callTool("batch_update_notes", { notes, deleted: true }, 5, environment);
    const repeatedDeleteData = toolData(repeatedDelete.body!);
    expect(repeatedDeleteData).toMatchObject({ updatedCount: 0, noopCount: 2, failedCount: 0 });
    expect(repeatedDeleteData.results.map((result: Record<string, any>) => result.noop)).toEqual([true, true]);
    expect(repeatedDeleteData.results.map((result: Record<string, any>) => result.note.version)).toEqual([trashedFirst.version, trashedSecond.version]);

    const restored = await callTool("batch_update_notes", { notes, deleted: false }, 6, environment);
    const restoredData = toolData(restored.body!);
    expect(restoredData).toMatchObject({ updatedCount: 2, failedCount: 0 });
    expect(restoredData.results.map((result: Record<string, any>) => result.note.deletedAt)).toEqual([null, null]);
    expect(restoredData.results.map((result: Record<string, any>) => result.note.version)).toEqual([trashedFirst.version + 1, trashedSecond.version + 1]);
  });

  test("marks repeated batch favorite and move requests as no-op", async () => {
    const environment = { ...credentials, XIANGYING_MCP_TOKEN: token };
    const note = toolData((await callTool("create_note", { title: "批量幂等收藏与移动" }, 1, environment)).body!).note;
    const notebook = toolData((await callTool("create_notebook", { name: "批量幂等目标" }, 2, environment)).body!).notebook;

    const favorited = toolData((await callTool("batch_update_notes", {
      notes: [{ noteId: note.id, expectedVersion: note.version }],
      isFavorite: true,
    }, 3, environment)).body!);
    const favoriteNote = favorited.results[0].note;
    const favoriteAgain = toolData((await callTool("batch_update_notes", {
      notes: [{ noteId: note.id, expectedVersion: favoriteNote.version }],
      isFavorite: true,
    }, 4, environment)).body!);
    expect(favoriteAgain.results[0]).toMatchObject({ noop: true, note: { version: favoriteNote.version, isFavorite: true } });
    expect(favoriteAgain).toMatchObject({ updatedCount: 0, noopCount: 1, failedCount: 0 });

    const noopWithFailure = toolData((await callTool("batch_update_notes", {
      notes: [
        { noteId: note.id, expectedVersion: favoriteNote.version },
        { noteId: "00000000-0000-4000-8000-000000000001", expectedVersion: 1 },
      ],
      isFavorite: true,
    }, 41, environment)).body!);
    expect(noopWithFailure).toMatchObject({ updatedCount: 0, noopCount: 1, failedCount: 1, partial: true });

    const moved = toolData((await callTool("batch_update_notes", {
      notes: [{ noteId: note.id, expectedVersion: favoriteNote.version }],
      notebookId: notebook.id,
    }, 5, environment)).body!);
    const movedNote = moved.results[0].note;
    const movedAgain = toolData((await callTool("batch_update_notes", {
      notes: [{ noteId: note.id, expectedVersion: movedNote.version }],
      notebookId: notebook.id,
    }, 6, environment)).body!);
    expect(movedAgain.results[0]).toMatchObject({ noop: true, note: { version: movedNote.version, notebookId: notebook.id } });
    expect(movedAgain).toMatchObject({ updatedCount: 0, noopCount: 1, failedCount: 0 });
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

    const missingMoveTarget = await callTool("manage_note", { action: "move", noteId: note.id, expectedVersion: note.version }, 2, environment);
    expect(toolData(missingMoveTarget.body!).error.code).toBe("INVALID_NOTE_OPERATION");
    const unexpectedTrashField = await callTool("manage_note", {
      action: "trash", noteId: note.id, expectedVersion: note.version, isFavorite: true,
    }, 2, environment);
    expect(toolData(unexpectedTrashField.body!).error.code).toBe("INVALID_NOTE_OPERATION");

    const tagged = await callTool("manage_note", { action: "set_tags", noteId: note.id, expectedVersion: note.version, tags: ["新标签"], mode: "replace" }, 3, environment);
    note = toolData(tagged.body!).note;
    expect(note.tags).toEqual(["新标签"]);
    expect(note.contentMarkdown).toBeUndefined();
    let fullNote = toolData((await callTool("get_note", { noteId: note.id }, 4, environment)).body!).note;
    expect(fullNote.contentMarkdown).toBe("正文\n代码示例 `#代码标签`\n#新标签");
    expect(fullNote.updatedAtISO).toBe(new Date(fullNote.updatedAt * 1000).toISOString());

    const favorited = await callTool("manage_note", { action: "set_favorite", noteId: note.id, expectedVersion: note.version, isFavorite: true }, 5, environment);
    note = toolData(favorited.body!).note;
    expect(note.isFavorite).toBe(true);
    const favoritedVersion = note.version;

    const autoVersionFavorite = await callTool("manage_note", { action: "set_favorite", noteId: note.id, isFavorite: false }, 55, environment);
    note = toolData(autoVersionFavorite.body!).note;
    expect(note.isFavorite).toBe(false);
    expect(note.version).toBe(favoritedVersion + 1);
    const refavorited = await callTool("manage_note", { action: "set_favorite", noteId: note.id, isFavorite: true }, 56, environment);
    note = toolData(refavorited.body!).note;
    expect(note.version).toBe(favoritedVersion + 2);
    const favoriteAgain = await callTool("manage_note", { action: "set_favorite", noteId: note.id, expectedVersion: note.version, isFavorite: true }, 6, environment);
    note = toolData(favoriteAgain.body!).note;
    expect(note.isFavorite).toBe(true);
    expect(note.version).toBe(favoritedVersion + 2);
    expect(toolData(favoriteAgain.body!).noop).toBe(true);
    const staleFavorite = await callTool("manage_note", { action: "set_favorite", noteId: note.id, expectedVersion: fullNote.version, isFavorite: false }, 7, environment);
    expect(toolData(staleFavorite.body!).error.code).toBe("VERSION_CONFLICT");

    const moved = await callTool("manage_note", { action: "move", noteId: note.id, expectedVersion: note.version, notebookId: notebook.id }, 8, environment);
    note = toolData(moved.body!).note;
    expect(note.notebookId).toBe(notebook.id);
    expect(note.isFavorite).toBe(true);
    const movedAgain = await callTool("manage_note", { action: "move", noteId: note.id, expectedVersion: note.version, notebookId: notebook.id }, 81, environment);
    expect(toolData(movedAgain.body!)).toMatchObject({ noop: true, note: { version: note.version, notebookId: notebook.id } });

    const cleared = await callTool("manage_note", { action: "set_tags", noteId: note.id, expectedVersion: note.version, tags: [], mode: "replace" }, 9, environment);
    note = toolData(cleared.body!).note;
    expect(note.tags).toEqual([]);
    fullNote = toolData((await callTool("get_note", { noteId: note.id }, 10, environment)).body!).note;
    expect(fullNote.contentMarkdown).toBe("正文\n代码示例 `#代码标签`");

    const trashedResult = await callTool("manage_note", { action: "trash", noteId: note.id, expectedVersion: fullNote.version }, 11, environment);
    const trashedNote = toolData(trashedResult.body!).note;
    const favoriteRejected = await callTool("manage_note", { action: "set_favorite", noteId: note.id, expectedVersion: trashedNote.version, isFavorite: false }, 12, environment);
    expect(toolData(favoriteRejected.body!).error.code).toBe("NOTE_IN_TRASH");
    const tagsRejected = await callTool("manage_note", { action: "set_tags", noteId: note.id, expectedVersion: trashedNote.version, tags: ["不应写入"], mode: "replace" }, 13, environment);
    expect(toolData(tagsRejected.body!).error.code).toBe("NOTE_IN_TRASH");
    const batchRejected = await callTool("batch_update_notes", {
      notes: [{ noteId: note.id, expectedVersion: trashedNote.version }],
      isFavorite: false,
      tags: ["不应写入"],
    }, 14, environment);
    expect(toolData(batchRejected.body!).results[0].error.code).toBe("NOTE_IN_TRASH");
    const updateRejected = await callTool("update_note", {
      noteId: note.id,
      expectedVersion: trashedNote.version,
      title: "不应改标题",
      contentMarkdown: "不应改正文",
    }, 15, environment);
    expect(toolData(updateRejected.body!).error.code).toBe("NOTE_IN_TRASH");
    const appendRejected = await callTool("append_to_note", { noteId: note.id, expectedVersion: trashedNote.version, contentMarkdown: "不应追加" }, 16, environment);
    expect(toolData(appendRejected.body!).error.code).toBe("NOTE_IN_TRASH");
    const replaceRejected = await callTool("replace_in_note", { noteId: note.id, expectedVersion: trashedNote.version, oldText: "不存在的正文片段", newText: "不应替换" }, 17, environment);
    expect(toolData(replaceRejected.body!).error.code).toBe("NOTE_IN_TRASH");
    const insertRejected = await callTool("insert_into_note", { noteId: note.id, expectedVersion: trashedNote.version, anchor: "不存在的锚点", contentMarkdown: "不应插入" }, 18, environment);
    expect(toolData(insertRejected.body!).error.code).toBe("NOTE_IN_TRASH");
    const moveRejected = await callTool("manage_note", { action: "move", noteId: note.id, expectedVersion: trashedNote.version, notebookId: "another-notebook" }, 19, environment);
    expect(toolData(moveRejected.body!).error.code).toBe("NOTE_IN_TRASH");
    const batchMoveRejected = await callTool("batch_update_notes", {
      notes: [{ noteId: note.id, expectedVersion: trashedNote.version }],
      notebookId: "another-notebook",
    }, 20, environment);
    expect(toolData(batchMoveRejected.body!).results[0].error.code).toBe("NOTE_IN_TRASH");
    const unchanged = toolData((await callTool("get_note", { noteId: note.id }, 21, environment)).body!).note;
    expect(unchanged).toMatchObject({ isDeleted: true, version: trashedNote.version, isFavorite: true, tags: [] });
    const restored = toolData((await callTool("manage_note", { action: "restore", noteId: note.id, expectedVersion: trashedNote.version }, 22, environment)).body!).note;
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
      expectedVersion: note.version,
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

    const removed = await callTool("manage_note", {
      action: "set_tags",
      noteId: note.id,
      expectedVersion: note.version,
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
    const codeTagSearch = await callTool("search_notes", { tags: ["代码标签"] }, 4, environment);
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
    expect(resultOf(ambiguous.body!).isError).toBeUndefined();
    expect(toolData(ambiguous.body!).error.code).toBe("NOT_FOUND");
    expect(toolData(ambiguous.body!).error.target).toBe("note");
    const fuzzy = toolData((await callTool("search_notes", { query: "季度计划" }, 51, environment)).body!);
    expect(fuzzy.notes).toHaveLength(2);

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

  test("matches trimmed titles case-insensitively without a bounded fuzzy-search fallback", async () => {
    const exact = toolData((await callTool("create_note", { title: "Case Sensitive Report", contentMarkdown: "精确结果" })).body!).note;
    const fetched = toolData((await callTool("get_note", { title: "  case sensitive report  " })).body!).note;
    expect(fetched.id).toBe(exact.id);
    await callTool("create_note", { title: "Case Sensitive Report Extra", contentMarkdown: "不应命中" });
    expect(toolData((await callTool("get_note", { title: "case sensitive report" })).body!).note.id).toBe(exact.id);
    await callTool("list_notebooks", {});
    const user = database.query("SELECT id FROM users WHERE username = ?").get(credentials.XIANGYING_USERNAME) as { id: string };
    const inbox = database.query("SELECT id FROM notebooks WHERE user_id = ? AND is_system = 1").get(user.id) as { id: string };
    for (let index = 0; index < 110; index += 1) createNote(database, user.id, inbox.id, `Case Sensitive Report extra ${index}`, "正文");
    expect(toolData((await callTool("get_note", { title: "case sensitive report" })).body!).note.id).toBe(exact.id);
  });

  test("cannot distinguish titles differing only by ASCII case using title or query whitespace", async () => {
    const first = toolData((await callTool("create_note", { title: "README" })).body!).note;
    const second = toolData((await callTool("create_note", { title: "readme" })).body!).note;
    for (const title of ["README", "readme", "  ReadMe  "]) {
      const result = toolData((await callTool("get_note", { title })).body!);
      expect(result.error).toMatchObject({ code: "AMBIGUOUS_MATCH", matchCount: 2 });
      expect(result.error.matches.map((match: { id: string }) => match.id).sort()).toEqual([first.id, second.id].sort());
    }
  });

  test("batch-updates notebooks and tags, and bounds search results", async () => {
    const environment = { ...credentials, XIANGYING_MCP_TOKEN: token };
    const notebook = toolData((await callTool("create_notebook", { name: "批量资料" }, 1, environment)).body!).notebook;
    const first = toolData((await callTool("create_note", { title: "批量样本甲", contentMarkdown: "searchable marker long preview text" }, 2, environment)).body!).note;
    const second = toolData((await callTool("create_note", { title: "批量样本乙", contentMarkdown: "searchable marker long preview text" }, 3, environment)).body!).note;

    const batch = await callTool("batch_update_notes", {
      notes: [{ noteId: first.id, expectedVersion: first.version }, { noteId: second.id, expectedVersion: second.version }],
      notebookId: notebook.id,
      tags: ["batch-tag"],
    }, 4, environment);
    const batchData = toolData(batch.body!);
    expect(batchData.updatedCount).toBe(2);
    expect(batchData.failedCount).toBe(0);

    const search = await callTool("search_notes", { query: "searchable marker", tags: ["batch-tag"], limit: 1, previewLength: 6 }, 5, environment);
    const searchData = toolData(search.body!);
    expect(searchData.notes).toHaveLength(1);
    expect(Array.from(searchData.notes[0].preview).length).toBeLessThanOrEqual(6);
    expect(typeof searchData.nextCursor).toBe("string");
    expect(searchData.total).toBe(2);

    const removal = await callTool("batch_update_notes", {
      notes: batchData.results.map((entry: { noteId: string; note: { version: number } }) => ({ noteId: entry.noteId, expectedVersion: entry.note.version })),
      removeTags: ["batch-tag"],
    }, 6, environment);
    expect(toolData(removal.body!).updatedCount).toBe(2);
    const removedSearch = await callTool("search_notes", { tags: ["batch-tag"] }, 7, environment);
    expect(toolData(removedSearch.body!).notes).toHaveLength(0);

    const currentNotes = toolData(removal.body!).results.map((entry: { noteId: string; note: { version: number } }) => ({ noteId: entry.noteId, expectedVersion: entry.note.version }));
    const replacedTags = await callTool("batch_update_notes", { notes: currentNotes, replaceTags: ["统一标签", "迁移标签"] }, 8, environment);
    expect(toolData(replacedTags.body!).updatedCount).toBe(2);
    const replacementResults = toolData(replacedTags.body!).results;
    expect(replacementResults.every((entry: { note: { tags: string[] } }) => JSON.stringify(entry.note.tags) === JSON.stringify(["统一标签", "迁移标签"]))).toBe(true);
    const incompatible = await callTool("batch_update_notes", {
      notes: replacementResults.map((entry: { noteId: string; note: { version: number } }) => ({ noteId: entry.noteId, expectedVersion: entry.note.version })),
      replaceTags: ["替换"],
      tags: ["追加"],
    }, 9, environment);
    expect(toolData(incompatible.body!).error.code).toBe("INCOMPATIBLE_TAG_OPERATIONS");
    const cleared = await callTool("batch_update_notes", {
      notes: replacementResults.map((entry: { noteId: string; note: { version: number } }) => ({ noteId: entry.noteId, expectedVersion: entry.note.version })),
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
    const trashed = toolData((await callTool("manage_note", { action: "trash", noteId: created.id, expectedVersion: created.version }, 2, environment)).body!).note;
    const byId = toolData((await callTool("get_note", { noteId: created.id, includeContent: false }, 3, environment)).body!).note;
    expect(byId).toMatchObject({ id: created.id, version: trashed.version, isDeleted: true, deletedAt: expect.any(Number) });
  });

  test("keeps per-item batch version conflicts bounded while preserving recovery metadata", async () => {
    const environment = { ...credentials, XIANGYING_MCP_TOKEN: token };
    const created = toolData((await callTool("create_note", { title: "批量冲突回执", contentMarkdown: "旧正文" }, 1, environment)).body!).note;
    await callTool("update_note", { noteId: created.id, expectedVersion: created.version, contentMarkdown: "新正文" }, 2, environment);

    const conflict = await callTool("batch_update_notes", {
      notes: [{ noteId: created.id, expectedVersion: created.version }],
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

    expect(toolData((await callTool("search_notes", { tags: ["CSharp"] }, 2, environment)).body!).notes).toHaveLength(0);
    expect(toolData((await callTool("search_notes", { tags: ["技术"] }, 3, environment)).body!).notes).toHaveLength(0);
    expect(toolData((await callTool("search_notes", { tags: ["可检索"] }, 4, environment)).body!).notes.map((entry: { id: string }) => entry.id)).toEqual([note.id]);
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
      expectedVersion: note.version,
      oldText: "已修正",
      newText: "再次修正",
    }, 4, environment);
    expect(toolData(stale.body!).error.code).toBe("VERSION_CONFLICT");
    expect(toolData(stale.body!).error.current.contentMarkdown).toBeUndefined();
    expect(toolData(stale.body!).error.current.preview).toContain("已修正");

    const appliedToLatest = await callTool("replace_in_note", {
      noteId: note.id,
      expectedVersion: note.version,
      applyToLatest: true,
      oldText: "已修正",
      newText: "最终修正",
    }, 5, environment);
    expect(toolData(appliedToLatest.body!).note.version).toBe(3);
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
    expect(toolData(missingOccurrence.body!).error.suggestedAction).toContain("get_note");
    expect(toolData(missingOccurrence.body!).error.matchCount).toBe(1);

    const missingText = await callTool("replace_in_note", {
      noteId: created.id,
      oldText: "正文中不存在的片段",
      newText: "不应写入",
    }, 5, environment);
    expect(toolData(missingText.body!).error.code).toBe("NOT_FOUND");
    expect(toolData(missingText.body!).error.target).toBe("text");
    expect(toolData(missingText.body!).error.suggestedAction).toContain("get_note");
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
        expectedVersion: note.version,
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

    const oversizedEncodedBody = await callMcp(modernMcpRequest("tools/call", 7, {
      name: "create_note",
      arguments: { title: "JSON 转义后请求体超限", contentMarkdown: "\u0000".repeat(750_000) },
    }, "create_note"), environment);
    expect(oversizedEncodedBody.response.status).toBe(400);
    expect(oversizedEncodedBody.body?.error.message).toContain("请求体超过 4.5 MB 传输上限");
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
    const tagSearch = await callTool("search_notes", { tags: ["mcp-explicit-tag"] }, 4, environment);
    expect(toolData(tagSearch.body!).notes.map((note: { id: string }) => note.id)).toContain(createdNote.id);

    const fetched = await callTool("get_note", { noteId: createdNote.id }, 5, environment);
    const fetchedNote = toolData(fetched.body!).note;
    expect(fetchedNote.contentMarkdown).toContain("可搜索正文");
    expect(fetchedNote.version).toBe(1);

    const updated = await callTool("update_note", {
      noteId: createdNote.id,
      expectedVersion: fetchedNote.version,
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
      expectedVersion: fetchedNote.version,
      contentMarkdown: "这次不应覆盖当前正文",
    }, 7, environment);
    const staleResult = resultOf(staleUpdate.body!);
    expect(staleResult.isError).toBeUndefined();
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

    const updated = await callTool("update_note", { noteId: createdNote.id, expectedVersion: createdNote.version, contentMarkdown: `${markdown}\n补充`, includeContent: true }, 5, environment);
    expect(toolData(updated.body!).note.contentMarkdown).toContain(assetUrl);
    expect(toolData(updated.body!).note.thumbnail).toBeUndefined();

    const conflict = await callTool("update_note", { noteId: createdNote.id, expectedVersion: createdNote.version, title: "过期标题" }, 6, environment);
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

  test("distinguishes invalid empty updates from recoverable missing notes", async () => {
    const emptyUpdate = await callTool("update_note", { noteId: "missing", expectedVersion: 1 });
    expect(resultOf(emptyUpdate.body!).isError).toBe(true);
    expect(toolData(emptyUpdate.body!).error.code).toBe("EMPTY_UPDATE");

    const missingNote = await callTool("get_note", { noteId: "missing" }, 2);
    expect(resultOf(missingNote.body!).isError).toBeUndefined();
    expect(toolData(missingNote.body!).error).toMatchObject({ code: "NOT_FOUND", target: "note" });
  });

  test("searches the trash by query through the unified search_notes tool", async () => {
    const environment = { ...credentials, XIANGYING_MCP_TOKEN: token };
    const kept = toolData((await callTool("create_note", { title: "留存笔记", contentMarkdown: "正文关键词" }, 1, environment)).body!).note;
    const trashed = toolData((await callTool("create_note", { title: "待恢复的会议记录", contentMarkdown: "关键词在回收站" }, 2, environment)).body!).note;
    await callTool("manage_note", { action: "trash", noteId: trashed.id, expectedVersion: trashed.version }, 3, environment);

    const trashQuery = toolData((await callTool("search_notes", { view: "trash", query: "会议记录" }, 4, environment)).body!).notes;
    expect(trashQuery.map((note: { id: string }) => note.id)).toEqual([trashed.id]);

    const trashSearch = toolData((await callTool("search_notes", { query: "关键词", view: "trash" }, 5, environment)).body!).notes;
    expect(trashSearch.map((note: { id: string }) => note.id)).toEqual([trashed.id]);

    const allSearch = toolData((await callTool("search_notes", { query: "关键词" }, 6, environment)).body!).notes;
    expect(allSearch.map((note: { id: string }) => note.id)).toEqual([kept.id]);

    const restoredByTitle = toolData((await callTool("get_note", { title: "待恢复的会议记录", includeDeleted: true }, 7, environment)).body!).note;
    expect(restoredByTitle.id).toBe(trashed.id);
    expect(restoredByTitle.isDeleted).toBe(true);

    const hiddenByDefault = await callTool("get_note", { title: "待恢复的会议记录" }, 8, environment);
    expect(resultOf(hiddenByDefault.body!).isError).toBeUndefined();
    expect(toolData(hiddenByDefault.body!).error.code).toBe("NOT_FOUND");
  });

  test("keeps existing tags when set_tags uses add or remove mode", async () => {
    const environment = { ...credentials, XIANGYING_MCP_TOKEN: token };
    const created = toolData((await callTool("create_note", { title: "标签语义", contentMarkdown: "正文", tags: ["甲"] }, 1, environment)).body!).note;

    const added = await callTool("manage_note", { action: "set_tags", noteId: created.id, expectedVersion: created.version, tags: ["乙"], mode: "add" }, 2, environment);
    expect(toolData(added.body!).mode).toBe("add");
    const afterAdd = toolData((await callTool("get_note", { noteId: created.id }, 3, environment)).body!).note;
    expect(afterAdd.tags).toEqual(["甲", "乙"]);

    const removed = await callTool("manage_note", { action: "set_tags", noteId: afterAdd.id, expectedVersion: afterAdd.version, tags: ["甲"], mode: "remove" }, 4, environment);
    const afterRemove = toolData((await callTool("get_note", { noteId: created.id }, 5, environment)).body!).note;
    expect(afterRemove.tags).toEqual(["乙"]);
    expect(removed.response.status).toBe(200);

    const missingMode = await callTool("manage_note", { action: "set_tags", noteId: created.id, expectedVersion: afterRemove.version, tags: ["丙"] }, 6, environment);
    expect(toolData(missingMode.body!).error.code).toBe("INVALID_NOTE_OPERATION");
    expect(toolData(missingMode.body!).error.message).toContain("action=set_tags 时必须显式传 mode=replace、add 或 remove");
    expect(toolData(missingMode.body!).error.message).not.toContain("需 tags");
    const replaced = await callTool("manage_note", { action: "set_tags", noteId: created.id, expectedVersion: afterRemove.version, tags: ["丙"], mode: "replace" }, 7, environment);
    expect(toolData(replaced.body!).mode).toBe("replace");
    const afterReplace = toolData((await callTool("get_note", { noteId: created.id }, 8, environment)).body!).note;
    expect(afterReplace.tags).toEqual(["丙"]);
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
        { noteId: first.id, expectedVersion: first.version },
        { noteId: second.id, expectedVersion: 99 },
      ],
      isFavorite: true,
    }, 3, environment);
    const partialData = toolData(partial.body!);
    expect(resultOf(partial.body!).isError).toBeUndefined();
    expect(partialData).toMatchObject({ updatedCount: 1, failedCount: 1, partial: true });
    expect(partialData.results[0].ok).toBe(true);
    expect(partialData.results[1].error.code).toBe("VERSION_CONFLICT");
    const allFailed = await callTool("batch_update_notes", { notes: [{ noteId: first.id, expectedVersion: 99 }, { noteId: second.id, expectedVersion: 99 }], isFavorite: true });
    expect(resultOf(allFailed.body!).isError).toBeUndefined();
    expect(toolData(allFailed.body!)).toMatchObject({ updatedCount: 0, failedCount: 2 });
    expect(toolData(allFailed.body!).partial).toBe(false);
    const success = toolData((await callTool("batch_update_notes", { notes: [{ noteId: second.id, expectedVersion: second.version }], isFavorite: true })).body!);
    expect(success).toMatchObject({ updatedCount: 1, failedCount: 0 });
    expect(success.partial).toBe(false);
  });
});
