import { replaceWikiLinkTarget } from "../../shared/wiki-links";
import {
  all,
  InvalidNoteAssetsError,
  NOTE_CONTENT_MAX_LENGTH,
  NOTE_FROM,
  NOTE_SELECT,
  type NoteRow,
  now,
  syncNoteAssetReferences,
  syncNoteTags,
  type SqliteDatabase,
  type SqlValue,
} from "../core";
import {
  resolveNoteLinksForTarget,
  resolveNoteLinksForTitles,
  sourceNoteIdsReferencingTarget,
  syncNoteLinks,
  syncStoredNoteTitleKey,
} from "../note-links";
import { extractMarkdownTasks } from "../../shared/tasks";
import { syncNoteSearchIndexes } from "../note-search";

export const NOTE_RENAME_SOURCE_BATCH_SIZE = 16;

export function syncNoteTasks(
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
  const oldCounts = database
    .query(
      "SELECT notebook_id, done, COUNT(*) AS task_count FROM note_tasks WHERE note_id = ? GROUP BY notebook_id, done",
    )
    .all(noteId) as Array<{ notebook_id: string; done: number; task_count: number }>;
  for (const oldCount of oldCounts)
    addDelta(oldCount.notebook_id, oldCount.done, -oldCount.task_count);

  const tasks = extractMarkdownTasks(contentMarkdown);
  for (const task of tasks) addDelta(notebookId, task.completed ? 1 : 0, 1);

  database.query("DELETE FROM note_tasks WHERE note_id = ?").run(noteId);
  const updateTaskCount = database.query(
    "INSERT INTO note_task_counts (user_id, notebook_id, done, task_count) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, notebook_id, done) DO UPDATE SET task_count = excluded.task_count",
  );
  for (const delta of deltas.values()) {
    if (delta.count === 0) continue;
    const existing = database
      .query(
        "SELECT task_count FROM note_task_counts WHERE user_id = ? AND notebook_id = ? AND done = ?",
      )
      .get(userId, delta.notebookId, delta.done) as { task_count: number } | null;
    const nextCount = Number(existing?.task_count ?? 0) + delta.count;
    if (nextCount < 0) throw new Error("note-task-count-index-corrupt");
    if (nextCount === 0) {
      database
        .query("DELETE FROM note_task_counts WHERE user_id = ? AND notebook_id = ? AND done = ?")
        .run(userId, delta.notebookId, delta.done);
    } else {
      updateTaskCount.run(userId, delta.notebookId, delta.done, nextCount);
    }
  }

  const insertTask = database.query(
    "INSERT INTO note_tasks (note_id, user_id, notebook_id, ordinal, depth, text, done, sort_created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const task of tasks) {
    insertTask.run(
      noteId,
      userId,
      notebookId,
      task.ordinal,
      task.depth,
      task.text,
      task.completed ? 1 : 0,
      -createdAt,
    );
  }
}

export class NoteRenameContentTooLargeError extends Error {
  constructor() {
    super("note-rename-content-too-large");
  }
}

export function createNote(
  database: SqliteDatabase,
  userId: string,
  notebookId: string,
  title: string,
  contentMarkdown: string,
  requestedId?: string,
) {
  const id = requestedId ?? crypto.randomUUID();
  const createdAt = now();
  const transaction = database.transaction(() => {
    database
      .query(
        "INSERT INTO notes (id, user_id, notebook_id, title, content_markdown, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
      )
      .run(id, userId, notebookId, title, contentMarkdown, createdAt, createdAt);
    syncStoredNoteTitleKey(database, id, title);
    if (!syncNoteAssetReferences(database, userId, id, contentMarkdown))
      throw new Error("invalid-note-assets");
    syncNoteTags(database, userId, id, contentMarkdown);
    syncNoteSearchIndexes(database, userId, id, title, contentMarkdown);
    syncNoteLinks(database, userId, id, contentMarkdown, createdAt);
    syncNoteTasks(database, userId, id, notebookId, createdAt, contentMarkdown);
    resolveNoteLinksForTarget(database, userId, title, id);
  });
  transaction();
  return id;
}

export function updateNoteInTransaction(
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
  const oldTitle = current.title;
  let nextContentMarkdown = contentMarkdown;
  if (titleChanged && oldTitle.trim() && title.trim()) {
    const replaced = replaceWikiLinkTarget(contentMarkdown, oldTitle, title);
    if (replaced.count > 0) {
      if (replaced.content.length > NOTE_CONTENT_MAX_LENGTH)
        throw new NoteRenameContentTooLargeError();
      nextContentMarkdown = replaced.content;
    }
  }
  const contentChanged = current.content_markdown !== nextContentMarkdown;
  const notebookChanged = current.notebook_id !== notebookId;
  const deletedChanged = current.deleted_at !== deletedAt;
  const updatedAt = titleChanged || contentChanged ? now() : current.updated_at;

  const fields = [
    "notebook_id = ?",
    "is_favorite = ?",
    "deleted_at = ?",
    "version = version + 1",
    "updated_at = ?",
  ];
  const values: SqlValue[] = [notebookId, isFavorite, deletedAt, updatedAt];
  if (titleChanged) {
    fields.push("title = ?");
    values.push(title);
  }
  if (contentChanged) {
    fields.push("content_markdown = ?");
    values.push(nextContentMarkdown);
  }
  const updated = database
    .query(
      `UPDATE notes SET ${fields.join(", ")} WHERE id = ? AND user_id = ? AND version = ? RETURNING id`,
    )
    .get(...values, current.id, userId, current.version) as { id: string } | null;
  if (!updated) return false;
  if (titleChanged) syncStoredNoteTitleKey(database, current.id, title);
  if (titleChanged || contentChanged)
    syncNoteSearchIndexes(database, userId, current.id, title, nextContentMarkdown);
  if (contentChanged && !syncNoteAssetReferences(database, userId, current.id, nextContentMarkdown))
    throw new InvalidNoteAssetsError();
  if (contentChanged || notebookChanged || deletedChanged) {
    syncNoteTasks(
      database,
      userId,
      current.id,
      notebookId,
      current.created_at,
      deletedAt === null ? nextContentMarkdown : "",
    );
  }
  if (contentChanged) {
    syncNoteTags(database, userId, current.id, nextContentMarkdown);
    syncNoteLinks(database, userId, current.id, nextContentMarkdown, updatedAt);
  }

  if (titleChanged && oldTitle.trim() && title.trim()) {
    let afterSourceNoteId = "";
    while (true) {
      const sourceNoteIds = sourceNoteIdsReferencingTarget(
        database,
        userId,
        current.id,
        afterSourceNoteId,
        NOTE_RENAME_SOURCE_BATCH_SIZE,
      );
      if (sourceNoteIds.length === 0) break;
      afterSourceNoteId = sourceNoteIds[sourceNoteIds.length - 1]!;

      const placeholders = sourceNoteIds.map(() => "?").join(", ");
      const referencingNotes = all<NoteRow>(
        database,
        `
        SELECT ${NOTE_SELECT}
        FROM ${NOTE_FROM}
        WHERE n.id IN (${placeholders}) AND n.user_id = ?
      `,
        ...sourceNoteIds,
        userId,
      );
      for (const refNote of referencingNotes) {
        const { content: replacedContent, count } = replaceWikiLinkTarget(
          refNote.content_markdown,
          oldTitle,
          title,
        );
        if (count === 0) continue;
        if (replacedContent.length > NOTE_CONTENT_MAX_LENGTH)
          throw new NoteRenameContentTooLargeError();
        database
          .query(
            "UPDATE notes SET content_markdown = ?, version = version + 1, updated_at = ? WHERE id = ? AND user_id = ?",
          )
          .run(replacedContent, updatedAt, refNote.id, userId);
        syncNoteSearchIndexes(database, userId, refNote.id, refNote.title, replacedContent);
        syncNoteTags(database, userId, refNote.id, replacedContent);
        syncNoteLinks(database, userId, refNote.id, replacedContent, updatedAt);
        syncNoteTasks(
          database,
          userId,
          refNote.id,
          refNote.notebook_id,
          refNote.created_at,
          replacedContent,
        );
      }
    }
  }
  if (titleChanged || deletedChanged) {
    resolveNoteLinksForTitles(database, userId, [oldTitle, title]);
  }

  return true;
}

export function updateNote(
  database: SqliteDatabase,
  current: NoteRow,
  userId: string,
  title: string,
  contentMarkdown: string,
  notebookId: string,
  isFavorite: number,
  deletedAt: number | null,
) {
  return database.transaction(() =>
    updateNoteInTransaction(
      database,
      current,
      userId,
      title,
      contentMarkdown,
      notebookId,
      isFavorite,
      deletedAt,
    ),
  )();
}
