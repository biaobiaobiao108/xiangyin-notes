import type { SqliteDatabase } from "./db";
import { buildShortSearchTokens } from "./note-search";

export function syncMemoShortSearchTerms(
  database: SqliteDatabase,
  userId: string,
  memoId: string,
  contentMarkdown: string,
) {
  const { tokens, truncated } = buildShortSearchTokens("", contentMarkdown);
  database
    .query(
      "INSERT OR REPLACE INTO memos_short_fts(rowid, terms) SELECT rowid, ? FROM memos WHERE id = ? AND user_id = ?",
    )
    .run(tokens, memoId, userId);
  if (truncated) {
    database
      .query("INSERT OR IGNORE INTO memos_short_overflow(memo_id, user_id) VALUES (?, ?)")
      .run(memoId, userId);
  } else {
    database.query("DELETE FROM memos_short_overflow WHERE memo_id = ?").run(memoId);
  }
}

export function rebuildMemoShortSearchIndex(database: SqliteDatabase) {
  database.exec("DELETE FROM memos_short_fts; DELETE FROM memos_short_overflow;");
  const memos = database
    .query("SELECT id, user_id, search_text FROM memos ORDER BY rowid")
    .iterate() as IterableIterator<{ id: string; user_id: string; search_text: string }>;
  for (const memo of memos)
    syncMemoShortSearchTerms(database, memo.user_id, memo.id, memo.search_text);
}
