import type { SqliteDatabase } from "./db";
import { extractWikiLinks, normalizeLinkTitle } from "../shared/wiki-links";

type SqlValue = string | number | null | Uint8Array | bigint;

type ActiveNoteTitleRow = {
  id: string;
  title: string;
};

type NoteLinkRow = {
  source_note_id: string;
  target_title: string;
  target_note_id: string | null;
};

function all<T>(database: SqliteDatabase, sql: string, ...values: SqlValue[]) {
  return database.query(sql).all(...values) as T[];
}

export function syncStoredNoteTitleKey(database: SqliteDatabase, noteId: string, title: string) {
  database.query("UPDATE notes SET title_normalized = ? WHERE id = ?").run(normalizeLinkTitle(title), noteId);
}

function activeTitleMap(rows: ActiveNoteTitleRow[]) {
  const targets = new Map<string, string>();
  for (const row of rows) {
    const key = normalizeLinkTitle(row.title);
    if (key && !targets.has(key)) targets.set(key, row.id);
  }
  return targets;
}

function activeTitlesForKeys(database: SqliteDatabase, userId: string, keys: Set<string>) {
  if (keys.size === 0) return [];
  const placeholders = [...keys].map(() => "?").join(",");
  return all<ActiveNoteTitleRow>(
    database,
    `SELECT id, title
     FROM notes
     WHERE user_id = ? AND deleted_at IS NULL AND title_normalized IN (${placeholders})
     ORDER BY updated_at DESC, id`,
    userId,
    ...keys,
  );
}

function insertNoteLinks(
  database: SqliteDatabase,
  userId: string,
  sourceNoteId: string,
  contentMarkdown: string,
  targets: Map<string, string>,
  createdAt: number,
) {
  const insert = database.query("INSERT INTO note_links (id, user_id, source_note_id, target_title, target_title_normalized, target_note_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const seen = new Set<string>();
  for (const link of extractWikiLinks(contentMarkdown)) {
    const key = normalizeLinkTitle(link.target);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    insert.run(crypto.randomUUID(), userId, sourceNoteId, link.target, key, targets.get(key) ?? null, createdAt);
  }
}

export function findActiveNoteIdByTitle(database: SqliteDatabase, userId: string, title: string) {
  const normalized = normalizeLinkTitle(title);
  if (!normalized) return null;
  const match = database.query("SELECT id FROM notes WHERE user_id = ? AND deleted_at IS NULL AND title_normalized = ? ORDER BY updated_at DESC, id LIMIT 1").get(userId, normalized) as { id: string } | null | undefined;
  return match?.id ?? null;
}

export function syncNoteLinks(database: SqliteDatabase, userId: string, sourceNoteId: string, contentMarkdown: string, createdAt: number) {
  database.query("DELETE FROM note_links WHERE user_id = ? AND source_note_id = ?").run(userId, sourceNoteId);
  if (!contentMarkdown || (!contentMarkdown.includes("[[") && !contentMarkdown.includes("【【"))) return;
  const links = extractWikiLinks(contentMarkdown);
  const targetKeys = new Set(links.map((link) => normalizeLinkTitle(link.target)).filter(Boolean));
  const targets = activeTitleMap(activeTitlesForKeys(database, userId, targetKeys));
  insertNoteLinks(database, userId, sourceNoteId, contentMarkdown, targets, createdAt);
}

export function resolveNoteLinksForUser(database: SqliteDatabase, userId: string) {
  database.query(`
    UPDATE note_links
    SET target_note_id = (
      SELECT n.id
      FROM notes n
      WHERE n.user_id = note_links.user_id
        AND n.deleted_at IS NULL
        AND n.title_normalized = note_links.target_title_normalized
      ORDER BY n.updated_at DESC, n.id
      LIMIT 1
    )
    WHERE user_id = ?
  `).run(userId);
}

export function resolveNoteLinksForTitles(database: SqliteDatabase, userId: string, titles: string[]) {
  const normalizedTargets = new Set(titles.map((title) => normalizeLinkTitle(title)).filter(Boolean));
  if (normalizedTargets.size === 0) return;
  const placeholders = [...normalizedTargets].map(() => "?").join(",");
  database.query(`
    UPDATE note_links
    SET target_note_id = (
      SELECT n.id
      FROM notes n
      WHERE n.user_id = note_links.user_id
        AND n.deleted_at IS NULL
        AND n.title_normalized = note_links.target_title_normalized
      ORDER BY n.updated_at DESC, n.id
      LIMIT 1
    )
    WHERE user_id = ? AND target_title_normalized IN (${placeholders})
  `).run(userId, ...normalizedTargets);
}

export function resolveNoteLinksForTarget(database: SqliteDatabase, userId: string, title: string, targetNoteId: string) {
  const normalized = normalizeLinkTitle(title);
  if (!normalized) return;
  database.query("UPDATE note_links SET target_note_id = ? WHERE user_id = ? AND target_note_id IS NULL AND target_title_normalized = ?").run(targetNoteId, userId, normalized);
}

export function sourceNoteIdsReferencingTarget(database: SqliteDatabase, userId: string, targetNoteId: string) {
  const rows = all<Pick<NoteLinkRow, "source_note_id" | "target_title" | "target_note_id">>(
    database,
    "SELECT source_note_id, target_title, target_note_id FROM note_links WHERE user_id = ? AND target_note_id = ? AND source_note_id != ?",
    userId,
    targetNoteId,
    targetNoteId,
  );
  return [...new Set(rows.map((row) => row.source_note_id))];
}
