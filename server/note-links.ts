import type { SqliteDatabase } from "./db";
import { extractWikiLinks, normalizeLinkTitle } from "../shared/wiki-links";

type SqlValue = string | number | null | Uint8Array | bigint;

type ActiveNoteTitleRow = {
  id: string;
  user_id: string;
  title: string;
};

type NoteLinkRow = {
  id: string;
  user_id: string;
  source_note_id: string;
  target_title: string;
  target_note_id: string | null;
};

function all<T>(database: SqliteDatabase, sql: string, ...values: SqlValue[]) {
  return database.query(sql).all(...values) as T[];
}

function activeTitleMap(rows: ActiveNoteTitleRow[]) {
  const targets = new Map<string, string>();
  for (const row of rows) {
    const key = normalizeLinkTitle(row.title);
    if (key && !targets.has(key)) targets.set(key, row.id);
  }
  return targets;
}

function activeTitlesForUser(database: SqliteDatabase, userId: string) {
  return all<ActiveNoteTitleRow>(
    database,
    "SELECT id, user_id, title FROM notes WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC, id",
    userId,
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
  const seen = new Set<string>();
  for (const link of extractWikiLinks(contentMarkdown)) {
    const key = normalizeLinkTitle(link.target);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    database.query("INSERT INTO note_links (id, user_id, source_note_id, target_title, target_note_id, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      crypto.randomUUID(),
      userId,
      sourceNoteId,
      link.target,
      targets.get(key) ?? null,
      createdAt,
    );
  }
}

export function findActiveNoteIdByTitle(database: SqliteDatabase, userId: string, title: string) {
  const normalized = normalizeLinkTitle(title);
  if (!normalized) return null;
  const match = activeTitlesForUser(database, userId).find((row) => normalizeLinkTitle(row.title) === normalized);
  return match?.id ?? null;
}

export function syncNoteLinks(database: SqliteDatabase, userId: string, sourceNoteId: string, contentMarkdown: string, createdAt: number) {
  database.query("DELETE FROM note_links WHERE user_id = ? AND source_note_id = ?").run(userId, sourceNoteId);
  if (!contentMarkdown || (!contentMarkdown.includes("[[") && !contentMarkdown.includes("【【"))) return;
  const targets = activeTitleMap(activeTitlesForUser(database, userId));
  insertNoteLinks(database, userId, sourceNoteId, contentMarkdown, targets, createdAt);
}

export function resolveNoteLinksForUser(database: SqliteDatabase, userId: string) {
  const targets = activeTitleMap(activeTitlesForUser(database, userId));
  const links = all<Pick<NoteLinkRow, "id" | "target_title" | "target_note_id">>(
    database,
    "SELECT id, target_title, target_note_id FROM note_links WHERE user_id = ?",
    userId,
  );
  const update = database.query("UPDATE note_links SET target_note_id = ? WHERE id = ? AND user_id = ?");
  for (const link of links) {
    const targetNoteId = targets.get(normalizeLinkTitle(link.target_title)) ?? null;
    if (targetNoteId !== link.target_note_id) update.run(targetNoteId, link.id, userId);
  }
}

export function resolveNoteLinksForTarget(database: SqliteDatabase, userId: string, title: string, targetNoteId: string) {
  const normalized = normalizeLinkTitle(title);
  if (!normalized) return;
  const links = all<Pick<NoteLinkRow, "id" | "target_title">>(
    database,
    "SELECT id, target_title FROM note_links WHERE user_id = ? AND target_note_id IS NULL",
    userId,
  );
  const update = database.query("UPDATE note_links SET target_note_id = ? WHERE id = ? AND user_id = ? AND target_note_id IS NULL");
  for (const link of links) {
    if (normalizeLinkTitle(link.target_title) === normalized) update.run(targetNoteId, link.id, userId);
  }
}

export function sourceNoteIdsReferencingTarget(database: SqliteDatabase, userId: string, targetNoteId: string, oldTitle: string) {
  const normalizedOldTitle = normalizeLinkTitle(oldTitle);
  const rows = all<Pick<NoteLinkRow, "source_note_id" | "target_title" | "target_note_id">>(
    database,
    "SELECT source_note_id, target_title, target_note_id FROM note_links WHERE user_id = ? AND source_note_id != ?",
    userId,
    targetNoteId,
  );
  return [...new Set(rows
    .filter((row) => row.target_note_id === targetNoteId || normalizeLinkTitle(row.target_title) === normalizedOldTitle)
    .map((row) => row.source_note_id))];
}
