import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NOTE_PAGE_SIZE } from "../server/core";
import { applyMigrations, openDatabase, type SqliteDatabase } from "../server/db";
import { handleRequest } from "../server/index";
import { waitForOrphanAssetCleanup } from "../server/routes/assets";
import type { Note, NoteSummary } from "../shared/types";

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
  await waitForOrphanAssetCleanup(database);
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

async function signedIn() {
  const session = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "owner", password: environment.XIANGYING_PASSWORD }),
  });
  expect(session.response.status).toBe(200);
  return session.cookie!;
}

async function createNote(cookie: string, title: string, contentMarkdown = "") {
  const created = await request(
    "/api/notes",
    {
      method: "POST",
      body: JSON.stringify({ title, contentMarkdown }),
    },
    cookie,
  );
  expect(created.response.status).toBe(201);
  return created.body!.note as Note;
}

describe("UUID links and backlinks", () => {
  test("distinguishes duplicate titles and preserves links through rename, trash and deletion", async () => {
    const cookie = await signedIn();
    const original = await createNote(cookie, "同名目标");
    const duplicate = await createNote(cookie, "同名目标");
    const markdown = `正文 [[${original.id}|同名目标|别名]]，重复 [[${original.id}]]

\`[[${duplicate.id}|代码]]\`

[[同名目标]]`;
    const source = await createNote(cookie, "来源", markdown);
    const refs = async (id: string) =>
      (await request(`/api/notes/${id}/backlinks`, {}, cookie)).body!.linkedReferences;
    const titles = async (...ids: string[]) =>
      (
        await request(
          `/api/wiki-notes/titles?${new URLSearchParams(ids.map((id) => ["id", id]))}`,
          {},
          cookie,
        )
      ).body!.notes;
    const patch = (id: string, payload: Record<string, unknown>) =>
      request(
        `/api/notes/${id}`,
        {
          method: "PATCH",
          body: JSON.stringify(payload),
        },
        cookie,
      );

    const suggestions = await request(
      `/api/wiki-notes/suggestions?query=${encodeURIComponent(original.title)}`,
      {},
      cookie,
    );
    expect(suggestions.body?.exactMatch).toBe(true);
    expect(new Set(suggestions.body?.matches.map((note: Note) => note.id))).toEqual(
      new Set([original.id, duplicate.id]),
    );
    expect(await refs(original.id)).toEqual([
      expect.objectContaining({ sourceNoteId: source.id, targetNoteId: original.id }),
    ]);
    expect(await refs(duplicate.id)).toEqual([]);

    expect((await patch(original.id, { version: 1, title: "新标题" })).response.status).toBe(200);
    expect(await titles(original.id)).toEqual([{ id: original.id, title: "新标题" }]);
    expect((await request(`/api/notes/${source.id}`, {}, cookie)).body?.note).toMatchObject({
      version: source.version,
      contentMarkdown: markdown,
    });
    expect(await refs(original.id)).toHaveLength(1);

    expect((await patch(original.id, { version: 2, deleted: true })).response.status).toBe(200);
    expect(await titles(original.id)).toEqual([]);
    expect((await patch(original.id, { version: 3, deleted: false })).response.status).toBe(200);
    expect(await refs(original.id)).toHaveLength(1);
    expect((await patch(original.id, { version: 4, deleted: true })).response.status).toBe(200);
    expect(
      (
        await request(
          `/api/notes/${original.id}`,
          { method: "DELETE", body: JSON.stringify({ version: 5 }) },
          cookie,
        )
      ).response.status,
    ).toBe(200);

    const replacement = await createNote(cookie, "新标题");
    expect(await refs(replacement.id)).toEqual([]);
    expect(await titles(original.id)).toEqual([]);
    expect(
      database
        .query("SELECT target_note_id FROM note_links WHERE source_note_id = ?")
        .get(source.id),
    ).toEqual({ target_note_id: original.id });
  });

  test("searches live link titles and aliases across mixed terms without rewriting the source", async () => {
    const cookie = await signedIn();
    const target = await createNote(cookie, "海岛旧计划", "靐 目标私有文字");
    const extra = await createNote(cookie, "篝火晚会");
    const other = await createNote(cookie, "孤立笔记", "替换后的旅行");
    const source = await createNote(
      cookie,
      "记录一",
      `私人备注 [[${target.id}|海岛旧计划|我的明年安排]] [[${target.id}|海岛旧计划]] [[${extra.id}|篝火晚会]]`,
    );
    const aliased = await createNote(cookie, "记录二", `[[${target.id}|海岛旧计划|专用别名]]`);
    const direct = await createNote(cookie, "直接命中", `替换后的旅行 [[${target.id}|海岛旧计划]]`);
    const search = async (query: string, params = {}) => {
      const result = await request(
        `/api/notes?${new URLSearchParams({ query, includeMatch: "1", ...params })}`,
        {},
        cookie,
      );
      expect(result.response.status).toBe(200);
      const { notes, total, nextCursor } = result.body! as {
        notes: NoteSummary[];
        total: number;
        nextCursor?: string;
      };
      return { notes, total, nextCursor, ids: notes.map((note) => note.id) };
    };
    const rename = await request(
      `/api/notes/${target.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ title: "替换后的旅行", version: target.version }),
      },
      cookie,
    );
    expect(rename.response.status).toBe(200);

    const current = await search("替换后的旅行", { sort: "relevance", limit: "2" });
    expect(current.total).toBe(4);
    const second = await search("替换后的旅行", {
      sort: "relevance",
      limit: "2",
      cursor: current.nextCursor!,
    });
    expect(new Set([...current.ids, ...second.ids])).toEqual(
      new Set([target.id, direct.id, other.id, source.id]),
    );
    expect(second.notes.find((note) => note.id === source.id)?.match).toEqual({
      field: "content",
      snippet: "替换后的旅行",
    });
    expect((await search("海岛旧计划")).ids).toEqual([]);
    expect((await search("专用别名")).ids).toEqual([aliased.id]);
    expect((await search("私人备注 旅行")).ids).toEqual([source.id]);
    expect((await search("替")).ids).toContain(source.id);
    expect((await search("篝火晚会 替换后的旅行 我的明年安排")).ids).toEqual([source.id]);
    expect((await search("靐")).ids).toEqual([target.id]);
    expect((await search("目标私有文字")).ids).toEqual([target.id]);
    expect((await request(`/api/notes/${source.id}`, {}, cookie)).body?.note).toMatchObject({
      version: source.version,
      contentMarkdown: source.contentMarkdown,
    });

    const movedToTrash = await request(
      `/api/notes/${target.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ deleted: true, version: target.version + 1 }),
      },
      cookie,
    );
    expect(movedToTrash.response.status).toBe(200);
    expect((await search("替换后的旅行")).ids).not.toContain(source.id);
    expect((await search("专用别名")).ids).toEqual([aliased.id]);
    expect(
      (
        await request(
          `/api/notes/${target.id}`,
          {
            method: "PATCH",
            body: JSON.stringify({ deleted: false, version: target.version + 2 }),
          },
          cookie,
        )
      ).response.status,
    ).toBe(200);
    expect((await search("旅行")).ids).toContain(source.id);

    const edit = await request(
      `/api/notes/${source.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          version: source.version,
          contentMarkdown: `[[${target.id}|海岛旧计划|编辑后的别名]]`,
        }),
      },
      cookie,
    );
    expect(edit.response.status).toBe(200);
    expect((await search("旅行")).ids).not.toContain(source.id);
    expect((await search("编辑后的别名")).ids).toEqual([source.id]);
  });

  test("does not expose another owner's titles or backlink sources", async () => {
    const cookie = await signedIn();
    const foreignUser = crypto.randomUUID();
    const foreignNotebook = crypto.randomUUID();
    const foreignNote = crypto.randomUUID();
    database.exec("PRAGMA foreign_keys = ON");
    database
      .query(
        "INSERT INTO users (id, username, password_hash, password_salt, created_at) VALUES (?, ?, 'hash', 'salt', 1)",
      )
      .run(foreignUser, foreignUser);
    database
      .query(
        "INSERT INTO notebooks (id, user_id, name, created_at, updated_at) VALUES (?, ?, '私有笔记本', 1, 1)",
      )
      .run(foreignNotebook, foreignUser);
    database
      .query(
        "INSERT INTO notes (id, user_id, notebook_id, title, content_markdown, created_at, updated_at) VALUES (?, ?, ?, '私有标题', '', 1, 1)",
      )
      .run(foreignNote, foreignUser, foreignNotebook);
    await createNote(cookie, "来源", `[[${foreignNote}|自定义显示]]`);
    expect(
      (await request(`/api/wiki-notes/titles?id=${foreignNote}`, {}, cookie)).body?.notes,
    ).toEqual([]);
    expect(
      (await request(`/api/notes?query=${encodeURIComponent("私有标题")}`, {}, cookie)).body?.notes,
    ).toEqual([]);
    expect((await request(`/api/notes/${foreignNote}/backlinks`, {}, cookie)).response.status).toBe(
      404,
    );
  });

  test("searches wiki targets outside the current note page and detects exact titles", async () => {
    const auth = await request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "owner", password: environment.XIANGYING_PASSWORD }),
    });
    const cookie = auth.cookie!;
    const targetResponse = await request(
      "/api/notes",
      {
        method: "POST",
        body: JSON.stringify({ title: "页外 Wiki 目标", contentMarkdown: "" }),
      },
      cookie,
    );
    const target = targetResponse.body?.note as Note;
    database.query("UPDATE notes SET updated_at = 1 WHERE id = ?").run(target.id);

    for (let index = 0; index < NOTE_PAGE_SIZE + 1; index += 1) {
      await request(
        "/api/notes",
        {
          method: "POST",
          body: JSON.stringify({ title: `分页填充 ${index}`, contentMarkdown: "" }),
        },
        cookie,
      );
    }

    const currentPage = await request("/api/notes?view=all", { method: "GET" }, cookie);
    expect(currentPage.body?.notes.some((note: Note) => note.id === target.id)).toBe(false);

    const suggestions = await request(
      "/api/wiki-notes/suggestions?query=Wiki%20%E7%9B%AE%E6%A0%87",
      { method: "GET" },
      cookie,
    );
    expect(suggestions.response.status).toBe(200);
    expect(suggestions.body?.exactMatch).toBe(false);
    expect(suggestions.body?.matches).toContainEqual({
      id: target.id,
      title: "页外 Wiki 目标",
      notebookName: expect.any(String),
    });

    const exact = await request(
      "/api/wiki-notes/suggestions?query=%E9%A1%B5%E5%A4%96%20wiki%20%E7%9B%AE%E6%A0%87",
      { method: "GET" },
      cookie,
    );
    expect(exact.body?.exactMatch).toBe(true);
    expect(exact.body?.matches[0].title).toBe("页外 Wiki 目标");
  });

  test("rejects a stale unlinked mention range without changing the source note", async () => {
    const auth = await request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "a long passphrase 1234" }),
    });
    const cookie = auth.cookie!;
    const targetResponse = await request(
      "/api/notes",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "目标笔记", contentMarkdown: "" }),
      },
      cookie,
    );
    const target = targetResponse.body?.note as Note;
    const sourceResponse = await request(
      "/api/notes",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "来源", contentMarkdown: "这里提到目标笔记。" }),
      },
      cookie,
    );
    const source = sourceResponse.body?.note as Note;
    const backlinks = await request(`/api/notes/${target.id}/backlinks`, { method: "GET" }, cookie);
    const mention = backlinks.body?.unlinkedMentions[0];

    const changed = await request(
      `/api/notes/${source.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version: source.version,
          contentMarkdown: "前缀变化，这里提到目标笔记。",
        }),
      },
      cookie,
    );
    expect(changed.response.status).toBe(200);

    const stale = await request(
      `/api/notes/${target.id}/link-mention`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceNoteId: source.id,
          sourceVersion: mention.sourceVersion,
          matchStart: mention.matchIndex,
          matchEnd: mention.matchIndex + mention.matchText.length,
          matchText: mention.matchText,
        }),
      },
      cookie,
    );
    expect(stale.response.status).toBe(409);
    expect(stale.body?.error.code).toBe("MENTION_STALE");

    const latest = await request(`/api/notes/${source.id}`, { method: "GET" }, cookie);
    expect(latest.body?.note.contentMarkdown).toBe("前缀变化，这里提到目标笔记。");
  });

  test("bounds large unlinked-mention responses and reports truncation", async () => {
    const auth = await request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "a long passphrase 1234" }),
    });
    const cookie = auth.cookie!;
    const targetResponse = await request(
      "/api/notes",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "限流目标", contentMarkdown: "" }),
      },
      cookie,
    );
    const target = targetResponse.body?.note as Note;
    await request(
      "/api/notes",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "大量提及",
          contentMarkdown: Array.from({ length: 101 }, () => "限流目标").join(" "),
        }),
      },
      cookie,
    );

    const backlinks = await request(`/api/notes/${target.id}/backlinks`, { method: "GET" }, cookie);
    expect(backlinks.body?.unlinkedMentions).toHaveLength(100);
    expect(backlinks.body?.truncated).toBe(true);
  });

  test("handles concurrent backlink queries safely without statement misuse", async () => {
    const auth = await request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "a long passphrase 1234" }),
    });
    const cookie = auth.cookie!;
    const target = (
      await request(
        "/api/notes",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "未带", contentMarkdown: "短标题笔记" }),
        },
        cookie,
      )
    ).body?.note as Note;

    await request(
      "/api/notes",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "引用来源", contentMarkdown: "这里提到了未带的内容" }),
      },
      cookie,
    );

    const responses = await Promise.all([
      request(`/api/notes/${target.id}/backlinks`, { method: "GET" }, cookie),
      request(`/api/notes/${target.id}/backlinks`, { method: "GET" }, cookie),
      request(`/api/notes/${target.id}/backlinks`, { method: "GET" }, cookie),
    ]);

    for (const res of responses) {
      expect(res.response.status).toBe(200);
      expect(res.body?.unlinkedMentions).toHaveLength(1);
    }
  });

  test("persists snippet in note_links and reads it directly", async () => {
    const auth = await request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "a long passphrase 1234" }),
    });
    const cookie = auth.cookie!;

    // Create target note
    const targetRes = await request(
      "/api/notes",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "性能目标", contentMarkdown: "性能优化的核心文档" }),
      },
      cookie,
    );
    const target = targetRes.body?.note as Note;

    // Create source note with wiki link
    const sourceRes = await request(
      "/api/notes",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "来源一",
          contentMarkdown: `我们在项目中强烈推荐 [[${target.id}|性能目标]]。`,
        }),
      },
      cookie,
    );
    const source = sourceRes.body?.note as Note;

    // Verify snippet is stored in note_links
    const storedLink = database
      .query("SELECT snippet FROM note_links WHERE source_note_id = ?")
      .get(source.id) as { snippet: string };
    expect(storedLink).toBeDefined();
    expect(storedLink.snippet).toContain(`[[${target.id}|性能目标]]`);

    // Query backlinks and verify snippet
    const backlinks = await request(`/api/notes/${target.id}/backlinks`, { method: "GET" }, cookie);
    expect(backlinks.response.status).toBe(200);
    expect(backlinks.body?.linkedReferences).toHaveLength(1);
    expect(backlinks.body?.linkedReferences[0].snippet).toBe(storedLink.snippet);
  });

  test("finds unlinked mentions of 2-character titles", async () => {
    const auth = await request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "a long passphrase 1234" }),
    });
    const cookie = auth.cookie!;

    // Target note with 2-character title
    const targetRes = await request(
      "/api/notes",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "规范", contentMarkdown: "各种编码与设计规范" }),
      },
      cookie,
    );
    const target = targetRes.body?.note as Note;

    // Source note containing unlinked mention of "规范"
    await request(
      "/api/notes",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "开发指南",
          contentMarkdown: "所有团队成员都必须严格遵守 规范 开展工作。",
        }),
      },
      cookie,
    );

    // The backlinks API should discover the short-title mention.
    const backlinks = await request(`/api/notes/${target.id}/backlinks`, { method: "GET" }, cookie);
    expect(backlinks.body?.unlinkedMentions).toHaveLength(1);
    expect(backlinks.body?.unlinkedMentions[0].sourceNoteTitle).toBe("开发指南");
    expect(backlinks.body?.unlinkedMentions[0].snippet).toContain("规范");
  });
});
