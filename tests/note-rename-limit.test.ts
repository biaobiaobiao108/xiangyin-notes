import { expect, test } from "bun:test";
import { getNote } from "../server/core";
import { openDatabase } from "../server/db";
import { handleRequest } from "../server/index";
import { ensureEnvironmentUser } from "../server/routes/auth";
import { createNote } from "../server/routes/notes";

test("rejects an oversized backlink rewrite and rolls back the entire rename", async () => {
  const database = await openDatabase(":memory:");
  const environment = { XIANGYING_USERNAME: "rename-test", XIANGYING_PASSWORD: "rename-test-password" };
  try {
    const user = await ensureEnvironmentUser(database, { username: environment.XIANGYING_USERNAME, password: environment.XIANGYING_PASSWORD });
    const inbox = database.query("SELECT id FROM notebooks WHERE user_id = ? AND is_system = 1").get(user.id) as { id: string };
    const targetId = createNote(database, user.id, inbox.id, "A", "target #original");
    const shortSourceId = createNote(database, user.id, inbox.id, "short source", "[[A]]");
    const longSourceId = createNote(database, user.id, inbox.id, "long source", "[[A]] ".repeat(6000));
    const ids = [targetId, shortSourceId, longSourceId];
    const before = ids.map((id) => getNote(database, user.id, id));
    const linksBefore = database.query("SELECT * FROM note_links ORDER BY id").all();
    const target = before[0]!;
    const login = await handleRequest(new Request("http://rename.test/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: environment.XIANGYING_USERNAME, password: environment.XIANGYING_PASSWORD }),
    }), { database, environment });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("Set-Cookie")!.split(";", 1)[0]!;
    const patch = (payload: object) => handleRequest(new Request(`http://rename.test/api/notes/${targetId}`, {
      method: "PATCH",
      headers: { Cookie: cookie },
      body: JSON.stringify({ version: target.version, ...payload }),
    }), { database, environment });

    const rejected = await patch({ title: "B".repeat(200), contentMarkdown: "changed #replacement" });
    expect(rejected.status).toBe(413);
    expect(await rejected.json()).toMatchObject({ error: { code: "NOTE_TOO_LARGE" } });
    expect(ids.map((id) => getNote(database, user.id, id))).toEqual(before);
    expect(database.query("SELECT * FROM note_links ORDER BY id").all()).toEqual(linksBefore);
    expect(database.query("SELECT tag FROM note_tags WHERE note_id = ?").all(targetId)).toEqual([{ tag: "original" }]);
    expect(database.query("SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'replacement'").all()).toEqual([]);

    const accepted = await patch({ title: "B" });
    expect(accepted.status).toBe(200);
    expect(getNote(database, user.id, targetId)?.title).toBe("B");
    expect(getNote(database, user.id, shortSourceId)?.content_markdown).toBe("[[B]]");
    expect(getNote(database, user.id, longSourceId)?.content_markdown).toBe("[[B]] ".repeat(6000));
  } finally {
    database.close();
  }
});
