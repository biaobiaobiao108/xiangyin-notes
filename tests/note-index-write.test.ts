import { expect, test } from "bun:test";
import { openDatabase } from "../server/db";
import { getNote } from "../server/core";
import { createNote, updateNoteInTransaction } from "../server/routes/note-mutations";

test("unrelated edits preserve task and tag indexes while search stays current", async () => {
  const db = await openDatabase(":memory:");
  try {
    db.query(
      "INSERT INTO users (id, username, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("u", "u", "hash", "salt", 1);
    db.query(
      "INSERT INTO notebooks (id, user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("b", "u", "book", 1, 1);
    const id = createNote(db, "u", "b", "原始标题", "- [ ] 保留任务\n\n#标签\n\n原来的正文");
    db.exec(`CREATE TEMP TABLE index_writes (kind TEXT);
      CREATE TEMP TRIGGER task_deleted AFTER DELETE ON note_tasks BEGIN INSERT INTO index_writes VALUES ('task'); END;
      CREATE TEMP TRIGGER tag_deleted AFTER DELETE ON note_tags BEGIN INSERT INTO index_writes VALUES ('tag'); END;`);
    const update = (title: string, content: string) => {
      const note = getNote(db, "u", id)!;
      expect(
        db.transaction(() =>
          updateNoteInTransaction(db, note, "u", title, content, "b", 0, null),
        )(),
      ).toBe(true);
    };
    update("新标题", "- [ ] 保留任务\n\n#标签\n\n新的正文");
    expect(db.query("SELECT * FROM index_writes").all()).toEqual([]);
    expect(
      db.query("SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?").all('"新标题"'),
    ).toHaveLength(1);
    expect(
      db.query("SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?").all('"新的正文"'),
    ).toHaveLength(1);
    expect(
      db.query("SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?").all('"原始标题"'),
    ).toHaveLength(0);
    update("新标题", "- [x] 已完成\n\n#新标签");
    expect(db.query("SELECT text, done FROM note_tasks WHERE note_id = ?").all(id)).toEqual([
      { text: "已完成", done: 1 },
    ]);
    expect(db.query("SELECT tag FROM note_tags WHERE note_id = ?").all(id)).toEqual([
      { tag: "新标签" },
    ]);
  } finally {
    db.close();
  }
});

test("unchanged links keep their records while changed snippets are refreshed", async () => {
  const db = await openDatabase(":memory:");
  try {
    db.query(
      "INSERT INTO users (id, username, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("u", "u", "hash", "salt", 1);
    db.query(
      "INSERT INTO notebooks (id, user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("b", "u", "book", 1, 1);
    const target = createNote(db, "u", "b", "目标", "");
    const body = `链接 [[${target}|目标]] 后文 ${"间隔".repeat(100)}`;
    const id = createNote(db, "u", "b", "来源", body);
    const readLink = () =>
      db
        .query("SELECT id, target_note_id, snippet FROM note_links WHERE source_note_id = ?")
        .get(id) as { id: string; target_note_id: string; snippet: string };
    const before = readLink();
    expect(before.target_note_id).toBe(target);
    const update = (text: string) =>
      db.transaction(() =>
        updateNoteInTransaction(db, getNote(db, "u", id)!, "u", "来源", text, "b", 0, null),
      )();
    update(`${body}末尾编辑`);
    expect(readLink()).toEqual(before);
    update(`修改 [[${target}|目标]] 后文 ${"间隔".repeat(100)}`);
    expect(readLink().snippet).toContain("修改");
  } finally {
    db.close();
  }
});

test("editing a same-title note preserves the original target UUID", async () => {
  const db = await openDatabase(":memory:");
  try {
    db.exec(`
      INSERT INTO users (id, username, password_hash, password_salt, created_at)
        VALUES ('u', 'u', 'hash', 'salt', 1);
      INSERT INTO notebooks (id, user_id, name, created_at, updated_at)
        VALUES ('b', 'u', 'book', 1, 1);
    `);
    const first = createNote(db, "u", "b", "目标", "第一篇");
    const second = createNote(db, "u", "b", "目标", "第二篇");
    db.query("UPDATE notes SET updated_at = 1 WHERE id IN (?, ?)").run(first, second);
    const source = createNote(db, "u", "b", "来源", `[[${first}|目标]]`);
    const readTarget = () =>
      db.query("SELECT target_note_id FROM note_links WHERE source_note_id = ?").get(source);
    expect(readTarget()).toEqual({ target_note_id: first });

    db.transaction(() =>
      updateNoteInTransaction(db, getNote(db, "u", second)!, "u", "目标", "新的正文", "b", 0, null),
    )();

    expect(readTarget()).toEqual({ target_note_id: first });
    expect(getNote(db, "u", source)).toMatchObject({
      content_markdown: `[[${first}|目标]]`,
      version: 1,
    });
  } finally {
    db.close();
  }
});
