import type { SqliteDatabase } from "./db";

const INDEXABLE_SHORT_SEARCH_CHARACTER = /[\p{L}\p{N}]/u;
// Bound temporary token memory for very long notes; overflow is searched with LIKE.
export const MAX_SHORT_INDEX_CONTENT_CHARACTERS = 40_000;

export function canIndexShortSearchTerm(term: string) {
  const characters = Array.from(term);
  return (
    characters.length > 0 &&
    characters.length <= 2 &&
    characters.every((character) => INDEXABLE_SHORT_SEARCH_CHARACTER.test(character))
  );
}

// SQLite LIKE/NOCASE folds ASCII only. Encoding code points as ASCII tokens
// preserves those semantics without relying on the FTS tokenizer's Unicode rules.
function encodeCharacter(character: string) {
  const codePoint = character.codePointAt(0)!;
  return (codePoint >= 65 && codePoint <= 90 ? codePoint + 32 : codePoint)
    .toString(16)
    .padStart(6, "0");
}

export function shortSearchToken(term: string) {
  const characters = Array.from(term);
  return `${characters.length === 1 ? "u" : "b"}${characters.map(encodeCharacter).join("")}`;
}

export function shortSearchTokens(title: string, contentMarkdown: string) {
  const terms = new Set<string>();
  let truncated = false;
  for (const [text, limit] of [
    [title, Number.POSITIVE_INFINITY],
    [contentMarkdown, MAX_SHORT_INDEX_CONTENT_CHARACTERS],
  ] as const) {
    let previous = "";
    let count = 0;
    for (const character of text) {
      if (count++ >= limit) {
        truncated = true;
        break;
      }
      if (!INDEXABLE_SHORT_SEARCH_CHARACTER.test(character)) {
        previous = "";
        continue;
      }
      const encoded = encodeCharacter(character);
      terms.add(`u${encoded}`);
      if (previous) terms.add(`b${previous}${encoded}`);
      previous = encoded;
    }
  }
  return { tokens: [...terms].join(" "), truncated };
}

export function syncNoteShortSearchTerms(
  database: SqliteDatabase,
  userId: string,
  noteId: string,
  title: string,
  contentMarkdown: string,
) {
  const { tokens, truncated } = shortSearchTokens(title, contentMarkdown);
  database
    .query(
      "INSERT OR REPLACE INTO notes_short_fts(rowid, terms) SELECT rowid, ? FROM notes WHERE id = ? AND user_id = ?",
    )
    .run(tokens, noteId, userId);
  if (truncated) {
    database
      .query("INSERT OR IGNORE INTO notes_short_overflow(note_id, user_id) VALUES (?, ?)")
      .run(noteId, userId);
  } else {
    database.query("DELETE FROM notes_short_overflow WHERE note_id = ?").run(noteId);
  }
}
