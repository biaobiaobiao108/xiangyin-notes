import { afterEach, beforeEach, expect, test } from "bun:test";
import { openDatabase, type SqliteDatabase } from "../server/db";
import { handleRequest } from "../server/index";
import { waitForOrphanAssetCleanup } from "../server/routes/assets";
import { BACKLINK_MENTION_LIMIT, BACKLINK_REFERENCE_LIMIT } from "../server/core";

let database: SqliteDatabase;
let cookie: string;
let notebookId: string;
const environment = {
  XIANGYING_USERNAME: "owner",
  XIANGYING_PASSWORD: "backlinks test passphrase 1234",
};

async function request(path: string, method = "GET", payload?: unknown) {
  const response = await handleRequest(
    new Request(`http://xiangying.test${path}`, {
      method,
      headers: cookie ? { Cookie: cookie } : undefined,
      body: payload === undefined ? undefined : JSON.stringify(payload),
    }),
    { database, environment, clientRoot: "dist/client", clientAddress: "backlinks-regression" },
  );
  const body = (await response.json()) as any;
  return { response, body };
}

beforeEach(async () => {
  database = await openDatabase(":memory:");
  cookie = "";
  const response = await handleRequest(
    new Request("http://xiangying.test/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        username: environment.XIANGYING_USERNAME,
        password: environment.XIANGYING_PASSWORD,
      }),
    }),
    { database, environment, clientRoot: "dist/client", clientAddress: crypto.randomUUID() },
  );
  cookie = response.headers.get("Set-Cookie")!.split(";", 1)[0]!;
  notebookId = (await request("/api/notebooks")).body.notebooks[0].id;
});

afterEach(async () => {
  await waitForOrphanAssetCleanup(database);
  database.close();
});

async function createNote(title: string, contentMarkdown = "") {
  const result = await request("/api/notes", "POST", { notebookId, title, contentMarkdown });
  expect(result.response.status).toBe(201);
  return result.body.note;
}

test("backlinks find short titles containing spaces and punctuation", async () => {
  const target = await createNote("a b");
  const source = await createNote("来源", "mention a b and A.B here");
  const result = await request(`/api/notes/${target.id}/backlinks`);
  expect(result.response.status).toBe(200);
  expect(result.body.unlinkedMentions).toContainEqual(
    expect.objectContaining({ sourceNoteId: source.id, matchText: "a b" }),
  );
});

test.each(["版本  计划", "a\tb", "release  schedule"])(
  "finds a literal unlinked mention when the title contains unusual whitespace: %s",
  async (title) => {
    const target = await createNote(title);
    const source = await createNote("来源", `请跟进 ${title} 的进展`);
    const result = await request(`/api/notes/${target.id}/backlinks`);
    expect(result.response.status).toBe(200);
    expect(result.body.unlinkedMentions).toContainEqual(
      expect.objectContaining({ sourceNoteId: source.id, matchText: title }),
    );
  },
);

for (const title of ["苹果", "反链测试"]) {
  test(`repeated backlinks requests work after truncating mentions of ${title}`, async () => {
    const target = await createNote(title);
    const source = await createNote(
      "来源",
      Array.from({ length: BACKLINK_MENTION_LIMIT + 1 }, () => title).join("\n\n"),
    );
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await request(`/api/notes/${target.id}/backlinks`);
      expect(result.response.status).toBe(200);
      expect(result.body.truncated).toBe(true);
      expect(result.body.unlinkedMentions).toHaveLength(BACKLINK_MENTION_LIMIT);
      expect(result.body.unlinkedMentions[0].sourceNoteId).toBe(source.id);
    }
  });
}

test("repeated backlinks requests work after truncating linked references", async () => {
  const target = await createNote("目标笔记");
  for (let index = 0; index <= BACKLINK_REFERENCE_LIMIT; index += 1) {
    await createNote(`来源 ${index}`, `[[${target.id}|目标笔记]]`);
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await request(`/api/notes/${target.id}/backlinks`);
    expect(result.response.status).toBe(200);
    expect(result.body.truncated).toBe(true);
    expect(result.body.linkedReferences).toHaveLength(BACKLINK_REFERENCE_LIMIT);
  }
});

test("paginates all linked references and repeated mentions without gaps", async () => {
  const target = await createNote("分页目标");
  const source = await createNote(
    "重复提及",
    Array.from({ length: BACKLINK_MENTION_LIMIT + 17 }, () => "分页目标").join("\n\n"),
  );
  for (let index = 0; index < BACKLINK_REFERENCE_LIMIT + 5; index++)
    await createNote(`引用 ${index}`, `[[${target.id}|分页目标]]`);
  const links = new Set<string>();
  const positions = new Set<number>();
  let cursor: string | null = null;
  let pages = 0;
  do {
    const result = await request(
      `/api/notes/${target.id}/backlinks${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    expect(result.response.status).toBe(200);
    for (const link of result.body.linkedReferences) {
      expect(links.has(link.id)).toBe(false);
      links.add(link.id);
    }
    for (const mention of result.body.unlinkedMentions)
      if (mention.sourceNoteId === source.id) {
        expect(positions.has(mention.matchIndex)).toBe(false);
        positions.add(mention.matchIndex);
      }
    cursor = result.body.nextCursor;
    expect(++pages).toBeLessThan(10);
  } while (cursor);
  expect(links.size).toBe(BACKLINK_REFERENCE_LIMIT + 5);
  expect(positions.size).toBe(BACKLINK_MENTION_LIMIT + 17);
});

test("continues at the next note when the mention page ends exactly at a note boundary", async () => {
  const target = await createNote("边界目标");
  for (let index = 0; index < BACKLINK_MENTION_LIMIT + 1; index++)
    await createNote(`来源 ${index}`, "边界目标");
  const first = await request(`/api/notes/${target.id}/backlinks`);
  expect(first.body.unlinkedMentions).toHaveLength(BACKLINK_MENTION_LIMIT);
  const second = await request(
    `/api/notes/${target.id}/backlinks?cursor=${encodeURIComponent(first.body.nextCursor)}`,
  );
  expect(second.body.unlinkedMentions).toHaveLength(1);
  expect(second.body.nextCursor).toBeNull();
  expect(
    new Set(
      [...first.body.unlinkedMentions, ...second.body.unlinkedMentions].map(
        (item: { sourceNoteId: string }) => item.sourceNoteId,
      ),
    ).size,
  ).toBe(BACKLINK_MENTION_LIMIT + 1);
});

for (const trashedRole of ["source", "target"] as const) {
  test(`link mention rejects a trashed ${trashedRole} and preserves the source`, async () => {
    const target = await createNote("苹果");
    const source = await createNote("来源", "苹果在这里");
    const trashed = trashedRole === "source" ? source : target;
    const deletion = await request(`/api/notes/${trashed.id}`, "PATCH", {
      version: trashed.version,
      deleted: true,
    });
    expect(deletion.response.status).toBe(200);
    const before = (await request(`/api/notes/${source.id}`)).body.note;
    const result = await request(`/api/notes/${target.id}/link-mention`, "POST", {
      sourceNoteId: source.id,
      sourceVersion: before.version,
      matchStart: 0,
      matchEnd: 2,
      matchText: "苹果",
    });
    expect(result.response.status).toBe(409);
    expect(result.body.error.code).toBe("NOTE_IN_TRASH");
    const after = (await request(`/api/notes/${source.id}`)).body.note;
    expect(after.contentMarkdown).toBe(before.contentMarkdown);
    expect(after.version).toBe(before.version);
    expect(after.deletedAt).toBe(before.deletedAt);
  });
}

test("link mention rejects replacements that would exceed the note content limit", async () => {
  const target = await createNote("苹果");
  const prefix = "x".repeat(999_998);
  const source = await createNote("来源", `${prefix}苹果`);
  const result = await request(`/api/notes/${target.id}/link-mention`, "POST", {
    sourceNoteId: source.id,
    sourceVersion: source.version,
    matchStart: prefix.length,
    matchEnd: prefix.length + 2,
    matchText: "苹果",
  });
  expect(source.contentMarkdown.length).toBe(1_000_000);
  expect(result.response.status).toBe(413);
  expect(result.body.error.code).toBe("NOTE_TOO_LARGE");
  const after = (await request(`/api/notes/${source.id}`)).body.note;
  expect(after.contentMarkdown).toBe(source.contentMarkdown);
  expect(after.version).toBe(source.version);
});

test("link mention rechecks the target after reading a delayed request body", async () => {
  const oldTitle = "原目标";
  const target = await createNote(oldTitle);
  const source = await createNote("来源", oldTitle);
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let onRead!: () => void;
  const reading = new Promise<void>((resolve) => {
    onRead = resolve;
  });
  const body = new ReadableStream<Uint8Array>(
    {
      start: (stream) => {
        controller = stream;
      },
      pull: () => onRead(),
    },
    { highWaterMark: 0 },
  );
  const linking = handleRequest(
    new Request(`http://xiangying.test/api/notes/${target.id}/link-mention`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body,
    }),
    { database, environment },
  );
  await Promise.race([
    reading,
    linking.then(() => {
      throw new Error("Request finished before reading the body");
    }),
  ]);
  const renamed = await request(`/api/notes/${target.id}`, "PATCH", {
    title: "改名后的目标",
    version: target.version,
  });
  expect(renamed.response.status).toBe(200);
  await createNote(oldTitle, "另一篇笔记");
  controller.enqueue(
    new TextEncoder().encode(
      JSON.stringify({
        sourceNoteId: source.id,
        sourceVersion: source.version,
        matchStart: 0,
        matchEnd: oldTitle.length,
        matchText: oldTitle,
      }),
    ),
  );
  controller.close();

  const response = await linking;
  expect(response.status).toBe(409);
  expect((await response.json()).error.code).toBe("MENTION_STALE");
  const { body: latest } = await request(`/api/notes/${source.id}`);
  expect(latest.note).toMatchObject({ contentMarkdown: oldTitle, version: source.version });
});

test("link mention uses the chosen UUID even when the source has the same title", async () => {
  const title = "同名笔记";
  const source = await createNote(title, title);
  const target = await createNote(title);
  const updateTime = database.query("UPDATE notes SET updated_at = ? WHERE id = ?");
  updateTime.run(1, source.id);
  updateTime.run(2, target.id);

  const linking = await request(`/api/notes/${target.id}/link-mention`, "POST", {
    sourceNoteId: source.id,
    sourceVersion: source.version,
    matchStart: 0,
    matchEnd: title.length,
    matchText: title,
  });
  expect(linking.response.status).toBe(200);
  const { body: latest } = await request(`/api/notes/${source.id}`);
  expect(latest.note).toMatchObject({
    contentMarkdown: `[[${target.id}|${title}]]`,
    version: source.version + 1,
  });
});

for (const limit of ["content", "former term-count"] as const) {
  test(`backlinks find a short-title mention beyond the ${limit} boundary`, async () => {
    const target = await createNote("苹果");
    const prefix =
      limit === "content"
        ? "甲".repeat(40_100)
        : Array.from({ length: 600 }, (_, index) => String.fromCodePoint(0x4e00 + index)).join(" ");
    const content = `${prefix}\n苹果在这里`;
    const source = await createNote("来源", content);
    const result = await request(`/api/notes/${target.id}/backlinks`);
    expect(result.response.status).toBe(200);
    expect(result.body.truncated).toBe(false);
    expect(result.body.unlinkedMentions).toHaveLength(1);
    expect(result.body.unlinkedMentions[0]).toMatchObject({
      sourceNoteId: source.id,
      matchIndex: prefix.length + 1,
      matchText: "苹果",
      sourceVersion: source.version,
    });
  });
}
