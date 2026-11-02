import type { SqliteDatabase } from "./db";

// The short index only stores unique unigrams and bigrams per note, keeping
// one- and two-character searches indexed without duplicating the note body.
export const MAX_SHORT_INDEX_CONTENT_CHARACTERS = 40_000;
export const MAX_SHORT_INDEX_TOKENS = 12_000;

// Use Unicode simple case folding, matching JavaScript's case-insensitive /u regex.
function encodeCharacter(character: string) {
  // Unicode simple case folding does not equate dotless i with ASCII I.
  if (character === "ı") return "000131";
  const upper = character.toUpperCase();
  const folded = Array.from(upper).length === 1 ? upper.toLowerCase() : character.toLowerCase();
  const normalized = Array.from(folded).length === 1 ? folded : character;
  return normalized.codePointAt(0)!.toString(16).padStart(6, "0");
}

export function shortSearchToken(term: string) {
  const characters = Array.from(term);
  return `${characters.length === 1 ? "u" : "b"}${characters.map(encodeCharacter).join("")}`;
}

export function buildShortSearchTokens(title: string, contentMarkdown: string, legacy = false) {
  const terms = new Set<string>();
  let truncated = false;
  for (const [text, limit] of [
    [title, Number.POSITIVE_INFINITY],
    [contentMarkdown, MAX_SHORT_INDEX_CONTENT_CHARACTERS],
  ] as const) {
    let previous = "";
    let count = 0;
    for (const character of text) {
      if (terms.size >= MAX_SHORT_INDEX_TOKENS) {
        truncated = true;
        break;
      }
      if (count++ >= limit) {
        truncated = true;
        break;
      }
      if (legacy && !/[\p{L}\p{N}]/u.test(character)) {
        previous = "";
        continue;
      }
      const codePoint = character.codePointAt(0)!;
      const encoded = legacy
        ? (codePoint >= 65 && codePoint <= 90 ? codePoint + 32 : codePoint)
            .toString(16)
            .padStart(6, "0")
        : encodeCharacter(character);
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
  // Version 10 remains reproducible for databases upgrading through it.
  legacy = false,
) {
  const { tokens, truncated } = buildShortSearchTokens(title, contentMarkdown, legacy);
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

export function rebuildNoteShortSearchIndex(database: SqliteDatabase) {
  database.exec("DELETE FROM notes_short_fts; DELETE FROM notes_short_overflow;");
  const notes = database
    .query("SELECT id, user_id, title, content_markdown FROM notes ORDER BY rowid")
    .iterate() as IterableIterator<{
    id: string;
    user_id: string;
    title: string;
    content_markdown: string;
  }>;
  for (const note of notes)
    syncNoteShortSearchTerms(database, note.user_id, note.id, note.title, note.content_markdown);
}
