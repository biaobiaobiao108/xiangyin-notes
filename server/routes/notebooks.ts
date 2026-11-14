import type { Notebook } from "../../shared/types";
import { SQLiteError } from "bun:sqlite";
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
import { syncNoteTasks } from "./note-mutations";

type NotebookRowWithCount = {
  id: string;
  user_id: string;
  name: string;
  color: string;
  icon: string;
  is_system: number;
  updated_at: number;
  count: number;
  total_count: number;
};

export const VALID_NOTEBOOK_ICONS = [
  "folder",
  "book",
  "bookmark",
  "file-text",
  "tag",
  "star",
  "heart",
  "sparkles",
  "lightbulb",
  "compass",
  "code",
  "terminal",
  "briefcase",
  "graduation-cap",
  "palette",
  "smile",
] as const;

export function validNotebookIcon(value: unknown): value is string {
  return typeof value === "string" && (VALID_NOTEBOOK_ICONS as readonly string[]).includes(value);
}

export function validColor(value: unknown) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

function isNotebookNameConflict(error: unknown): error is SQLiteError {
  return error instanceof SQLiteError && error.code === "SQLITE_CONSTRAINT_UNIQUE";
}

export function toNotebook(row: NotebookRowWithCount): Notebook {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    icon: row.icon,
    isSystem: Boolean(row.is_system),
    count: Number(row.count),
    totalCount: Number(row.total_count),
    updatedAt: row.updated_at,
  };
}

export function getNotebook(database: SqliteDatabase, userId: string, notebookId: string) {
  return first<NotebookRowWithCount>(
    database,
    `
    SELECT b.id, b.name, b.color, b.icon, b.is_system, b.updated_at,
      (SELECT COUNT(*) FROM notes n WHERE n.notebook_id = b.id AND n.user_id = b.user_id AND n.deleted_at IS NULL) AS count,
      (SELECT COUNT(*) FROM notes n WHERE n.notebook_id = b.id AND n.user_id = b.user_id) AS total_count
    FROM notebooks b WHERE b.id = ? AND b.user_id = ?
  `,
    notebookId,
    userId,
  );
}

export async function handleNotebooksRoute(
  ctx: RouteContext,
  user: UserRow,
): Promise<Response | null> {
  const { request, method, segments, options } = ctx;
  const { database } = options;
  const resource = segments[0] ?? "";
  const id = segments[1] ?? "";
  const subresource = segments[2] ?? "";
  if (resource !== "notebooks") return null;

  if (id === "reorder" && method === "PATCH") {
    const payload = await readJson<{ ids?: unknown; expectedIds?: unknown }>(request, 64 * 1024);
    if (
      !payload ||
      !Array.isArray(payload.ids) ||
      !Array.isArray(payload.expectedIds) ||
      !payload.ids.every((value) => typeof value === "string") ||
      !payload.expectedIds.every((value) => typeof value === "string")
    ) {
      return jsonError(400, "INVALID_NOTEBOOK_ORDER", "笔记本顺序无效");
    }
    const ids = payload.ids as string[];
    const expectedIds = payload.expectedIds as string[];
    const transaction = database.transaction(() => {
      const current = all<{ id: string }>(
        database,
        "SELECT id FROM notebooks WHERE user_id = ? AND is_system = 0 ORDER BY sort_order, name, id",
        user.id,
      ).map((row) => row.id);
      if (
        current.length !== expectedIds.length ||
        current.some((value, index) => value !== expectedIds[index])
      )
        return "stale" as const;
      if (
        ids.length !== current.length ||
        new Set(ids).size !== ids.length ||
        ids.some((value) => !current.includes(value))
      )
        return "invalid" as const;
      const update = database.query(
        "UPDATE notebooks SET sort_order = ? WHERE id = ? AND user_id = ? AND is_system = 0",
      );
      ids.forEach((notebookId, index) => update.run((index + 1) * 10, notebookId, user.id));
      return "ok" as const;
    });
    const result = transaction();
    if (result === "stale")
      return jsonError(409, "NOTEBOOK_ORDER_CHANGED", "笔记本列表已变化，请重试");
    if (result === "invalid")
      return jsonError(400, "INVALID_NOTEBOOK_ORDER", "必须提交全部自建笔记本且不能重复");
    publishWorkspaceChange(options, user.id, { resource: "notebooks" }, request);
    return json({ ok: true, ids });
  }

  if (!id && method === "GET") {
    const rows = all<NotebookRowWithCount>(
      database,
      `
      SELECT b.id, b.name, b.color, b.icon, b.is_system, b.updated_at,
        (SELECT COUNT(*) FROM notes n WHERE n.notebook_id = b.id AND n.user_id = b.user_id AND n.deleted_at IS NULL) AS count,
        (SELECT COUNT(*) FROM notes n WHERE n.notebook_id = b.id AND n.user_id = b.user_id) AS total_count
      FROM notebooks b WHERE b.user_id = ? ORDER BY b.is_system DESC, b.sort_order, b.name, b.id
    `,
      user.id,
    );
    return json({ notebooks: rows.map(toNotebook) });
  }

  if (!id && method === "POST") {
    const payload = await readJson<{ name?: unknown; color?: unknown; icon?: unknown }>(
      request,
      64 * 1024,
    );
    if (!payload || !validText(payload.name, 40) || !(payload.name as string).trim()) {
      return json(
        {
          error: {
            code: "INVALID_ARGUMENT",
            field: "name",
            message: "字段 name 必须是非空笔记本名称，最多 40 个字符",
          },
        },
        400,
      );
    }
    const notebookId = crypto.randomUUID();
    const createdAt = now();
    const color = payload.color === undefined ? "#718077" : payload.color;
    if (!validColor(color))
      return json(
        {
          error: {
            code: "INVALID_ARGUMENT",
            field: "color",
            message: "请输入有效的六位十六进制颜色",
          },
        },
        400,
      );
    const icon = payload.icon === undefined ? "folder" : payload.icon;
    if (!validNotebookIcon(icon))
      return json(
        { error: { code: "INVALID_ARGUMENT", field: "icon", message: "请输入有效的笔记本图标" } },
        400,
      );
    try {
      database
        .query(
          "INSERT INTO notebooks (id, user_id, name, color, icon, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, COALESCE((SELECT MAX(sort_order) + 10 FROM notebooks WHERE user_id = ? AND is_system = 0), 10), ?, ?)",
        )
        .run(
          notebookId,
          user.id,
          (payload.name as string).trim(),
          color as string,
          icon as string,
          user.id,
          createdAt,
          createdAt,
        );
    } catch (error) {
      if (isNotebookNameConflict(error))
        return jsonError(409, "NOTEBOOK_EXISTS", "已经有同名笔记本");
      throw error;
    }
    const created = getNotebook(database, user.id, notebookId);
    publishWorkspaceChange(options, user.id, { resource: "notebooks" }, request);
    return json({ notebook: created ? toNotebook(created) : null }, 201);
  }

  if (id && !subresource && method === "PATCH") {
    const payload = await readJson<{
      name?: unknown;
      color?: unknown;
      icon?: unknown;
      expectedUpdatedAt?: unknown;
    }>(request, 64 * 1024);
    const expected = payload?.expectedUpdatedAt;
    if (typeof expected !== "number" || !Number.isSafeInteger(expected) || expected < 0) {
      return jsonError(400, "INVALID_NOTEBOOK_VERSION", "expectedUpdatedAt 必填且必须是非负整数");
    }
    const current = getNotebook(database, user.id, id);
    if (!current) return jsonError(404, "NOTEBOOK_NOT_FOUND", "笔记本不存在");
    const name = payload?.name === undefined ? current.name : payload.name;
    const color = payload?.color === undefined ? current.color : payload.color;
    const icon = payload?.icon === undefined ? current.icon || "folder" : payload.icon;
    if (!validText(name, 40) || !(name as string).trim()) {
      return json(
        {
          error: {
            code: "INVALID_ARGUMENT",
            field: "name",
            message: "字段 name 必须是非空笔记本名称，最多 40 个字符",
          },
        },
        400,
      );
    }
    if (!validColor(color))
      return json(
        {
          error: {
            code: "INVALID_ARGUMENT",
            field: "color",
            message: "请输入有效的六位十六进制颜色",
          },
        },
        400,
      );
    if (!validNotebookIcon(icon))
      return json(
        { error: { code: "INVALID_ARGUMENT", field: "icon", message: "请输入有效的笔记本图标" } },
        400,
      );
    try {
      const update = database.query(
        "UPDATE notebooks SET name = ?, color = ?, icon = ?, updated_at = ? WHERE id = ? AND user_id = ? AND updated_at = ?",
      );
      const updated = update.run(
        (name as string).trim(),
        color as string,
        icon as string,
        Math.max(now(), expected + 1),
        current.id,
        user.id,
        expected,
      );
      if (!updated.changes)
        return jsonError(409, "NOTEBOOK_CHANGED", "笔记本已在其他设备更新，请刷新后重试");
    } catch (error) {
      if (isNotebookNameConflict(error))
        return jsonError(409, "NOTEBOOK_EXISTS", "已经有同名笔记本");
      throw error;
    }
    const updated = getNotebook(database, user.id, current.id);
    publishWorkspaceChange(options, user.id, { resource: "notebooks" }, request);
    return json({ notebook: updated ? toNotebook(updated) : null });
  }

  if (id && !subresource && method === "DELETE") {
    const current = first<{ id: string; is_system: number }>(
      database,
      "SELECT id, is_system FROM notebooks WHERE id = ? AND user_id = ?",
      id,
      user.id,
    );
    if (!current) return jsonError(404, "NOTEBOOK_NOT_FOUND", "笔记本不存在");
    if (current.is_system) return jsonError(400, "SYSTEM_NOTEBOOK", "收件箱不能删除");
    const inbox = first<{ id: string }>(
      database,
      "SELECT id FROM notebooks WHERE user_id = ? AND is_system = 1 LIMIT 1",
      user.id,
    );
    if (!inbox) return jsonError(500, "NO_INBOX", "找不到收件箱");
    const payload = request.body
      ? await readJson<{ expectedNoteCount?: unknown }>(request, 64 * 1024)
      : null;
    const expectedNoteCount = payload?.expectedNoteCount;
    if (
      expectedNoteCount !== undefined &&
      (!Number.isInteger(expectedNoteCount) || (expectedNoteCount as number) < 0)
    ) {
      return jsonError(400, "INVALID_NOTEBOOK_COUNT", "预期笔记数量无效");
    }
    const transaction = database.transaction(() => {
      const actualCount = Number(
        first<{ count: number }>(
          database,
          "SELECT COUNT(*) AS count FROM notes WHERE notebook_id = ? AND user_id = ?",
          current.id,
          user.id,
        )?.count ?? 0,
      );
      if (expectedNoteCount !== undefined && actualCount !== expectedNoteCount) {
        return { movedCount: 0, actualCount, expectedNoteCount, mismatch: true as const };
      }
      const updateNote = database.query(
        "UPDATE notes SET notebook_id = ?, version = version + 1 WHERE id = ? AND user_id = ?",
      );
      let movedCount = 0;
      while (true) {
        const movedNotes = all<{
          id: string;
          content_markdown: string;
          created_at: number;
          deleted_at: number | null;
        }>(
          database,
          "SELECT id, content_markdown, created_at, deleted_at FROM notes WHERE notebook_id = ? AND user_id = ? LIMIT 100",
          current.id,
          user.id,
        );
        if (!movedNotes.length) break;
        for (const note of movedNotes) {
          syncNoteTasks(
            database,
            user.id,
            note.id,
            inbox.id,
            note.created_at,
            note.deleted_at === null ? note.content_markdown : "",
          );
          updateNote.run(inbox.id, note.id, user.id);
        }
        movedCount += movedNotes.length;
      }
      database.query("DELETE FROM notebooks WHERE id = ? AND user_id = ?").run(current.id, user.id);
      return { movedCount, mismatch: false as const };
    });
    const outcome = transaction();
    if (outcome.mismatch) {
      return json(
        {
          error: {
            code: "NOTEBOOK_COUNT_MISMATCH",
            message: `笔记本当前有 ${outcome.actualCount} 篇笔记，与 expectedNoteCount=${String(outcome.expectedNoteCount)} 不一致，已取消删除`,
            actualCount: outcome.actualCount,
            expectedNoteCount: outcome.expectedNoteCount,
          },
        },
        409,
      );
    }
    const movedCount = outcome.movedCount;
    publishWorkspaceChange(options, user.id, { resource: "notebooks" }, request);
    // Moving notes bumps their version, so clients must refresh before saving again.
    if (movedCount) publishWorkspaceChange(options, user.id, { resource: "notes" }, request);
    return json({ ok: true, movedCount, versionsInvalidated: movedCount > 0 });
  }

  return null;
}
