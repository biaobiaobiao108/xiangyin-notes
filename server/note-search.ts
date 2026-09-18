import type { SqliteDatabase } from "./db";

const INDEXABLE_SHORT_SEARCH_CHARACTER = /[\p{L}\p{N}]/u;

function isIndexableCharacter(value: string) {
  return INDEXABLE_SHORT_SEARCH_CHARACTER.test(value);
}

export function canIndexShortSearchTerm(term: string) {
  const characters = Array.from(term);
  return characters.length > 0 && characters.length <= 2 && characters.every(isIndexableCharacter);
}

export function extractShortSearchTerms(value: string) {
  const terms = new Set<string>();
  let previous: string | null = null;
  for (const current of value) {
    if (!isIndexableCharacter(current)) {
      previous = null;
      continue;
    }
    terms.add(current);
    if (previous) terms.add(previous + current);
    previous = current;
  }
  return terms;
}

export function syncNoteShortSearchTerms(database: SqliteDatabase, userId: string, noteId: string, title: string, contentMarkdown: string) {
  database.query("DELETE FROM note_short_terms WHERE note_id = ? AND user_id = ?").run(noteId, userId);
  const insert = database.query("INSERT INTO note_short_terms (note_id, user_id, term) VALUES (?, ?, ?)");
  const seen = new Set<string>();
  for (const value of [title, contentMarkdown]) {
    for (const term of extractShortSearchTerms(value)) {
      if (seen.has(term)) continue;
      seen.add(term);
      insert.run(noteId, userId, term);
    }
  }
}

export function backfillNoteShortSearchTerms(database: SqliteDatabase) {
  const notes = database.query("SELECT id, user_id, title, content_markdown FROM notes").iterate() as Iterable<{
    id: string;
    user_id: string;
    title: string;
    content_markdown: string;
  }>;
  const transaction = database.transaction(() => {
    for (const note of notes) syncNoteShortSearchTerms(database, note.user_id, note.id, note.title, note.content_markdown);
  });
  transaction();
}
