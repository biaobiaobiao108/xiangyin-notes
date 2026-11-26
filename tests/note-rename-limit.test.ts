import { expect, test } from "bun:test";
import { getNote } from "../server/core";
import { openDatabase } from "../server/db";
import { handleRequest } from "../server/index";
import { waitForOrphanAssetCleanup } from "../server/routes/assets";
import { ensureEnvironmentUser } from "../server/routes/auth";
import { createNote } from "../server/routes/notes";
import { updateNote } from "../server/routes/note-mutations";

test("renaming a target keeps trashed backlink tasks out of counts until restoration", async () => {
  const database = await openDatabase(":memory:");
  try {
    const user = await ensureEnvironmentUser(database, { username: "review", password: "review" });
    const inbox = database
      .query("SELECT id FROM notebooks WHERE user_id = ? AND is_system = 1")
      .get(user.id) as { id: string };
    const targetId = createNote(database, user.id, inbox.id, "Target", "target");
    const sourceId = createNote(
      database,
      user.id,
      inbox.id,
      "Source",
      `[[${targetId}|Target]]\n- [ ] task`,
    );
    const update = (id: string, title: string | null, deletedAt: number | null) => {
      const note = getNote(database, user.id, id)!;
      expect(
        updateNote(
          database,
          note,
          user.id,
          title ?? note.title,
          note.content_markdown,
          note.notebook_id,
          note.is_favorite,
          deletedAt,
        ),
      ).not.toBe(false);
    };
    const counts = () =>
      database
        .query(
          "SELECT COALESCE(SUM(task_count), 0) AS total FROM note_task_counts WHERE user_id = ?",
        )
        .get(user.id);

    update(sourceId, null, 1);
    expect(counts()).toEqual({ total: 0 });
    update(targetId, "Renamed", null);
    expect(getNote(database, user.id, sourceId)?.content_markdown).toBe(
      `[[${targetId}|Target]]\n- [ ] task`,
    );
    expect(counts()).toEqual({ total: 0 });
    expect(
      database.query("SELECT COUNT(*) AS total FROM note_tasks WHERE note_id = ?").get(sourceId),
    ).toEqual({ total: 0 });
    update(sourceId, null, null);
    expect(counts()).toEqual({ total: 1 });
  } finally {
    await waitForOrphanAssetCleanup(database);
    database.close();
  }
});

test("renames a target without rewriting a large incoming link source", async () => {
  const database = await openDatabase(":memory:");
  const environment = {
    XIANGYING_USERNAME: "rename-test",
    XIANGYING_PASSWORD: "rename-test-password",
  };
  try {
    const user = await ensureEnvironmentUser(database, {
      username: environment.XIANGYING_USERNAME,
      password: environment.XIANGYING_PASSWORD,
    });
    const inbox = database
      .query("SELECT id FROM notebooks WHERE user_id = ? AND is_system = 1")
      .get(user.id) as { id: string };
    const targetId = createNote(database, user.id, inbox.id, "A", "target #original");
    const shortSourceId = createNote(
      database,
      user.id,
      inbox.id,
      "short source",
      `[[${targetId}|A]]`,
    );
    const longSourceId = createNote(
      database,
      user.id,
      inbox.id,
      "long source",
      `[[${targetId}|A]] `.repeat(1000),
    );
    const ids = [targetId, shortSourceId, longSourceId];
    const before = ids.map((id) => getNote(database, user.id, id));
    const linksBefore = database.query("SELECT * FROM note_links ORDER BY id").all();
    const target = before[0]!;
    const login = await handleRequest(
      new Request("http://rename.test/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          username: environment.XIANGYING_USERNAME,
          password: environment.XIANGYING_PASSWORD,
        }),
      }),
      { database, environment },
    );
    expect(login.status).toBe(200);
    const cookie = login.headers.get("Set-Cookie")!.split(";", 1)[0]!;
    const patch = (payload: object) =>
      handleRequest(
        new Request(`http://rename.test/api/notes/${targetId}`, {
          method: "PATCH",
          headers: { Cookie: cookie },
          body: JSON.stringify({ version: target.version, ...payload }),
        }),
        { database, environment },
      );

    const accepted = await patch({
      title: "B".repeat(200),
      contentMarkdown: "changed #replacement",
    });
    expect(accepted.status).toBe(200);
    expect(getNote(database, user.id, targetId)?.title).toBe("B".repeat(200));
    expect(ids.slice(1).map((id) => getNote(database, user.id, id))).toEqual(before.slice(1));
    expect(database.query("SELECT * FROM note_links ORDER BY id").all()).toEqual(linksBefore);
  } finally {
    await waitForOrphanAssetCleanup(database);
    database.close();
  }
});
