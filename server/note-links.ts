import type { SqliteDatabase } from "./db";
import { all, type SqlValue } from "./core";
import { extractContextSnippet, extractWikiLinks, normalizeLinkTitle } from "../shared/wiki-links";

type ActiveNoteTitleRow = {
  id: string;
  title: string;
};

type NoteLinkRow = {
  source_note_id: string;
  target_title: string;
  target_note_id: string | null;
  snippet?: string;
};

export async function syncStoredNoteTitleKey(database: SqliteDatabase, noteId: string, title: string) {
  await database.query("UPDATE notes SET title_normalized = ? WHERE id = ?").run(normalizeLinkTitle(title), noteId);
}

function activeTitleMap(rows: ActiveNoteTitleRow[]) {
  const targets = new Map<string, string>();
  for (const row of rows) {
    const key = normalizeLinkTitle(row.title);
    if (key && !targets.has(key)) targets.set(key, row.id);
  }
  return targets;
}

async function activeTitlesForKeys(database: SqliteDatabase, userId: string, keys: Set<string>) {
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

export async function findActiveNoteIdByTitle(database: SqliteDatabase, userId: string, title: string) {
  const normalized = normalizeLinkTitle(title);
  if (!normalized) return null;
  const match = await database.query("SELECT id FROM notes WHERE user_id = ? AND deleted_at IS NULL AND title_normalized = ? ORDER BY updated_at DESC, id LIMIT 1").get(userId, normalized) as { id: string } | null | undefined;
  return match?.id ?? null;
}

export async function syncNoteLinks(database: SqliteDatabase, userId: string, sourceNoteId: string, contentMarkdown: string, createdAt: number) {
  if (!contentMarkdown || (!contentMarkdown.includes("[[") && !contentMarkdown.includes("【【"))) {
    await database.query("DELETE FROM note_links WHERE user_id = ? AND source_note_id = ?").run(userId, sourceNoteId);
    return;
  }
  const links = extractWikiLinks(contentMarkdown);
  const targetKeys = new Set(links.map((link) => normalizeLinkTitle(link.target)).filter(Boolean));
  const targets = activeTitleMap(await activeTitlesForKeys(database, userId, targetKeys));
  const statements: { sql: string; values: SqlValue[] }[] = [
    { sql: "DELETE FROM note_links WHERE user_id = ? AND source_note_id = ?", values: [userId, sourceNoteId] },
  ];
  const seen = new Set<string>();
  for (const link of links) {
    const key = normalizeLinkTitle(link.target);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    statements.push({
      sql: "INSERT INTO note_links (id, user_id, source_note_id, target_title, target_title_normalized, target_note_id, snippet, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      values: [crypto.randomUUID(), userId, sourceNoteId, link.target, key, targets.get(key) ?? null, extractContextSnippet(contentMarkdown, link.start, link.end), createdAt],
    });
  }
  await database.batch(statements);
}

export async function resolveNoteLinksForUser(database: SqliteDatabase, userId: string) {
  await database.query(`
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

export async function resolveNoteLinksForTitles(database: SqliteDatabase, userId: string, titles: string[]) {
  const normalizedTargets = new Set(titles.map((title) => normalizeLinkTitle(title)).filter(Boolean));
  if (normalizedTargets.size === 0) return;
  const placeholders = [...normalizedTargets].map(() => "?").join(",");
  await database.query(`
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

export async function resolveNoteLinksForTarget(database: SqliteDatabase, userId: string, title: string, targetNoteId: string) {
  const normalized = normalizeLinkTitle(title);
  if (!normalized) return;
  await database.query("UPDATE note_links SET target_note_id = ? WHERE user_id = ? AND target_note_id IS NULL AND target_title_normalized = ?").run(targetNoteId, userId, normalized);
}

export async function sourceNoteIdsReferencingTarget(
  database: SqliteDatabase,
  userId: string,
  targetNoteId: string,
  afterSourceNoteId: string,
  limit: number,
) {
  const rows = await all<{ source_note_id: string }>(
    database,
    `SELECT DISTINCT nl.source_note_id
     FROM note_links nl
     JOIN notes n ON n.id = nl.source_note_id AND n.user_id = nl.user_id
     WHERE nl.user_id = ? AND nl.target_note_id = ? AND nl.source_note_id != ?
       AND n.deleted_at IS NULL AND nl.source_note_id > ?
     ORDER BY nl.source_note_id
     LIMIT ?`,
    userId,
    targetNoteId,
    targetNoteId,
    afterSourceNoteId,
    limit,
  );
  return rows.map((row) => row.source_note_id);
}
