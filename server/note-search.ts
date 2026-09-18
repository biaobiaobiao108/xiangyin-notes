import type { SqliteDatabase } from "./db";

const INDEXABLE_SHORT_SEARCH_CHARACTER = /[\p{L}\p{N}]/u;

function isIndexableCharacter(value: string) {
  return INDEXABLE_SHORT_SEARCH_CHARACTER.test(value);
}

export function canIndexShortSearchTerm(term: string) {
  const characters = Array.from(term);
  return characters.length > 0 && characters.length <= 2 && characters.every(isIndexableCharacter);
}

export const MAX_SHORT_TERMS_PER_NOTE = 500;
export const MAX_SHORT_TERM_CONTENT_CHARS = 4000;

export function extractShortSearchTerms(titleOrValue: string, contentMarkdown = "") {
  const terms = new Set<string>();

  const addTermsFromText = (text: string) => {
    let previous: string | null = null;
    for (const current of text) {
      if (!isIndexableCharacter(current)) {
        previous = null;
        continue;
      }
      terms.add(current);
      if (previous) terms.add(previous + current);
      previous = current;
      if (terms.size >= MAX_SHORT_TERMS_PER_NOTE) break;
    }
  };

  addTermsFromText(titleOrValue);
  if (terms.size < MAX_SHORT_TERMS_PER_NOTE && contentMarkdown) {
    addTermsFromText(contentMarkdown.slice(0, MAX_SHORT_TERM_CONTENT_CHARS));
  }
  return terms;
}

export function syncNoteShortSearchTerms(database: SqliteDatabase, userId: string, noteId: string, title: string, contentMarkdown: string) {
  database.query("DELETE FROM note_short_terms WHERE note_id = ? AND user_id = ?").run(noteId, userId);
  const terms = extractShortSearchTerms(title, contentMarkdown);
  if (terms.size === 0) return;

  const termList = Array.from(terms);
  const BATCH_SIZE = 50;
  for (let i = 0; i < termList.length; i += BATCH_SIZE) {
    const chunk = termList.slice(i, i + BATCH_SIZE);
    const placeholders = chunk.map(() => "(?, ?, ?)").join(",");
    const params: string[] = [];
    for (const term of chunk) {
      params.push(noteId, userId, term);
    }
    database.query(`INSERT INTO note_short_terms (note_id, user_id, term) VALUES ${placeholders}`).run(...params);
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
