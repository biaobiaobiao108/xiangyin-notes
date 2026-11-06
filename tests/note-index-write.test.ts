import { expect, test } from "bun:test";
import { openDatabase } from "../server/db";
import { getNote } from "../server/core";
import { createNote, updateNoteInTransaction } from "../server/routes/note-mutations";

test("unrelated edits preserve task and tag indexes while search stays current", async () => {
  const db = await openDatabase(":memory:");
  try {
    db.query("INSERT INTO users VALUES (?, ?, ?, ?, ?)").run("u", "u", "hash", "salt", 1);
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
