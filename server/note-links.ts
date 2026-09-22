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

const normalizedColumnSupport = new WeakMap<SqliteDatabase, boolean>();

function all<T>(database: SqliteDatabase, sql: string, ...values: SqlValue[]) {
  return database.query(sql).all(...values) as T[];
}

function hasNormalizedColumns(database: SqliteDatabase) {
  const cached = normalizedColumnSupport.get(database);
  if (cached !== undefined) return cached;

  let supported = true;
  try {
    database.query("SELECT title_normalized FROM notes LIMIT 0").all();
    database.query("SELECT target_title_normalized FROM note_links LIMIT 0").all();
  } catch {
    supported = false;
  }
  normalizedColumnSupport.set(database, supported);
  return supported;
}

export function syncStoredNoteTitleKey(database: SqliteDatabase, noteId: string, title: string) {
  if (!hasNormalizedColumns(database)) return;
  database.query("UPDATE notes SET title_normalized = ? WHERE id = ?").run(normalizeLinkTitle(title), noteId);
}

export function backfillNormalizedNoteTitleKeys(database: SqliteDatabase) {
  if (!hasNormalizedColumns(database)) return;
  const notes = all<{ id: string; title: string }>(database, "SELECT id, title FROM notes");
  const links = all<{ id: string; target_title: string }>(database, "SELECT id, target_title FROM note_links");
  const updateNote = database.query("UPDATE notes SET title_normalized = ? WHERE id = ?");
  const updateLink = database.query("UPDATE note_links SET target_title_normalized = ? WHERE id = ?");
  database.transaction(() => {
    for (const note of notes) updateNote.run(normalizeLinkTitle(note.title), note.id);
    for (const link of links) updateLink.run(normalizeLinkTitle(link.target_title), link.id);
  })();
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

function activeTitlesForKeys(database: SqliteDatabase, userId: string, keys: Set<string>) {
  if (keys.size === 0) return [];
  if (!hasNormalizedColumns(database)) return activeTitlesForUser(database, userId);

  const placeholders = [...keys].map(() => "?").join(",");
  const rows = all<ActiveNoteTitleRow>(
    database,
    `SELECT id, user_id, title FROM notes WHERE user_id = ? AND deleted_at IS NULL AND title_normalized IN (${placeholders}) ORDER BY updated_at DESC, id`,
    userId,
    ...keys,
  );
  const targetMap = activeTitleMap(rows);
  if (targetMap.size >= keys.size) return rows;

  // A database upgraded without running the companion backfill still remains correct.
  // Fill only missing keys from the legacy scan until the migration command is run.
  const fallbackRows = activeTitlesForUser(database, userId);
  const seen = new Set(rows.map((row) => normalizeLinkTitle(row.title)));
  return [...rows, ...fallbackRows.filter((row) => keys.has(normalizeLinkTitle(row.title)) && !seen.has(normalizeLinkTitle(row.title)))];
}

function insertNoteLinks(
  database: SqliteDatabase,
  userId: string,
  sourceNoteId: string,
  contentMarkdown: string,
  targets: Map<string, string>,
  createdAt: number,
) {
  const normalizedColumns = hasNormalizedColumns(database);
  const insert = normalizedColumns
    ? database.query("INSERT INTO note_links (id, user_id, source_note_id, target_title, target_title_normalized, target_note_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    : database.query("INSERT INTO note_links (id, user_id, source_note_id, target_title, target_note_id, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  const seen = new Set<string>();
  for (const link of extractWikiLinks(contentMarkdown)) {
    const key = normalizeLinkTitle(link.target);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (normalizedColumns) {
      insert.run(crypto.randomUUID(), userId, sourceNoteId, link.target, key, targets.get(key) ?? null, createdAt);
    } else {
      insert.run(crypto.randomUUID(), userId, sourceNoteId, link.target, targets.get(key) ?? null, createdAt);
    }
  }
}

export function findActiveNoteIdByTitle(database: SqliteDatabase, userId: string, title: string) {
  const normalized = normalizeLinkTitle(title);
  if (!normalized) return null;
  if (hasNormalizedColumns(database)) {
    const match = database.query("SELECT id FROM notes WHERE user_id = ? AND deleted_at IS NULL AND title_normalized = ? ORDER BY updated_at DESC, id LIMIT 1").get(userId, normalized) as { id: string } | null | undefined;
    if (match) return match.id;
  }
  const match = activeTitlesForUser(database, userId).find((row) => normalizeLinkTitle(row.title) === normalized);
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
  if (hasNormalizedColumns(database)) {
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
    return;
  }

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

export function resolveNoteLinksForTitles(database: SqliteDatabase, userId: string, titles: string[]) {
  const normalizedTargets = new Set(titles.map((t) => normalizeLinkTitle(t)).filter(Boolean));
  if (normalizedTargets.size === 0) return;

  if (hasNormalizedColumns(database)) {
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
    return;
  }

  const targets = activeTitleMap(activeTitlesForUser(database, userId));
  const links = all<Pick<NoteLinkRow, "id" | "target_title" | "target_note_id">>(
    database,
    "SELECT id, target_title, target_note_id FROM note_links WHERE user_id = ?",
    userId,
  );
  const update = database.query("UPDATE note_links SET target_note_id = ? WHERE id = ? AND user_id = ?");
  for (const link of links) {
    const key = normalizeLinkTitle(link.target_title);
    if (normalizedTargets.has(key)) {
      const targetNoteId = targets.get(key) ?? null;
      if (targetNoteId !== link.target_note_id) update.run(targetNoteId, link.id, userId);
    }
  }
}

export function resolveNoteLinksForTarget(database: SqliteDatabase, userId: string, title: string, targetNoteId: string) {
  const normalized = normalizeLinkTitle(title);
  if (!normalized) return;

  if (hasNormalizedColumns(database)) {
    database.query("UPDATE note_links SET target_note_id = ? WHERE user_id = ? AND target_note_id IS NULL AND target_title_normalized = ?").run(targetNoteId, userId, normalized);
    return;
  }

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
