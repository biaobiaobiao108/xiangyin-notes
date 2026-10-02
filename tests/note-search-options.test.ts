import { expect, test } from "bun:test";
import { openDatabase } from "../server/db";
import { handleRequest } from "../server/index";
import { ensureEnvironmentUser } from "../server/routes/auth";
import { createNote } from "../server/routes/notes";

async function fixture() {
  const database = await openDatabase(":memory:");
  const environment = { XIANGYING_USERNAME: "search-owner", XIANGYING_PASSWORD: "search-test-password" };
  const user = await ensureEnvironmentUser(database, { username: environment.XIANGYING_USERNAME, password: environment.XIANGYING_PASSWORD });
  const inbox = database.query("SELECT id FROM notebooks WHERE user_id = ? AND is_system = 1").get(user.id) as { id: string };
  database.query("DELETE FROM notes WHERE user_id = ?").run(user.id);
  const login = await handleRequest(new Request("http://search.test/api/auth/login", {
    method: "POST", body: JSON.stringify({ username: environment.XIANGYING_USERNAME, password: environment.XIANGYING_PASSWORD }),
  }), { database, environment });
  const cookie = login.headers.get("Set-Cookie")!.split(";", 1)[0]!;
  return {
    database,
    create: (title: string, content: string) => createNote(database, user.id, inbox.id, title, content),
    list: (params: string) => handleRequest(new Request(`http://search.test/api/notes?${params}`, { headers: { Cookie: cookie } }), { database, environment }),
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
    const next = await (await f.list(`tags=alpha&tags=beta&tagMode=any&limit=1&cursor=${any.nextCursor}`)).json();
    expect(new Set([...any.notes, ...next.notes].map((note: { id: string }) => note.id))).toEqual(new Set([both, alpha]));
    expect((await f.list("tags=alpha&tags=bad%20tag")).status).toBe(400);
    expect((await f.list("tagMode=invalid")).status).toBe(400);
  } finally { f.database.close(); }
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
    const second = await (await f.list(`query=needle&sort=relevance&includeMatch=1&limit=1&cursor=${first.nextCursor}`)).json();
    const third = await (await f.list(`query=needle&sort=relevance&includeMatch=1&limit=1&cursor=${second.nextCursor}`)).json();
    expect(new Set([first.notes[0].id, second.notes[0].id, third.notes[0].id])).toEqual(new Set([title, body, another]));
    const bodyNote = [...second.notes, ...third.notes].find((note: { id: string }) => note.id === body);
    expect(bodyNote.match.field).toBe("content");
    expect(bodyNote.match.snippet).toContain("needle");
    expect(bodyNote.match.snippet.length).toBeLessThanOrEqual(200);
    expect((await f.list(`query=secondary&sort=relevance&cursor=${first.nextCursor}`)).status).toBe(400);
    expect((await f.list(`query=needle&sort=relevance&tags=alpha&cursor=${first.nextCursor}`)).status).toBe(400);
  } finally { f.database.close(); }
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
      const result = await (await f.list(`query=猫&sort=relevance&limit=1${cursor ? `&cursor=${cursor}` : ""}`)).json();
      ids.push(result.notes[0].id);
      cursor = result.nextCursor ?? "";
    }
    expect(ids[0]).toBe(title);
    expect(new Set(ids)).toEqual(new Set([title, a, b]));
    const plain = await (await f.list("sort=relevance")).json();
    expect(plain.notes.map((note: { id: string }) => note.id)).toEqual([b, a, title]);
  } finally { f.database.close(); }
});
