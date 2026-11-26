import type { SqliteDatabase } from "./db";
import { extractContextSnippet, extractWikiLinks } from "../shared/wiki-links";

export function syncNoteLinks(
  database: SqliteDatabase,
  userId: string,
  sourceNoteId: string,
  contentMarkdown: string,
) {
  const links = new Map<string, string>();
  for (const link of extractWikiLinks(contentMarkdown)) {
    if (!links.has(link.target))
      links.set(link.target, extractContextSnippet(contentMarkdown, link.start, link.end));
  }
  const rows = database
    .query<{ id: string; target_note_id: string; snippet: string }, [string, string]>(
      "SELECT id, target_note_id, snippet FROM note_links WHERE user_id = ? AND source_note_id = ?",
    )
    .all(userId, sourceNoteId);
  const update = database.query("UPDATE note_links SET snippet = ? WHERE id = ?");
  const remove = database.query("DELETE FROM note_links WHERE id = ?");
  for (const row of rows) {
    const snippet = links.get(row.target_note_id);
    if (snippet === undefined) remove.run(row.id);
    else if (snippet !== row.snippet) update.run(snippet, row.id);
    links.delete(row.target_note_id);
  }
  const insert = database.query(
    "INSERT INTO note_links (id, user_id, source_note_id, target_note_id, snippet) VALUES (?, ?, ?, ?, ?)",
  );
  for (const [id, snippet] of links)
    insert.run(crypto.randomUUID(), userId, sourceNoteId, id, snippet);
}
