import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SEARCH_INDEX_REBUILD_KEY, openDatabase } from "../server/db";
import { buildShortSearchTokens, shortSearchToken } from "../server/note-search";

test("stores each distinct short term once per note", () => {
  const { tokens, truncated } = buildShortSearchTokens("猫猫", "猫");
  expect(truncated).toBe(false);
  expect(tokens.split(" ")).toHaveLength(2);
  expect(new Set(tokens.split(" "))).toEqual(
    new Set([shortSearchToken("猫"), shortSearchToken("猫猫")]),
  );
});

test("reopening resumes an interrupted full-text rebuild", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xiangying-search-recovery-"));
  const path = join(directory, "notes.sqlite");
  try {
    const first = await openDatabase(path);
    first
      .query(
        "INSERT INTO users (id, username, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("user", "owner", "hash", "salt", 1);
    first
      .query(
        "INSERT INTO notebooks (id, user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("notebook", "user", "Notes", 1, 1);
    first
      .query(
        "INSERT INTO notes (id, user_id, notebook_id, title, content_markdown, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("note", "user", "notebook", "标题", "正文包含猫", 1, 1);

    // Simulate a process dying after VACUUM changed rowids but before the
    // derived full-text index was rebuilt.
    first.query("UPDATE notes SET rowid = 100 WHERE id = 'note'").run();
    first
      .query("INSERT INTO app_metadata (key, value) VALUES (?, '1')")
      .run(SEARCH_INDEX_REBUILD_KEY);
    first.close();

    const reopened = await openDatabase(path);
    try {
      expect(
        reopened
          .query(
            "SELECT n.id FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid WHERE notes_fts MATCH ?",
          )
          .all("正文包含猫"),
      ).toEqual([{ id: "note" }]);
      expect(
        reopened.query("SELECT 1 FROM app_metadata WHERE key = ?").get(SEARCH_INDEX_REBUILD_KEY),
      ).toBeNull();
    } finally {
      reopened.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
