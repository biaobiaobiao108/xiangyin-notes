import type { KanbanCard, KanbanStatus } from "../../shared/types";
import {
  all,
  first,
  json,
  jsonError,
  NOTE_FROM,
  NOTE_LIST_SELECT,
  now,
  parseIndexedTags,
  readJson,
  toNote,
  type NoteRow,
  type RouteContext,
  type SqliteDatabase,
  type SqlValue,
  type UserRow,
} from "../core";
import { publishWorkspaceChange } from "../realtime";

type KanbanCardRow = NoteRow & {
  tags_json: string;
  card_note_id: string;
  card_user_id: string;
  card_status: KanbanStatus;
  card_sort_order: number;
  card_created_at: number;
  card_updated_at: number;
};

const VALID_STATUSES = new Set<KanbanStatus>(["inbox", "doing", "done", "archived"]);

function isValidStatus(value: unknown): value is KanbanStatus {
  return typeof value === "string" && VALID_STATUSES.has(value as KanbanStatus);
}

const KANBAN_FROM = `
  kanban_cards k
  JOIN notes n ON n.id = k.note_id
  JOIN notebooks b ON b.id = n.notebook_id
  LEFT JOIN image_assets a ON a.note_id = n.id AND a.document_order = 0
`;

function toKanbanCard(row: KanbanCardRow): KanbanCard {
  return {
    noteId: row.card_note_id,
    userId: row.card_user_id,
    status: row.card_status,
    sortOrder: row.card_sort_order,
    createdAt: row.card_created_at,
    updatedAt: row.card_updated_at,
    note: toNote(row, parseIndexedTags(row.tags_json)),
  };
}

function getKanbanCard(
  database: SqliteDatabase,
  userId: string,
  noteId: string,
): KanbanCard | null {
  const row = first<KanbanCardRow>(
    database,
    `
      SELECT
        k.note_id AS card_note_id,
        k.user_id AS card_user_id,
        k.status AS card_status,
        k.sort_order AS card_sort_order,
        k.created_at AS card_created_at,
        k.updated_at AS card_updated_at,
        ${NOTE_LIST_SELECT}
      FROM ${KANBAN_FROM}
      WHERE k.user_id = ? AND k.note_id = ? AND n.deleted_at IS NULL
    `,
    userId,
    noteId,
  );
  return row ? toKanbanCard(row) : null;
}

export async function handleKanbanRoute(
  ctx: RouteContext,
  user: UserRow,
): Promise<Response | null> {
  const { request, url, method, segments, options } = ctx;
  const { database } = options;
  const resource = segments[0] ?? "";
  const id = segments[1] ?? "";
  const subId = segments[2] ?? "";

  if (resource !== "kanban") return null;

  // GET /api/kanban or GET /api/kanban/cards
  if ((!id || id === "cards") && method === "GET") {
    const notebookId = url.searchParams.get("notebookId");
    const status = url.searchParams.get("status");

    if (status && !isValidStatus(status)) {
      return jsonError(400, "INVALID_ARGUMENT", "状态无效");
    }

    const conditions: string[] = ["k.user_id = ?", "n.deleted_at IS NULL"];
    const params: SqlValue[] = [user.id];

    if (notebookId) {
      conditions.push("n.notebook_id = ?");
      params.push(notebookId);
    }

    if (status) {
      conditions.push("k.status = ?");
      params.push(status);
    } else {
      conditions.push("k.status != 'archived'");
    }

    const rows = all<KanbanCardRow>(
      database,
      `
        SELECT
          k.note_id AS card_note_id,
          k.user_id AS card_user_id,
          k.status AS card_status,
          k.sort_order AS card_sort_order,
          k.created_at AS card_created_at,
          k.updated_at AS card_updated_at,
          ${NOTE_LIST_SELECT}
        FROM ${KANBAN_FROM}
        WHERE ${conditions.join(" AND ")}
        ORDER BY k.sort_order ASC, k.updated_at DESC
      `,
      ...params,
    );

    return json({ cards: rows.map(toKanbanCard) });
  }

  // GET /api/kanban/archived
  if (id === "archived" && !subId && method === "GET") {
    const notebookId = url.searchParams.get("notebookId");
    const conditions: string[] = ["k.user_id = ?", "n.deleted_at IS NULL", "k.status = 'archived'"];
    const params: SqlValue[] = [user.id];

    if (notebookId) {
      conditions.push("n.notebook_id = ?");
      params.push(notebookId);
    }

    const rows = all<KanbanCardRow>(
      database,
      `
        SELECT
          k.note_id AS card_note_id,
          k.user_id AS card_user_id,
          k.status AS card_status,
          k.sort_order AS card_sort_order,
          k.created_at AS card_created_at,
          k.updated_at AS card_updated_at,
          ${NOTE_LIST_SELECT}
        FROM ${KANBAN_FROM}
        WHERE ${conditions.join(" AND ")}
        ORDER BY k.updated_at DESC
      `,
      ...params,
    );

    return json({ cards: rows.map(toKanbanCard) });
  }

  // POST /api/kanban/cards
  if ((!id || id === "cards") && method === "POST") {
    const body = await readJson<{
      noteId?: string;
      status?: KanbanStatus;
      sortOrder?: number;
    }>(request, 64 * 1024);

    const noteId = body?.noteId?.trim();
    if (!noteId) {
      return jsonError(400, "INVALID_ARGUMENT", "noteId 不能为空");
    }

    const status: KanbanStatus = body?.status ?? "inbox";
    if (!isValidStatus(status)) {
      return jsonError(400, "INVALID_ARGUMENT", "状态无效");
    }

    // Verify note exists and belongs to user
    const note = first<{ id: string }>(
      database,
      "SELECT id FROM notes WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
      noteId,
      user.id,
    );
    if (!note) {
      return jsonError(404, "NOT_FOUND", "笔记不存在或已删除");
    }

    let sortOrder = body?.sortOrder;
    if (typeof sortOrder !== "number" || !Number.isFinite(sortOrder)) {
      const maxRow = first<{ max_order: number | null }>(
        database,
        "SELECT MAX(sort_order) AS max_order FROM kanban_cards WHERE user_id = ? AND status = ?",
        user.id,
        status,
      );
      sortOrder = (maxRow?.max_order ?? 0) + 1000;
    }

    const timestamp = now();
    database
      .query(
        `
          INSERT INTO kanban_cards (note_id, user_id, status, sort_order, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(note_id) DO UPDATE SET
            status = excluded.status,
            sort_order = excluded.sort_order,
            updated_at = excluded.updated_at
        `,
      )
      .run(noteId, user.id, status, sortOrder, timestamp, timestamp);

    const card = getKanbanCard(database, user.id, noteId);
    if (options.realtime) {
      publishWorkspaceChange(options, user.id, { resource: "notes", noteId }, request);
    }
    return json({ card }, 201);
  }

  // PATCH /api/kanban/cards/:noteId
  if (id === "cards" && subId && method === "PATCH") {
    const noteId = subId;
    const body = await readJson<{
      status?: KanbanStatus;
      sortOrder?: number;
    }>(request, 64 * 1024);

    const existing = first<{ status: KanbanStatus; sort_order: number }>(
      database,
      "SELECT status, sort_order FROM kanban_cards WHERE note_id = ? AND user_id = ?",
      noteId,
      user.id,
    );
    if (!existing) {
      return jsonError(404, "NOT_FOUND", "看板卡片不存在");
    }

    let newStatus = existing.status;
    if (body?.status !== undefined) {
      if (!isValidStatus(body.status)) {
        return jsonError(400, "INVALID_ARGUMENT", "状态无效");
      }
      newStatus = body.status;
    }

    let newSortOrder = existing.sort_order;
    if (body?.sortOrder !== undefined) {
      if (typeof body.sortOrder !== "number" || !Number.isFinite(body.sortOrder)) {
        return jsonError(400, "INVALID_ARGUMENT", "排序值无效");
      }
      newSortOrder = body.sortOrder;
    }

    const timestamp = now();
    database
      .query(
        "UPDATE kanban_cards SET status = ?, sort_order = ?, updated_at = ? WHERE note_id = ? AND user_id = ?",
      )
      .run(newStatus, newSortOrder, timestamp, noteId, user.id);

    const card = getKanbanCard(database, user.id, noteId);
    if (options.realtime) {
      publishWorkspaceChange(options, user.id, { resource: "notes", noteId }, request);
    }
    return json({ card });
  }

  // DELETE /api/kanban/cards/:noteId
  if (id === "cards" && subId && method === "DELETE") {
    const noteId = subId;
    database
      .query("DELETE FROM kanban_cards WHERE note_id = ? AND user_id = ?")
      .run(noteId, user.id);

    if (options.realtime) {
      publishWorkspaceChange(options, user.id, { resource: "notes", noteId }, request);
    }
    return json({ ok: true, noteId });
  }

  return null;
}
