import type { Notebook } from "../../shared/types";
import {
  all,
  first,
  json,
  jsonError,
  now,
  readJson,
  type RouteContext,
  type SqliteDatabase,
  type UserRow,
  validText,
} from "../core";
import { publishWorkspaceChange } from "../realtime";

type NotebookRowWithCount = {
  id: string;
  user_id: string;
  name: string;
  color: string;
  is_system: number;
  updated_at: number;
  count: number;
};

export function validColor(value: unknown) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

export function toNotebook(row: NotebookRowWithCount): Notebook {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    isSystem: Boolean(row.is_system),
    count: Number(row.count),
    updatedAt: row.updated_at,
  };
}

export function getNotebook(database: SqliteDatabase, userId: string, notebookId: string) {
  return first<NotebookRowWithCount>(database, `
    SELECT b.id, b.name, b.color, b.is_system, b.updated_at,
      (SELECT COUNT(*) FROM notes n WHERE n.notebook_id = b.id AND n.user_id = b.user_id AND n.deleted_at IS NULL) AS count
    FROM notebooks b WHERE b.id = ? AND b.user_id = ?
  `, notebookId, userId);
}

export async function handleNotebooksRoute(ctx: RouteContext, user: UserRow): Promise<Response | null> {
  const { request, method, segments, options } = ctx;
  const { database } = options;
  const resource = segments[0] ?? "";
  const id = segments[1] ?? "";

  if (resource !== "notebooks") return null;

  if (!id && method === "GET") {
    const rows = all<NotebookRowWithCount>(database, `
      SELECT b.id, b.name, b.color, b.is_system, b.updated_at,
        (SELECT COUNT(*) FROM notes n WHERE n.notebook_id = b.id AND n.user_id = b.user_id AND n.deleted_at IS NULL) AS count
      FROM notebooks b WHERE b.user_id = ? ORDER BY b.sort_order, b.name
    `, user.id);
    return json({ notebooks: rows.map(toNotebook) });
  }

  if (!id && method === "POST") {
    const payload = await readJson<{ name?: unknown; color?: unknown }>(request, 64 * 1024);
    if (!payload || !validText(payload.name, 40) || !(payload.name as string).trim()) {
      return jsonError(400, "INVALID_NOTEBOOK", "请输入笔记本名称");
    }
    const notebookId = crypto.randomUUID();
    const createdAt = now();
    const color = payload.color === undefined ? "#718077" : payload.color;
    if (!validColor(color)) return jsonError(400, "INVALID_NOTEBOOK", "请输入有效的六位十六进制颜色");
    try {
      database.query("INSERT INTO notebooks (id, user_id, name, color, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, 10, ?, ?)").run(notebookId, user.id, (payload.name as string).trim(), color as string, createdAt, createdAt);
    } catch {
      return jsonError(409, "NOTEBOOK_EXISTS", "已经有同名笔记本");
    }
    const created = getNotebook(database, user.id, notebookId);
    publishWorkspaceChange(options, user.id, { resource: "notebooks" }, request);
    return json({ notebook: created ? toNotebook(created) : null }, 201);
  }

  if (id && method === "PATCH") {
    const current = getNotebook(database, user.id, id);
    if (!current) return jsonError(404, "NOTEBOOK_NOT_FOUND", "笔记本不存在");
    const payload = await readJson<{ name?: unknown; color?: unknown }>(request, 64 * 1024);
    const name = payload?.name === undefined ? current.name : payload.name;
    const color = payload?.color === undefined ? current.color : payload.color;
    if (!validText(name, 40) || !(name as string).trim() || !validColor(color)) {
      return jsonError(400, "INVALID_NOTEBOOK", "笔记本名称或颜色无效");
    }
    try {
      database.query("UPDATE notebooks SET name = ?, color = ?, updated_at = ? WHERE id = ? AND user_id = ?").run((name as string).trim(), color as string, now(), current.id, user.id);
    } catch {
      return jsonError(409, "NOTEBOOK_EXISTS", "已经有同名笔记本");
    }
    const updated = getNotebook(database, user.id, current.id);
    publishWorkspaceChange(options, user.id, { resource: "notebooks" }, request);
    return json({ notebook: updated ? toNotebook(updated) : null });
  }

  if (id && method === "DELETE") {
    const current = first<{ id: string; is_system: number }>(database, "SELECT id, is_system FROM notebooks WHERE id = ? AND user_id = ?", id, user.id);
    if (!current) return jsonError(404, "NOTEBOOK_NOT_FOUND", "笔记本不存在");
    if (current.is_system) return jsonError(400, "SYSTEM_NOTEBOOK", "收件箱不能删除");
    const inbox = first<{ id: string }>(database, "SELECT id FROM notebooks WHERE user_id = ? AND is_system = 1 LIMIT 1", user.id);
    if (!inbox) return jsonError(500, "NO_INBOX", "找不到收件箱");
    const transaction = database.transaction(() => {
      const movedNotes = all<{ id: string }>(database, "SELECT id FROM notes WHERE notebook_id = ? AND user_id = ?", current.id, user.id);
      for (const note of movedNotes) {
        database.query("UPDATE notes SET notebook_id = ?, version = version + 1, updated_at = ? WHERE id = ? AND user_id = ?").run(inbox.id, now(), note.id, user.id);
      }
      database.query("DELETE FROM notebooks WHERE id = ? AND user_id = ?").run(current.id, user.id);
    });
    transaction();
    publishWorkspaceChange(options, user.id, { resource: "notebooks" }, request);
    return json({ ok: true });
  }

  return null;
}
