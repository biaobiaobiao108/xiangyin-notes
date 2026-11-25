import { NOTE_BATCH_LIMIT } from "../../shared/types";
import {
  all,
  json,
  jsonError,
  now,
  readJson,
  type RouteContext,
  type SqliteDatabase,
  type UserRow,
} from "../core";
import { resolveNoteLinksForTitles } from "../note-links";
import { publishWorkspaceChange } from "../realtime";
import {
  assetPathsForNotes,
  assetPathsForTrash,
  detachMemoReferencedAssets,
  removeAssetFiles,
} from "./assets";
import { syncNoteTasks } from "./note-mutations";

const NOTE_BATCH_BODY_MAX_BYTES = 2 * 1024 * 1024;

type BatchNoteEntry = {
  id: string;
  version: number;
};

type BatchNoteState = {
  id: string;
  title: string;
  deleted_at: number | null;
  version: number;
  notebook_id: string;
  created_at: number;
};

class BatchNoteConflictError extends Error {
  constructor(readonly conflictIds: string[]) {
    super("batch-note-conflict");
    this.name = "BatchNoteConflictError";
  }
}

function parseBatchNoteEntries(payload: unknown): BatchNoteEntry[] | null {
  if (
    !payload ||
    typeof payload !== "object" ||
    !Array.isArray((payload as { notes?: unknown }).notes)
  )
    return null;
  const rawNotes = (payload as { notes: unknown[] }).notes;
  if (rawNotes.length === 0 || rawNotes.length > NOTE_BATCH_LIMIT) return null;

  const entries: BatchNoteEntry[] = [];
  const seen = new Set<string>();
  for (const rawNote of rawNotes) {
    if (!rawNote || typeof rawNote !== "object") return null;
    const id = (rawNote as { id?: unknown }).id;
    const version = (rawNote as { version?: unknown }).version;
    if (
      typeof id !== "string" ||
      !id ||
      seen.has(id) ||
      !Number.isSafeInteger(version) ||
      (version as number) < 1
    )
      return null;
    seen.add(id);
    entries.push({ id, version: version as number });
  }
  return entries;
}

function getBatchNoteStates(database: SqliteDatabase, userId: string, entries: BatchNoteEntry[]) {
  return all<BatchNoteState>(
    database,
    `SELECT id, title, deleted_at, version, notebook_id, created_at
     FROM notes WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))`,
    userId,
    JSON.stringify(entries.map((entry) => entry.id)),
  );
}

function assertBatchNoteStates(
  rows: BatchNoteState[],
  entries: BatchNoteEntry[],
  mode: "trash" | "restore" | "permanent",
) {
  const states = new Map(rows.map((row) => [row.id, row]));
  const conflictIds = entries
    .filter((entry) => {
      const row = states.get(entry.id);
      return (
        !row ||
        row.version !== entry.version ||
        (mode === "trash" ? row.deleted_at !== null : row.deleted_at === null)
      );
    })
    .map((entry) => entry.id);
  if (conflictIds.length) throw new BatchNoteConflictError(conflictIds);
}

function batchConflictResponse(error: BatchNoteConflictError) {
  // AGENTS.md requires every version conflict to surface as 409 VERSION_CONFLICT.
  return json(
    {
      error: {
        code: "VERSION_CONFLICT",
        message: "选中的笔记已发生变化，请重新选择后重试",
        conflictIds: error.conflictIds,
      },
    },
    409,
  );
}

export async function handleNoteBatchRoute(
  ctx: RouteContext,
  user: UserRow,
  assetRoot: string,
): Promise<Response | null> {
  const { request, url, method, segments, options } = ctx;
  const { database } = options;
  const resource = segments[0] ?? "";
  const id = segments[1] ?? "";

  if (
    method === "DELETE" &&
    (url.pathname === "/api/trash" || (resource === "notes" && id === "trash"))
  ) {
    const emptyTrash = database.transaction(() => {
      const trashedNotes = all<{
        id: string;
        notebook_id: string;
        created_at: number;
      }>(
        database,
        "SELECT id, notebook_id, created_at FROM notes WHERE user_id = ? AND deleted_at IS NOT NULL",
        user.id,
      );
      detachMemoReferencedAssets(
        database,
        user.id,
        trashedNotes.map((note) => note.id),
      );
      const assetPaths = assetPathsForTrash(database, user.id);
      for (const note of trashedNotes)
        syncNoteTasks(database, user.id, note.id, note.notebook_id, note.created_at, "");
      const deletedCount = trashedNotes.length;
      database.query("DELETE FROM notes WHERE user_id = ? AND deleted_at IS NOT NULL").run(user.id);
      return { deletedCount, assetPaths };
    });
    const emptiedTrash = emptyTrash();
    if (emptiedTrash.deletedCount > 0)
      publishWorkspaceChange(options, user.id, { resource: "notebooks" }, request);
    await removeAssetFiles(assetRoot, emptiedTrash.assetPaths);
    return json({ ok: true, deletedCount: emptiedTrash.deletedCount });
  }

  // Batch move to trash or permanent deletion. Both operations validate every
  // selected note in one transaction so a stale selection cannot partially apply.
  if (resource !== "notes" || id !== "batch" || (method !== "PATCH" && method !== "DELETE")) {
    return null;
  }

  const payload = await readJson<{ notes?: unknown; deleted?: unknown }>(
    request,
    NOTE_BATCH_BODY_MAX_BYTES,
  );
  if (
    method === "PATCH" &&
    payload?.deleted !== undefined &&
    typeof payload.deleted !== "boolean"
  ) {
    return jsonError(400, "INVALID_BATCH_NOTES", "批量回收站状态无效");
  }
  if (Array.isArray(payload?.notes) && payload.notes.length > NOTE_BATCH_LIMIT)
    return jsonError(413, "TOO_MANY_BATCH_NOTES", `一次最多处理 ${NOTE_BATCH_LIMIT} 篇笔记`);
  const entries = parseBatchNoteEntries(payload);
  if (!entries) return jsonError(400, "INVALID_BATCH_NOTES", "批量操作的笔记参数无效");

  if (method === "PATCH") {
    if (payload?.deleted === false) {
      let restored: { restoredIds: string[] };
      try {
        restored = database
          .transaction(() => {
            const rows = getBatchNoteStates(database, user.id, entries);
            assertBatchNoteStates(rows, entries, "restore");
            const update = database.query(
              "UPDATE notes SET deleted_at = NULL, version = version + 1 WHERE id = ? AND user_id = ? AND version = ? AND deleted_at IS NOT NULL",
            );
            const readBody = database.query<{ content_markdown: string }, [string, string]>(
              "SELECT content_markdown FROM notes WHERE id = ? AND user_id = ?",
            );
            const rowsById = new Map(rows.map((row) => [row.id, row]));
            for (const entry of entries) {
              const note = rowsById.get(entry.id)!;
              syncNoteTasks(
                database,
                user.id,
                note.id,
                note.notebook_id,
                note.created_at,
                readBody.get(note.id, user.id)!.content_markdown,
              );
              if (!update.run(entry.id, user.id, entry.version).changes)
                throw new BatchNoteConflictError([entry.id]);
            }
            resolveNoteLinksForTitles(
              database,
              user.id,
              rows.map((row) => row.title),
            );
            return { restoredIds: entries.map((entry) => entry.id) };
          })
          .immediate();
      } catch (error) {
        if (error instanceof BatchNoteConflictError) return batchConflictResponse(error);
        throw error;
      }
      publishWorkspaceChange(options, user.id, { resource: "notebooks" }, request);
      return json({ ok: true, restoredIds: restored.restoredIds });
    }

    let moved: { deletedIds: string[] };
    try {
      moved = database
        .transaction(() => {
          const rows = getBatchNoteStates(database, user.id, entries);
          assertBatchNoteStates(rows, entries, "trash");
          const deletedAt = now();
          const update = database.query(
            "UPDATE notes SET deleted_at = ?, version = version + 1 WHERE id = ? AND user_id = ? AND version = ? AND deleted_at IS NULL",
          );
          const rowsById = new Map(rows.map((row) => [row.id, row]));
          for (const entry of entries) {
            const note = rowsById.get(entry.id)!;
            syncNoteTasks(database, user.id, note.id, note.notebook_id, note.created_at, "");
            if (!update.run(deletedAt, entry.id, user.id, entry.version).changes)
              throw new BatchNoteConflictError([entry.id]);
          }
          resolveNoteLinksForTitles(
            database,
            user.id,
            rows.map((row) => row.title),
          );
          return { deletedIds: entries.map((entry) => entry.id) };
        })
        .immediate();
    } catch (error) {
      if (error instanceof BatchNoteConflictError) return batchConflictResponse(error);
      throw error;
    }
    publishWorkspaceChange(options, user.id, { resource: "notebooks" }, request);
    return json({ ok: true, deletedIds: moved.deletedIds });
  }

  let deleted: { deletedIds: string[]; assetPaths: string[] };
  try {
    deleted = database
      .transaction(() => {
        const rows = getBatchNoteStates(database, user.id, entries);
        assertBatchNoteStates(rows, entries, "permanent");
        const deletedIds = entries.map((entry) => entry.id);
        detachMemoReferencedAssets(database, user.id, deletedIds);
        const assetPaths = assetPathsForNotes(database, user.id, deletedIds);
        for (const note of rows)
          syncNoteTasks(database, user.id, note.id, note.notebook_id, note.created_at, "");
        const deleteLinks = database.query(
          "DELETE FROM note_links WHERE user_id = ? AND source_note_id = ?",
        );
        const deleteNote = database.query(
          "DELETE FROM notes WHERE id = ? AND user_id = ? AND version = ? AND deleted_at IS NOT NULL",
        );
        for (const entry of entries) {
          if (!deleteNote.run(entry.id, user.id, entry.version).changes)
            throw new BatchNoteConflictError([entry.id]);
          deleteLinks.run(user.id, entry.id);
        }
        return { deletedIds, assetPaths };
      })
      .immediate();
  } catch (error) {
    if (error instanceof BatchNoteConflictError) return batchConflictResponse(error);
    throw error;
  }
  publishWorkspaceChange(options, user.id, { resource: "notebooks" }, request);
  await removeAssetFiles(assetRoot, deleted.assetPaths);
  return json({ ok: true, deletedIds: deleted.deletedIds });
}
