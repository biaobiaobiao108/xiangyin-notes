import { replaceWikiLinkTarget } from "../../shared/wiki-links";
import {
  all,
  InvalidNoteAssetsError,
  isInvalidNoteAssetReferenceError,
  noteAssetReferenceStatements,
  NOTE_CONTENT_MAX_LENGTH,
  NOTE_FROM,
  NOTE_SELECT,
  type NoteRow,
  now,
  syncNoteTags,
  type SqliteDatabase,
  type SqlValue,
  validNoteAssetReferences,
} from "../core";
import {
  resolveNoteLinksForTarget,
  resolveNoteLinksForTitles,
  sourceNoteIdsReferencingTarget,
  syncNoteLinks,
  syncStoredNoteTitleKey,
} from "../note-links";
import { extractMarkdownTasks } from "../../shared/tasks";

export const NOTE_RENAME_SOURCE_BATCH_SIZE = 16;

export async function syncNoteTasks(
  database: SqliteDatabase,
  userId: string,
  noteId: string,
  notebookId: string,
  createdAt: number,
  contentMarkdown: string,
) {
  const deltas = new Map<string, { notebookId: string; done: number; count: number }>();
  const addDelta = (targetNotebookId: string, done: number, count: number) => {
    const key = `${targetNotebookId}\0${done}`;
    const delta = deltas.get(key);
    if (delta) delta.count += count;
    else deltas.set(key, { notebookId: targetNotebookId, done, count });
  };
  const oldCounts = await all<{ notebook_id: string; done: number; task_count: number }>(
    database,
    "SELECT notebook_id, done, COUNT(*) AS task_count FROM note_tasks WHERE note_id = ? GROUP BY notebook_id, done",
    noteId,
  );
  for (const oldCount of oldCounts)
    addDelta(oldCount.notebook_id, oldCount.done, -oldCount.task_count);

  const tasks = extractMarkdownTasks(contentMarkdown);
  for (const task of tasks) addDelta(notebookId, task.completed ? 1 : 0, 1);

  const statements: { sql: string; values: SqlValue[] }[] = [
    { sql: "DELETE FROM note_tasks WHERE note_id = ?", values: [noteId] },
  ];

  for (const delta of deltas.values()) {
    if (delta.count === 0) continue;
    const existing = (await database
      .query(
        "SELECT task_count FROM note_task_counts WHERE user_id = ? AND notebook_id = ? AND done = ?",
      )
      .get(userId, delta.notebookId, delta.done)) as { task_count: number } | null | undefined;
    const nextCount = Number(existing?.task_count ?? 0) + delta.count;
    if (nextCount < 0) throw new Error("note-task-count-index-corrupt");
    if (nextCount === 0) {
      statements.push({
        sql: "DELETE FROM note_task_counts WHERE user_id = ? AND notebook_id = ? AND done = ?",
        values: [userId, delta.notebookId, delta.done],
      });
    } else {
      statements.push({
        sql: "INSERT INTO note_task_counts (user_id, notebook_id, done, task_count) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, notebook_id, done) DO UPDATE SET task_count = excluded.task_count",
        values: [userId, delta.notebookId, delta.done, nextCount],
      });
    }
  }

  for (const task of tasks) {
    statements.push({
      sql: "INSERT INTO note_tasks (note_id, user_id, notebook_id, ordinal, depth, text, done, sort_created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      values: [
        noteId,
        userId,
        notebookId,
        task.ordinal,
        task.depth,
        task.text,
        task.completed ? 1 : 0,
        -createdAt,
      ],
    });
  }

  await database.batch(statements);
}

export class NoteRenameContentTooLargeError extends Error {
  constructor() {
    super("note-rename-content-too-large");
  }
}

async function collectBacklinkRewrites(
  database: SqliteDatabase,
  userId: string,
  targetNoteId: string,
  oldTitle: string,
  title: string,
) {
  const rewrites: Array<{ note: NoteRow; contentMarkdown: string }> = [];
  let afterSourceNoteId = "";
  while (true) {
    const sourceNoteIds = await sourceNoteIdsReferencingTarget(
      database,
      userId,
      targetNoteId,
      afterSourceNoteId,
      NOTE_RENAME_SOURCE_BATCH_SIZE,
    );
    if (sourceNoteIds.length === 0) break;
    afterSourceNoteId = sourceNoteIds[sourceNoteIds.length - 1]!;

    const placeholders = sourceNoteIds.map(() => "?").join(", ");
    const referencingNotes = await all<NoteRow>(
      database,
      `
      SELECT ${NOTE_SELECT}
      FROM ${NOTE_FROM}
      WHERE n.id IN (${placeholders}) AND n.user_id = ? AND n.deleted_at IS NULL
    `,
      ...sourceNoteIds,
      userId,
    );
    for (const note of referencingNotes) {
      const { content, count } = replaceWikiLinkTarget(note.content_markdown, oldTitle, title);
      if (count === 0) continue;
      if (content.length > NOTE_CONTENT_MAX_LENGTH) throw new NoteRenameContentTooLargeError();
      rewrites.push({ note, contentMarkdown: content });
    }
  }
  return rewrites;
}

export async function createNote(
  database: SqliteDatabase,
  userId: string,
  notebookId: string,
  title: string,
  contentMarkdown: string,
  requestedId?: string,
) {
  const id = requestedId ?? crypto.randomUUID();
  const createdAt = now();
  const guard = {
    sql: "EXISTS (SELECT 1 FROM notes WHERE id = ? AND user_id = ? AND version = 1)",
    values: [id, userId],
  };
  try {
    await database.batch([
      {
        sql: "INSERT INTO notes (id, user_id, notebook_id, title, content_markdown, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
        values: [id, userId, notebookId, title, contentMarkdown, createdAt, createdAt],
      },
      ...noteAssetReferenceStatements(userId, id, contentMarkdown, guard),
    ]);
  } catch (error) {
    if (isInvalidNoteAssetReferenceError(error)) throw new InvalidNoteAssetsError();
    throw error;
  }
  await syncStoredNoteTitleKey(database, id, title);
  await syncNoteTags(database, userId, id, contentMarkdown);
  await syncNoteLinks(database, userId, id, contentMarkdown, createdAt);
  await syncNoteTasks(database, userId, id, notebookId, createdAt, contentMarkdown);
  await resolveNoteLinksForTarget(database, userId, title, id);
  return id;
}

export async function updateNoteInTransaction(
  database: SqliteDatabase,
  current: NoteRow,
  userId: string,
  title: string,
  contentMarkdown: string,
  notebookId: string,
  isFavorite: number,
  deletedAt: number | null,
) {
  const titleChanged = current.title !== title;
  const contentChanged = current.content_markdown !== contentMarkdown;
  const notebookChanged = current.notebook_id !== notebookId;
  const deletedChanged = current.deleted_at !== deletedAt;
  const updatedAt =
    titleChanged || contentChanged || notebookChanged || deletedChanged
      ? now()
      : current.updated_at;
  const oldTitle = current.title;

  const rewrites =
    titleChanged && oldTitle.trim() && title.trim()
      ? await collectBacklinkRewrites(database, userId, current.id, oldTitle, title)
      : [];
  if (
    contentChanged &&
    !(await validNoteAssetReferences(database, userId, current.id, contentMarkdown))
  )
    throw new InvalidNoteAssetsError();

  const assetGuard = {
    sql: "EXISTS (SELECT 1 FROM notes WHERE id = ? AND user_id = ? AND version = ?)",
    values: [current.id, userId, current.version + 1],
  };
  const statements: Array<{ sql: string; values: SqlValue[] }> = [
    {
      sql: "UPDATE notes SET title = ?, content_markdown = ?, notebook_id = ?, is_favorite = ?, deleted_at = ?, version = version + 1, updated_at = ? WHERE id = ? AND user_id = ? AND version = ?",
      values: [
        title,
        contentMarkdown,
        notebookId,
        isFavorite,
        deletedAt,
        updatedAt,
        current.id,
        userId,
        current.version,
      ],
    },
  ];
  if (contentChanged)
    statements.push(
      ...noteAssetReferenceStatements(userId, current.id, contentMarkdown, assetGuard),
    );
  let results;
  try {
    results = await database.batch(statements);
  } catch (error) {
    if (contentChanged && isInvalidNoteAssetReferenceError(error))
      throw new InvalidNoteAssetsError();
    throw error;
  }
  if ((results[0]?.changes ?? 0) === 0) return false;
  if (titleChanged) await syncStoredNoteTitleKey(database, current.id, title);
  if (contentChanged || notebookChanged || deletedChanged) {
    await syncNoteTasks(
      database,
      userId,
      current.id,
      notebookId,
      current.created_at,
      deletedAt === null ? contentMarkdown : "",
    );
  }
  if (contentChanged) {
    await syncNoteTags(database, userId, current.id, contentMarkdown);
    await syncNoteLinks(database, userId, current.id, contentMarkdown, updatedAt);
  }

  for (const rewrite of rewrites) {
    await database
      .query(
        "UPDATE notes SET content_markdown = ?, version = version + 1, updated_at = ? WHERE id = ? AND user_id = ?",
      )
      .run(rewrite.contentMarkdown, updatedAt, rewrite.note.id, userId);
    await syncNoteTags(database, userId, rewrite.note.id, rewrite.contentMarkdown);
    await syncNoteLinks(database, userId, rewrite.note.id, rewrite.contentMarkdown, updatedAt);
    await syncNoteTasks(
      database,
      userId,
      rewrite.note.id,
      rewrite.note.notebook_id,
      rewrite.note.created_at,
      rewrite.contentMarkdown,
    );
  }
  if (titleChanged || deletedChanged) {
    await resolveNoteLinksForTitles(database, userId, [oldTitle, title]);
  }

  return true;
}

export async function updateNote(
  database: SqliteDatabase,
  current: NoteRow,
  userId: string,
  title: string,
  contentMarkdown: string,
  notebookId: string,
  isFavorite: number,
  deletedAt: number | null,
) {
  return await updateNoteInTransaction(
    database,
    current,
    userId,
    title,
    contentMarkdown,
    notebookId,
    isFavorite,
    deletedAt,
  );
}
