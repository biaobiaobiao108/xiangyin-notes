import type { D1Value, SqliteDatabase } from "./db";

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

  const addTermsFromText = (text: string, maxCharacters = Number.POSITIVE_INFINITY) => {
    let previous: string | null = null;
    let charactersRead = 0;
    for (const current of text) {
      if (charactersRead >= maxCharacters) break;
      charactersRead += 1;
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
    // SQLite length(text) counts Unicode code points, as does for...of here.
    // Keep the short-term index boundary aligned with the SQL fallback threshold.
    addTermsFromText(contentMarkdown, MAX_SHORT_TERM_CONTENT_CHARS);
  }
  return terms;
}

export async function syncNoteShortSearchTerms(
  database: SqliteDatabase,
  userId: string,
  noteId: string,
  title: string,
  contentMarkdown: string,
) {
  const terms = extractShortSearchTerms(title, contentMarkdown);
  const termList = Array.from(terms);
  // D1 currently limits bound variables per statement; 25 rows use 75.
  const BATCH_SIZE = 25;
  const statements: { sql: string; values: D1Value[] }[] = [
    {
      sql: "DELETE FROM note_short_terms WHERE note_id = ? AND user_id = ?",
      values: [noteId, userId],
    },
  ];
  for (let i = 0; i < termList.length; i += BATCH_SIZE) {
    const chunk = termList.slice(i, i + BATCH_SIZE);
    const placeholders = chunk.map(() => "(?, ?, ?)").join(",");
    const params: string[] = [];
    for (const term of chunk) {
      params.push(noteId, userId, term);
    }
    statements.push({
      sql: `INSERT INTO note_short_terms (note_id, user_id, term) VALUES ${placeholders}`,
      values: params,
    });
  }
  await database.batch(statements);
}
