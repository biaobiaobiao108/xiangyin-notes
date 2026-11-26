import type { SqliteDatabase } from "./db";
import { extractContextSnippet, extractWikiLinks } from "../shared/wiki-links";

export function indexNoteLinks(contentMarkdown: string) {
  const links = new Map<string, { snippet: string; hasPlainLink: number }>();
  for (const link of extractWikiLinks(contentMarkdown)) {
    const previous = links.get(link.target);
    if (previous) {
      if (!link.alias) previous.hasPlainLink = 1;
    } else {
      links.set(link.target, {
        snippet: extractContextSnippet(contentMarkdown, link.start, link.end),
        hasPlainLink: Number(!link.alias),
      });
    }
  }
  return links;
}

export function syncNoteLinks(
  database: SqliteDatabase,
  userId: string,
  sourceNoteId: string,
  contentMarkdown: string,
) {
  const links = indexNoteLinks(contentMarkdown);
  const rows = database
    .query<
      { id: string; target_note_id: string; snippet: string; has_plain_link: number },
      [string, string]
    >(
      "SELECT id, target_note_id, snippet, has_plain_link FROM note_links WHERE user_id = ? AND source_note_id = ?",
    )
    .all(userId, sourceNoteId);
  const update = database.query(
    "UPDATE note_links SET snippet = ?, has_plain_link = ? WHERE id = ?",
  );
  const remove = database.query("DELETE FROM note_links WHERE id = ?");
  for (const row of rows) {
    const link = links.get(row.target_note_id);
    if (!link) remove.run(row.id);
    else if (link.snippet !== row.snippet || link.hasPlainLink !== row.has_plain_link)
      update.run(link.snippet, link.hasPlainLink, row.id);
    links.delete(row.target_note_id);
  }
  const insert = database.query(
    "INSERT INTO note_links (id, user_id, source_note_id, target_note_id, snippet, has_plain_link) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const [id, { snippet, hasPlainLink }] of links)
    insert.run(crypto.randomUUID(), userId, sourceNoteId, id, snippet, hasPlainLink);
}
