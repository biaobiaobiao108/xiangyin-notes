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
} from "../core";
import {
  resolveNoteLinksForTarget,
  resolveNoteLinksForTitles,
  sourceNoteIdsReferencingTarget,
  syncNoteLinks,
  syncStoredNoteTitleKey,
} from "../note-links";
import { syncNoteShortSearchTerms } from "../note-search";

export const NOTE_RENAME_SOURCE_BATCH_SIZE = 16;

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
    syncNoteShortSearchTerms(database, userId, id, title, contentMarkdown);
    syncNoteLinks(database, userId, id, contentMarkdown, createdAt);
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
  const contentChanged = current.content_markdown !== contentMarkdown;
  const notebookChanged = current.notebook_id !== notebookId;
  const deletedChanged = current.deleted_at !== deletedAt;
  const updatedAt =
    titleChanged || contentChanged || notebookChanged || deletedChanged
      ? now()
      : current.updated_at;
  const oldTitle = current.title;

  const updated = database
    .query(
      "UPDATE notes SET title = ?, content_markdown = ?, notebook_id = ?, is_favorite = ?, deleted_at = ?, version = version + 1, updated_at = ? WHERE id = ? AND user_id = ? AND version = ? RETURNING id",
    )
    .get(
      title,
      contentMarkdown,
      notebookId,
      isFavorite,
      deletedAt,
      updatedAt,
      current.id,
      userId,
      current.version,
    ) as { id: string } | null;
  if (!updated) return false;
  if (titleChanged) syncStoredNoteTitleKey(database, current.id, title);
  if (contentChanged && !syncNoteAssetReferences(database, userId, current.id, contentMarkdown))
    throw new InvalidNoteAssetsError();
  if (contentChanged || titleChanged)
    syncNoteShortSearchTerms(database, userId, current.id, title, contentMarkdown);
  if (contentChanged) {
    syncNoteTags(database, userId, current.id, contentMarkdown);
    syncNoteLinks(database, userId, current.id, contentMarkdown, updatedAt);
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
        WHERE n.id IN (${placeholders}) AND n.user_id = ? AND n.deleted_at IS NULL
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
        syncNoteTags(database, userId, refNote.id, replacedContent);
        syncNoteShortSearchTerms(database, userId, refNote.id, refNote.title, replacedContent);
        syncNoteLinks(database, userId, refNote.id, replacedContent, updatedAt);
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
