import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations, openDatabase, type SqliteDatabase } from "../server/db";
import { handleRequest } from "../server/index";
import type { Note, NoteBacklinksResponse } from "../shared/types";

let database: SqliteDatabase;
let assetRoot: string;
let clientAddress: string;
const environment: Record<string, string | undefined> = {
  XIANGYING_USERNAME: "owner",
  XIANGYING_PASSWORD: "a long passphrase 1234",
};

beforeEach(async () => {
  database = await openDatabase(":memory:");
  await applyMigrations(database);
  assetRoot = join(tmpdir(), `xiangying-notes-assets-${crypto.randomUUID()}`);
  clientAddress = `test-${crypto.randomUUID()}`;
});

afterEach(async () => {
  database.close();
  await rm(assetRoot, { recursive: true, force: true });
});

async function request(path: string, init: RequestInit = {}, cookie?: string) {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("Cookie", cookie);
  const response = await handleRequest(
    new Request(`http://xiangying.test${path}`, { ...init, headers }),
    { database, environment, clientRoot: "dist/client", assetRoot, clientAddress },
  );
  const body = (await response.json().catch(() => null)) as Record<string, any> | null;
  return { response, body, cookie: response.headers.get("Set-Cookie")?.split(";", 1)[0] };
}

describe("Note links, backlinks, and renaming cascade", () => {
  test("creates links, queries backlinks and unlinked mentions, and cascades title updates", async () => {
    // 1. Authenticate
    const auth = await request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "a long passphrase 1234" }),
    });
    expect(auth.response.status).toBe(200);
    const cookie = auth.cookie!;

    // 2. Create Target Note B
    const createB = await request("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "架构设计", contentMarkdown: "这是系统的核心架构说明。" }),
    }, cookie);
    expect(createB.response.status).toBe(201);
    const noteB = createB.body?.note as Note;
    expect(noteB).toBeDefined();

    // 3. Create Note A with explicit Wiki-link [[架构设计]]
    const createA = await request("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "前端规划", contentMarkdown: "前端页面请参考 [[架构设计]] 规范编写。" }),
    }, cookie);
    expect(createA.response.status).toBe(201);
    const noteA = createA.body?.note as Note;

    // 4. Create Note C with plain text mention of "架构设计"
    const createC = await request("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "项目总结", contentMarkdown: "回顾本次工作，架构设计 非常关键。" }),
    }, cookie);
    expect(createC.response.status).toBe(201);
    const noteC = createC.body?.note as Note;

    // 5. Query backlinks for Note B
    const backlinksB = await request(`/api/notes/${noteB.id}/backlinks`, { method: "GET" }, cookie);
    expect(backlinksB.response.status).toBe(200);
    const backlinksPayload = backlinksB.body as NoteBacklinksResponse;

    // Verify linked references contains Note A
    expect(backlinksPayload.linkedReferences).toHaveLength(1);
    expect(backlinksPayload.linkedReferences[0].sourceNoteId).toBe(noteA.id);
    expect(backlinksPayload.linkedReferences[0].sourceNoteTitle).toBe("前端规划");
    expect(backlinksPayload.linkedReferences[0].snippet).toContain("[[架构设计]]");

    // Verify unlinked mentions contains Note C
    expect(backlinksPayload.unlinkedMentions).toHaveLength(1);
    expect(backlinksPayload.unlinkedMentions[0].sourceNoteId).toBe(noteC.id);
    expect(backlinksPayload.unlinkedMentions[0].sourceNoteTitle).toBe("项目总结");
    expect(backlinksPayload.unlinkedMentions[0].snippet).toContain("架构设计");

    // 6. Test link-mention endpoint to convert Note C's mention into a Wiki-link
    const mention = backlinksPayload.unlinkedMentions[0];
    const linkRes = await request(`/api/notes/${noteB.id}/link-mention`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceNoteId: mention.sourceNoteId,
        sourceVersion: mention.sourceVersion,
        matchStart: mention.matchIndex,
        matchEnd: mention.matchIndex + mention.matchText.length,
        matchText: mention.matchText,
      }),
    }, cookie);
    expect(linkRes.response.status).toBe(200);

    // Verify Note C was updated
    const getC = await request(`/api/notes/${noteC.id}`, { method: "GET" }, cookie);
    expect(getC.body?.note.contentMarkdown).toBe("回顾本次工作，[[架构设计]] 非常关键。");

    // Backlinks for Note B should now have 2 linked references and 0 unlinked mentions
    const backlinksB2 = await request(`/api/notes/${noteB.id}/backlinks`, { method: "GET" }, cookie);
    expect(backlinksB2.body?.linkedReferences).toHaveLength(2);
    expect(backlinksB2.body?.unlinkedMentions).toHaveLength(0);

    // 7. Rename Note B from "架构设计" to "系统架构"
    const renameRes = await request(`/api/notes/${noteB.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: noteB.version, title: "系统架构" }),
    }, cookie);
    expect(renameRes.response.status).toBe(200);

    // Verify Note A's content was cascaded to [[系统架构]]
    const getA = await request(`/api/notes/${noteA.id}`, { method: "GET" }, cookie);
    expect(getA.body?.note.contentMarkdown).toBe("前端页面请参考 [[系统架构]] 规范编写。");

    // Verify Note C's content was cascaded to [[系统架构]]
    const getC2 = await request(`/api/notes/${noteC.id}`, { method: "GET" }, cookie);
    expect(getC2.body?.note.contentMarkdown).toBe("回顾本次工作，[[系统架构]] 非常关键。");

    // 8. Delete Note A and check backlinks
    await request(`/api/notes/${noteA.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: getA.body?.note.version, deleted: true }),
    }, cookie);
    const deleteRes = await request(`/api/notes/${noteA.id}`, { method: "DELETE" }, cookie);
    expect(deleteRes.response.status).toBe(200);

    const backlinksB3 = await request(`/api/notes/${noteB.id}/backlinks`, { method: "GET" }, cookie);
    expect(backlinksB3.body?.linkedReferences).toHaveLength(1);
    expect(backlinksB3.body?.linkedReferences[0].sourceNoteId).toBe(noteC.id);
  });

  test("matches links with case and space tolerance and links to newly created target note", async () => {
    const auth = await request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "a long passphrase 1234" }),
    });
    const cookie = auth.cookie!;

    // 1. Create a note referencing an uncreated note with whitespace and uppercase
    const createRes1 = await request("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "文章一", contentMarkdown: "请阅读 [[ TypeScript 教程 ]] 深入了解。" }),
    }, cookie);
    expect(createRes1.response.status).toBe(201);
    const note1 = createRes1.body?.note as Note;

    // 2. Now create the target note with normalized title
    const createRes2 = await request("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "typescript 教程", contentMarkdown: "这是内容。" }),
    }, cookie);
    expect(createRes2.response.status).toBe(201);
    const note2 = createRes2.body?.note as Note;

    // 3. Query backlinks for note2, it should link to note1 despite case/whitespace differences
    const backlinks2 = await request(`/api/notes/${note2.id}/backlinks`, { method: "GET" }, cookie);
    expect(backlinks2.body?.linkedReferences).toHaveLength(1);
    expect(backlinks2.body?.linkedReferences[0].sourceNoteId).toBe(note1.id);

    const renameRes = await request(`/api/notes/${note2.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: note2.version, title: "TypeScript 指南" }),
    }, cookie);
    expect(renameRes.response.status).toBe(200);
    const renamedSource = await request(`/api/notes/${note1.id}`, { method: "GET" }, cookie);
    expect(renamedSource.body?.note.contentMarkdown).toBe("请阅读 [[TypeScript 指南]] 深入了解。");
  });

  test("finds an existing normalized wiki target instead of creating a duplicate", async () => {
    const auth = await request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "a long passphrase 1234" }),
    });
    const cookie = auth.cookie!;
    const created = await request("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "TypeScript", contentMarkdown: "existing" }),
    }, cookie);
    const existing = created.body?.note as Note;

    const ensured = await request("/api/wiki-notes/ensure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "ＴＹＰＥＳＣＲＩＰＴ", notebookId: existing.notebookId }),
    }, cookie);
    expect(ensured.response.status).toBe(200);
    expect(ensured.body?.created).toBe(false);
    expect(ensured.body?.note.id).toBe(existing.id);

    const listed = await request("/api/notes?view=all", { method: "GET" }, cookie);
    expect(listed.body?.total).toBe(2);
  });

  test("rejects a stale unlinked mention range without changing the source note", async () => {
    const auth = await request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "a long passphrase 1234" }),
    });
    const cookie = auth.cookie!;
    const targetResponse = await request("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "目标笔记", contentMarkdown: "" }),
    }, cookie);
    const target = targetResponse.body?.note as Note;
    const sourceResponse = await request("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "来源", contentMarkdown: "这里提到目标笔记。" }),
    }, cookie);
    const source = sourceResponse.body?.note as Note;
    const backlinks = await request(`/api/notes/${target.id}/backlinks`, { method: "GET" }, cookie);
    const mention = backlinks.body?.unlinkedMentions[0];

    const changed = await request(`/api/notes/${source.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: source.version, contentMarkdown: "前缀变化，这里提到目标笔记。" }),
    }, cookie);
    expect(changed.response.status).toBe(200);

    const stale = await request(`/api/notes/${target.id}/link-mention`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceNoteId: source.id,
        sourceVersion: mention.sourceVersion,
        matchStart: mention.matchIndex,
        matchEnd: mention.matchIndex + mention.matchText.length,
        matchText: mention.matchText,
      }),
    }, cookie);
    expect(stale.response.status).toBe(409);
    expect(stale.body?.error.code).toBe("MENTION_STALE");

    const latest = await request(`/api/notes/${source.id}`, { method: "GET" }, cookie);
    expect(latest.body?.note.contentMarkdown).toBe("前缀变化，这里提到目标笔记。");
  });

  test("rebuilds link rows for existing notes when the data migration runs", async () => {
    const auth = await request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "a long passphrase 1234" }),
    });
    const cookie = auth.cookie!;
    const targetResponse = await request("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "迁移目标", contentMarkdown: "" }),
    }, cookie);
    const target = targetResponse.body?.note as Note;
    const sourceResponse = await request("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "旧笔记", contentMarkdown: "已有链接 [[迁移目标]]" }),
    }, cookie);
    const source = sourceResponse.body?.note as Note;

    database.query("DELETE FROM note_links").run();
    database.query("DELETE FROM schema_migrations WHERE name = ?").run("0003_rebuild_note_links.sql");
    await applyMigrations(database);

    const backlinks = await request(`/api/notes/${target.id}/backlinks`, { method: "GET" }, cookie);
    expect(backlinks.body?.linkedReferences.map((item: { sourceNoteId: string }) => item.sourceNoteId)).toEqual([source.id]);
  });

  test("bounds large unlinked-mention responses and reports truncation", async () => {
    const auth = await request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "a long passphrase 1234" }),
    });
    const cookie = auth.cookie!;
    const targetResponse = await request("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "限流目标", contentMarkdown: "" }),
    }, cookie);
    const target = targetResponse.body?.note as Note;
    await request("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "大量提及", contentMarkdown: Array.from({ length: 101 }, () => "限流目标").join(" ") }),
    }, cookie);

    const backlinks = await request(`/api/notes/${target.id}/backlinks`, { method: "GET" }, cookie);
    expect(backlinks.body?.unlinkedMentions).toHaveLength(100);
    expect(backlinks.body?.truncated).toBe(true);
  });
});
