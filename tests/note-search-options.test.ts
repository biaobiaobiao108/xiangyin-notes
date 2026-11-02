import { expect, test } from "bun:test";
import { openDatabase } from "../server/db";
import { handleRequest } from "../server/index";
import { waitForOrphanAssetCleanup } from "../server/routes/assets";
import { ensureEnvironmentUser } from "../server/routes/auth";
import { createNote } from "../server/routes/notes";
import { MAX_SHORT_INDEX_TOKENS } from "../server/note-search";

async function fixture() {
  const database = await openDatabase(":memory:");
  const environment = {
    XIANGYING_USERNAME: "search-owner",
    XIANGYING_PASSWORD: "search-test-password",
  };
  const user = await ensureEnvironmentUser(database, {
    username: environment.XIANGYING_USERNAME,
    password: environment.XIANGYING_PASSWORD,
  });
  const inbox = database
    .query("SELECT id FROM notebooks WHERE user_id = ? AND is_system = 1")
    .get(user.id) as { id: string };
  database.query("DELETE FROM notes WHERE user_id = ?").run(user.id);
  const login = await handleRequest(
    new Request("http://search.test/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        username: environment.XIANGYING_USERNAME,
        password: environment.XIANGYING_PASSWORD,
      }),
    }),
    { database, environment },
  );
  const cookie = login.headers.get("Set-Cookie")!.split(";", 1)[0]!;
  return {
    database,
    create: (title: string, content: string) =>
      createNote(database, user.id, inbox.id, title, content),
    list: (params: string) =>
      handleRequest(
        new Request(`http://search.test/api/notes?${params}`, { headers: { Cookie: cookie } }),
        { database, environment },
      ),
    update: (noteId: string, payload: unknown) =>
      handleRequest(
        new Request(`http://search.test/api/notes/${noteId}`, {
          method: "PATCH",
          headers: { Cookie: cookie },
          body: JSON.stringify(payload),
        }),
        { database, environment },
      ),
  };
}

test("multiple tag filters run before pagination, support any/all, and validate every tag", async () => {
  const f = await fixture();
  try {
    const both = f.create("both", "#alpha #beta");
    const alpha = f.create("alpha", "#alpha");
    f.create("other", "#other");
    const all = await (await f.list("tags=alpha&tags=beta&limit=1&includeMatch=1")).json();
    expect(all.notes.map((note: { id: string }) => note.id)).toEqual([both]);
    expect(all.total).toBe(1);
    expect(all.notes[0].match).toEqual({ field: "tag" });
    const any = await (await f.list("tags=alpha&tags=beta&tagMode=any&limit=1")).json();
    expect(any.total).toBe(2);
    expect(any.hasMore).toBe(true);
    expect(any.notes[0]).not.toHaveProperty("match");
    const next = await (
      await f.list(`tags=alpha&tags=beta&tagMode=any&limit=1&cursor=${any.nextCursor}`)
    ).json();
    expect(new Set([...any.notes, ...next.notes].map((note: { id: string }) => note.id))).toEqual(
      new Set([both, alpha]),
    );
    expect((await f.list("tags=alpha&tags=bad%20tag")).status).toBe(400);
    expect((await f.list("tagMode=invalid")).status).toBe(400);
  } finally {
    await waitForOrphanAssetCleanup(f.database);
    f.database.close();
  }
});

test("relevance prioritizes title matches, cursors retain scores and reject changed searches", async () => {
  const f = await fixture();
  try {
    const title = f.create("needle", "a short note #alpha");
    const body = f.create("body", `${"padding ".repeat(1500)}needle useful context #alpha`);
    const another = f.create("another", "needle secondary context #alpha");
    const first = await (await f.list("query=needle&sort=relevance&includeMatch=1&limit=1")).json();
    expect(first.notes[0].id).toBe(title);
    expect(first.notes[0].match).toEqual({ field: "title" });
    const second = await (
      await f.list(`query=needle&sort=relevance&includeMatch=1&limit=1&cursor=${first.nextCursor}`)
    ).json();
    const third = await (
      await f.list(`query=needle&sort=relevance&includeMatch=1&limit=1&cursor=${second.nextCursor}`)
    ).json();
    expect(new Set([first.notes[0].id, second.notes[0].id, third.notes[0].id])).toEqual(
      new Set([title, body, another]),
    );
    const bodyNote = [...second.notes, ...third.notes].find(
      (note: { id: string }) => note.id === body,
    );
    expect(bodyNote.match.field).toBe("content");
    expect(bodyNote.match.snippet).toContain("needle");
    expect(bodyNote.match.snippet.length).toBeLessThanOrEqual(200);
    expect((await f.list(`query=secondary&sort=relevance&cursor=${first.nextCursor}`)).status).toBe(
      400,
    );
    expect(
      (await f.list(`query=needle&sort=relevance&tags=alpha&cursor=${first.nextCursor}`)).status,
    ).toBe(400);
  } finally {
    await waitForOrphanAssetCleanup(f.database);
    f.database.close();
  }
});

test("short-term relevance paginates ties and relevance without a query falls back to updated", async () => {
  const f = await fixture();
  try {
    const title = f.create("猫", "title result");
    const a = f.create("a", "猫");
    const b = f.create("b", "猫");
    f.database.query("UPDATE notes SET updated_at = 100 WHERE id = ?").run(title);
    f.database.query("UPDATE notes SET updated_at = 200 WHERE id = ?").run(a);
    f.database.query("UPDATE notes SET updated_at = 300 WHERE id = ?").run(b);
    let cursor = "";
    const ids: string[] = [];
    for (let page = 0; page < 3; page++) {
      const result = await (
        await f.list(`query=猫&sort=relevance&limit=1${cursor ? `&cursor=${cursor}` : ""}`)
      ).json();
      ids.push(result.notes[0].id);
      cursor = result.nextCursor ?? "";
    }
    expect(ids[0]).toBe(title);
    expect(new Set(ids)).toEqual(new Set([title, a, b]));
    const plain = await (await f.list("sort=relevance")).json();
    expect(plain.notes.map((note: { id: string }) => note.id)).toEqual([b, a, title]);
  } finally {
    await waitForOrphanAssetCleanup(f.database);
    f.database.close();
  }
});

test("short-term relevance applies tag filters inside its ranked candidate set", async () => {
  const f = await fixture();
  try {
    f.create("猫标题", "title result #alpha");
    const matchingBody = f.create("正文命中", "猫 body result #beta");
    f.create("其他正文", "猫 body result #alpha");

    const result = await (await f.list("query=猫&sort=relevance&tags=beta&includeTotal=1")).json();

    expect(result.notes.map((note: { id: string }) => note.id)).toEqual([matchingBody]);
    expect(result.total).toBe(1);
  } finally {
    await waitForOrphanAssetCleanup(f.database);
    f.database.close();
  }
});

test("short ASCII searches match indexed mixed-case title terms", async () => {
  const f = await fixture();
  try {
    const docker = f.create("Docker", "container notes");
    for (const query of ["d", "D", "do", "Do"]) {
      const result = await (await f.list(`query=${query}`)).json();
      expect(result.notes.map((note: { id: string }) => note.id)).toContain(docker);
    }
  } finally {
    await waitForOrphanAssetCleanup(f.database);
    f.database.close();
  }
});

test("short searches preserve mixed ASCII and CJK substring matching", async () => {
  const f = await fixture();
  try {
    const note = f.create("Docker 笔记", "项目记录和猫狗日常");
    const cases = [
      ["d", note],
      ["DO", note],
      ["猫", note],
      ["猫狗", note],
      ["Docker 猫", note],
    ] as const;

    for (const [query, expected] of cases) {
      const result = await (await f.list(`query=${encodeURIComponent(query)}`)).json();
      expect(result.notes.map((item: { id: string }) => item.id)).toContain(expected);
    }

    const partial = await (await f.list("query=%E7%8C%AB%E9%B8%A1")).json();
    expect(partial.notes.map((item: { id: string }) => item.id)).not.toContain(note);
  } finally {
    await waitForOrphanAssetCleanup(f.database);
    f.database.close();
  }
});

test("short search finds terms after every content-index boundary", async () => {
  const f = await fixture();
  try {
    const afterContentLimit = f.create("边界笔记", `${"甲".repeat(40_100)}后缀词`);
    const afterTermLimit = f.create(
      "另一篇边界笔记",
      `${Array.from({ length: 520 }, (_, index) => String.fromCodePoint(0x4e00 + index)).join(" ")}尾部词`,
    );
    const afterTokenLimit = f.create(
      "超长索引笔记",
      `${Array.from({ length: MAX_SHORT_INDEX_TOKENS }, (_, index) =>
        String.fromCodePoint(0x4e00 + index),
      ).join("")}末页词`,
    );

    for (const [query, expected] of [
      ["后缀", afterContentLimit],
      ["尾部", afterTermLimit],
      ["末页", afterTokenLimit],
    ] as const) {
      const result = await (
        await f.list(`query=${encodeURIComponent(query)}&sort=relevance`)
      ).json();
      expect(result.notes.map((item: { id: string }) => item.id)).toContain(expected);
    }
  } finally {
    await waitForOrphanAssetCleanup(f.database);
    f.database.close();
  }
});

test("short search results stay inside the signed-in user's notes", async () => {
  const f = await fixture();
  try {
    const otherUser = await ensureEnvironmentUser(f.database, {
      username: "other-search-owner",
      password: "another-search-test-password",
    });
    const otherInbox = f.database
      .query("SELECT id FROM notebooks WHERE user_id = ? AND is_system = 1")
      .get(otherUser.id) as { id: string };
    const privateMatch = createNote(f.database, otherUser.id, otherInbox.id, "私人笔记", "星云");
    const ownMatch = f.create("自己的笔记", "星云");

    const result = await (await f.list("query=%E6%98%9F%E4%BA%91&sort=relevance")).json();
    const ids = result.notes.map((item: { id: string }) => item.id);
    expect(ids).toContain(ownMatch);
    expect(ids).not.toContain(privateMatch);
    expect(result.total).toBe(1);
  } finally {
    await waitForOrphanAssetCleanup(f.database);
    f.database.close();
  }
});

test("short-query cursors return every matching note once", async () => {
  const f = await fixture();
  try {
    const expected = new Set([
      f.create("猫一", "共同内容"),
      f.create("猫二", "共同内容"),
      f.create("猫三", "共同内容"),
    ]);
    f.create("狗", "无关内容");
    let cursor = "";
    const ids: string[] = [];
    while (true) {
      const result = await (
        await f.list(
          `query=%E7%8C%AB&sort=relevance&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        )
      ).json();
      ids.push(...result.notes.map((item: { id: string }) => item.id));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }

    expect(ids).toHaveLength(expected.size);
    expect(new Set(ids)).toEqual(expected);
  } finally {
    await waitForOrphanAssetCleanup(f.database);
    f.database.close();
  }
});

test("short-term indexing and fallback share a Unicode code-point boundary", async () => {
  const f = await fixture();
  try {
    const note = f.create("表情笔记", `${"😀".repeat(40_001)}末尾`);
    const result = await (await f.list("query=末尾")).json();
    expect(result.notes.map((item: { id: string }) => item.id)).toContain(note);
  } finally {
    await waitForOrphanAssetCleanup(f.database);
    f.database.close();
  }
});

test("short-search updates remove old content matches and retain shared and unrelated notes", async () => {
  const f = await fixture();
  try {
    const changed = f.create("Docker 手册", "旧词和共同词");
    const untouched = f.create("另一篇笔记", "独立内容和共同词");
    const noteResponse = (await f.database
      .query("SELECT version FROM notes WHERE id = ?")
      .get(changed)) as { version: number };
    const saved = await f.update(changed, {
      version: noteResponse.version,
      title: "SQLite 手册",
      contentMarkdown: "新词和共同词",
    });
    expect(saved.status).toBe(200);

    const search = async (query: string) =>
      (await f.list(`query=${encodeURIComponent(query)}`)).json();
    expect((await search("旧词")).notes.map((note: { id: string }) => note.id)).not.toContain(
      changed,
    );
    expect((await search("新词")).notes.map((note: { id: string }) => note.id)).toContain(changed);
    const common = await search("共同词");
    expect(new Set(common.notes.map((note: { id: string }) => note.id))).toEqual(
      new Set([changed, untouched]),
    );
  } finally {
    await waitForOrphanAssetCleanup(f.database);
    f.database.close();
  }
});

test("optimized search applies view and notebook filters before counting and paging", async () => {
  const f = await fixture();
  try {
    const favorite = f.create("needle favorite", "needle in inbox");
    const plain = f.create("needle plain", "needle in inbox");
    const otherNotebookId = crypto.randomUUID();
    f.database
      .query(
        "INSERT INTO notebooks (id, user_id, name, created_at, updated_at) VALUES (?, (SELECT user_id FROM notes WHERE id = ?), ?, 1, 1)",
      )
      .run(otherNotebookId, favorite, "另一本");
    const other = f.create("needle other", "needle in another notebook");
    f.database.query("UPDATE notes SET notebook_id = ? WHERE id = ?").run(otherNotebookId, other);
    f.database.query("UPDATE notes SET is_favorite = 1 WHERE id = ?").run(favorite);
    const trashed = f.create("needle trashed", "needle in trash");
    f.database.query("UPDATE notes SET deleted_at = 1, is_favorite = 1 WHERE id = ?").run(trashed);

    const idsFor = async (params: string) => {
      const body = await (await f.list(`query=needle&${params}`)).json();
      return body.notes.map((note: { id: string }) => note.id);
    };
    expect(new Set(await idsFor("view=favorites"))).toEqual(new Set([favorite]));
    expect(new Set(await idsFor("view=inbox"))).toEqual(new Set([favorite, plain]));
    expect(new Set(await idsFor("view=trash"))).toEqual(new Set([trashed]));
    expect(new Set(await idsFor(`view=all&notebookId=${otherNotebookId}`))).toEqual(
      new Set([other]),
    );

    const withoutTotal = await (await f.list("query=needle&view=all&includeTotal=0")).json();
    expect(withoutTotal).not.toHaveProperty("total");
  } finally {
    await waitForOrphanAssetCleanup(f.database);
    f.database.close();
  }
});

test("mixed FTS and short terms paginate updated search without repeating rows", async () => {
  const f = await fixture();
  try {
    const first = f.create("first", "needle 猫 one");
    const second = f.create("second", "needle 猫 two");
    const third = f.create("third", "needle 猫 three");
    f.create("unrelated", "needle only");
    f.database.query("UPDATE notes SET updated_at = 100 WHERE id = ?").run(first);
    f.database.query("UPDATE notes SET updated_at = 200 WHERE id = ?").run(second);
    f.database.query("UPDATE notes SET updated_at = 300 WHERE id = ?").run(third);

    const seen: string[] = [];
    let cursor = "";
    for (let page = 0; page < 3; page += 1) {
      const result = await (
        await f.list(
          `query=${encodeURIComponent("needle 猫")}&sort=updated&limit=1&includeTotal=0${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        )
      ).json();
      expect(result).not.toHaveProperty("total");
      seen.push(...result.notes.map((note: { id: string }) => note.id));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    expect(seen).toEqual([third, second, first]);
  } finally {
    await waitForOrphanAssetCleanup(f.database);
    f.database.close();
  }
});

test("search pagination preserves title and created order", async () => {
  const f = await fixture();
  try {
    const alpha = f.create("alpha needle", "needle");
    const beta = f.create("Beta needle", "needle");
    const gamma = f.create("gamma needle", "needle");
    f.database.query("UPDATE notes SET created_at = 100 WHERE id = ?").run(alpha);
    f.database.query("UPDATE notes SET created_at = 200 WHERE id = ?").run(beta);
    f.database.query("UPDATE notes SET created_at = 300 WHERE id = ?").run(gamma);

    const collect = async (sort: string) => {
      const ids: string[] = [];
      let cursor = "";
      for (let page = 0; page < 3; page += 1) {
        const result = await (
          await f.list(
            `query=needle&sort=${sort}&limit=1&includeTotal=0${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
          )
        ).json();
        ids.push(...result.notes.map((note: { id: string }) => note.id));
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }
      return ids;
    };

    expect(await collect("title")).toEqual([alpha, beta, gamma]);
    expect(await collect("created")).toEqual([gamma, beta, alpha]);
  } finally {
    await waitForOrphanAssetCleanup(f.database);
    f.database.close();
  }
});

test("short-term title sorting paginates without repeating rows", async () => {
  const f = await fixture();
  try {
    const second = f.create("猫 B", "猫");
    const first = f.create("猫 A", "猫");
    const third = f.create("猫 C", "猫");
    const result = await (
      await f.list(`query=${encodeURIComponent("猫")}&sort=title&limit=1&includeTotal=0`)
    ).json();
    expect(result.notes.map((note: { id: string }) => note.id)).toEqual([first]);
    const next = await (
      await f.list(
        `query=${encodeURIComponent("猫")}&sort=title&limit=2&includeTotal=0&cursor=${encodeURIComponent(result.nextCursor)}`,
      )
    ).json();
    expect(next.notes.map((note: { id: string }) => note.id)).toEqual([second, third]);
  } finally {
    await waitForOrphanAssetCleanup(f.database);
    f.database.close();
  }
});
