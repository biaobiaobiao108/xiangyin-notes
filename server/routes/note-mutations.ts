import {
  InvalidNoteAssetsError,
  type NoteRow,
  now,
  syncNoteAssetReferences,
  syncNoteTags,
  type SqliteDatabase,
  type SqlValue,
} from "../core";
import { syncNoteLinks } from "../note-links";
import { extractMarkdownTasks } from "../../shared/tasks";
import { syncNoteShortSearchTerms } from "../note-search";
import { normalizeSearchTitle, searchableTextFromMarkdown } from "../search-text";
import { Lexer } from "marked";

export function syncNoteTasks(
  database: SqliteDatabase,
  userId: string,
  noteId: string,
  notebookId: string,
  createdAt: number,
  contentMarkdown: string,
  parsedTokens?: ReturnType<Lexer["lex"]>,
) {
  const deltas = new Map<string, { notebookId: string; done: number; count: number }>();
  const addDelta = (targetNotebookId: string, done: number, count: number) => {
    const key = `${targetNotebookId}\0${done}`;
    const delta = deltas.get(key);
    if (delta) delta.count += count;
    else deltas.set(key, { notebookId: targetNotebookId, done, count });
  };
  const tasks = extractMarkdownTasks(contentMarkdown, parsedTokens);
  const existingTasks = database
    .query(
      "SELECT notebook_id, ordinal, depth, text, done FROM note_tasks WHERE note_id = ? ORDER BY ordinal",
    )
    .all(noteId) as Array<{
    notebook_id: string;
    ordinal: number;
    depth: number;
    text: string;
    done: number;
  }>;
  if (
    existingTasks.length === tasks.length &&
    tasks.every((task, index) => {
      const old = existingTasks[index];
      return (
        old.notebook_id === notebookId &&
        old.ordinal === task.ordinal &&
        old.depth === task.depth &&
        old.text === task.text &&
        old.done === Number(task.completed)
      );
    })
  )
    return;
  const oldCounts = database
    .query(
      "SELECT notebook_id, done, COUNT(*) AS task_count FROM note_tasks WHERE note_id = ? GROUP BY notebook_id, done",
    )
    .all(noteId) as Array<{ notebook_id: string; done: number; task_count: number }>;
  for (const oldCount of oldCounts)
    addDelta(oldCount.notebook_id, oldCount.done, -oldCount.task_count);

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
  const tokens = new Lexer({ gfm: true }).lex(contentMarkdown);
  const searchText = searchableTextFromMarkdown(contentMarkdown, tokens);
  const transaction = database.transaction(() => {
    database
      .query(
        "INSERT INTO notes (id, user_id, notebook_id, title, title_normalized, content_markdown, search_text, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
      )
      .run(
        id,
        userId,
        notebookId,
        title,
        normalizeSearchTitle(title),
        contentMarkdown,
        searchText,
        createdAt,
        createdAt,
      );
    if (!syncNoteAssetReferences(database, userId, id, contentMarkdown))
      throw new Error("invalid-note-assets");
    syncNoteTags(database, userId, id, contentMarkdown);
    syncNoteShortSearchTerms(database, userId, id, title, searchText);
    syncNoteLinks(database, userId, id, contentMarkdown);
    syncNoteTasks(database, userId, id, notebookId, createdAt, contentMarkdown, tokens);
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
  const contentChanged = current.content_markdown !== contentMarkdown;
  const notebookChanged = current.notebook_id !== notebookId;
  const deletedChanged = current.deleted_at !== deletedAt;
  const updatedAt = titleChanged || contentChanged ? now() : current.updated_at;
  const tokens = contentChanged ? new Lexer({ gfm: true }).lex(contentMarkdown) : undefined;
  const searchText = contentChanged
    ? searchableTextFromMarkdown(contentMarkdown, tokens)
    : titleChanged
      ? (
          database
            .query(
              "SELECT COALESCE(search_text, content_markdown) AS text FROM notes WHERE id = ? AND user_id = ?",
            )
            .get(current.id, userId) as { text: string }
        ).text
      : null;

  const fields = [
    "notebook_id = ?",
    "is_favorite = ?",
    "deleted_at = ?",
    "version = version + 1",
    "updated_at = ?",
  ];
  const values: SqlValue[] = [notebookId, isFavorite, deletedAt, updatedAt];
  if (titleChanged) {
    fields.push("title = ?", "title_normalized = ?");
    values.push(title, normalizeSearchTitle(title));
  }
  if (contentChanged) {
    fields.push("content_markdown = ?");
    values.push(contentMarkdown);
    fields.push("search_text = ?");
    values.push(searchText);
  }
  const updated = database
    .query(
      `UPDATE notes SET ${fields.join(", ")} WHERE id = ? AND user_id = ? AND version = ? RETURNING id`,
    )
    .get(...values, current.id, userId, current.version) as { id: string } | null;
  if (!updated) return false;
  if (titleChanged || contentChanged)
    syncNoteShortSearchTerms(database, userId, current.id, title, searchText!);
  if (contentChanged && !syncNoteAssetReferences(database, userId, current.id, contentMarkdown))
    throw new InvalidNoteAssetsError();
  if (contentChanged || notebookChanged || deletedChanged) {
    syncNoteTasks(
      database,
      userId,
      current.id,
      notebookId,
      current.created_at,
      deletedAt === null ? contentMarkdown : "",
      deletedAt === null ? tokens : undefined,
    );
  }
  if (contentChanged) {
    syncNoteTags(database, userId, current.id, contentMarkdown);
    syncNoteLinks(database, userId, current.id, contentMarkdown);
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
