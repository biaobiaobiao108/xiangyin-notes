import { extractMarkdownTasks, findMarkdownTaskMarker } from "../../shared/tasks";
import {
  all,
  first,
  getNote,
  json,
  jsonError,
  NOTE_CONTENT_MAX_LENGTH,
  readJson,
  toFullNote,
  type RouteContext,
  type UserRow,
} from "../core";
import { publishWorkspaceChange } from "../realtime";
import { updateNote } from "./note-mutations";

const TASK_PAGE_SIZE = 100;
const TASK_PAGE_MAX_SIZE = 200;
// JSON can use six bytes per UTF-16 code unit, plus the task locator fields.
const TASK_TOGGLE_MAX_BYTES = 6 * NOTE_CONTENT_MAX_LENGTH + 1024;
const NOTE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

type TaskCursor = { sortCreatedAt: number; noteId: string; ordinal: number };

function decodeTaskCursor(value: string | null): TaskCursor | null | false {
  if (value === null) return null;
  if (value.length > 1024) return false;
  try {
    const cursor = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<TaskCursor>;
    if (
      !Number.isSafeInteger(cursor.sortCreatedAt) ||
      typeof cursor.noteId !== "string" ||
      !NOTE_ID_PATTERN.test(cursor.noteId) ||
      !Number.isSafeInteger(cursor.ordinal) ||
      (cursor.ordinal as number) < 0
    )
      return false;
    return cursor as TaskCursor;
  } catch {
    return false;
  }
}

function encodeTaskCursor(cursor: TaskCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export async function handleTasksRoute(ctx: RouteContext, user: UserRow): Promise<Response | null> {
  const { request, url, method, segments, options } = ctx;
  const { database } = options;
  const resource = segments[0] ?? "";
  const id = segments[1] ?? "";

  if (resource === "tasks" && !id && method === "GET") {
    const status = url.searchParams.get("status") ?? "open";
    if (status !== "open" && status !== "done" && status !== "all")
      return jsonError(400, "INVALID_ARGUMENT", "status 必须为 open、done 或 all");

    const limitValue = url.searchParams.get("limit");
    const limit = limitValue === null ? TASK_PAGE_SIZE : Number(limitValue);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > TASK_PAGE_MAX_SIZE)
      return jsonError(
        400,
        "INVALID_ARGUMENT",
        `limit 必须为 1 到 ${TASK_PAGE_MAX_SIZE} 之间的整数`,
      );
    const cursor = decodeTaskCursor(url.searchParams.get("cursor"));
    if (cursor === false) return jsonError(400, "INVALID_ARGUMENT", "任务分页游标无效");

    const notebookId = url.searchParams.get("notebookId");
    if (notebookId) {
      const notebook = first(
        database,
        "SELECT id FROM notebooks WHERE id = ? AND user_id = ?",
        notebookId,
        user.id,
      );
      if (!notebook) return jsonError(404, "NOT_FOUND", "笔记本不存在");
    }

    const filters = ["t.user_id = ?", "n.deleted_at IS NULL"];
    const values: Array<string | number> = [user.id];
    if (notebookId) {
      filters.push("t.notebook_id = ?");
      values.push(notebookId);
    }
    if (status !== "all") {
      filters.push("t.done = ?");
      values.push(status === "done" ? 1 : 0);
    }
    if (cursor) {
      filters.push("(t.sort_created_at, t.note_id, t.ordinal) > (?, ?, ?)");
      values.push(cursor.sortCreatedAt, cursor.noteId, cursor.ordinal);
    }

    const rows = all<{
      note_id: string;
      note_title: string;
      notebook_id: string;
      notebook_name: string;
      version: number;
      text: string;
      done: number;
      ordinal: number;
      depth: number;
      sort_created_at: number;
    }>(
      database,
      `
        SELECT t.note_id, n.title AS note_title, t.notebook_id, b.name AS notebook_name,
          n.version, t.text, t.done, t.ordinal, t.depth, t.sort_created_at
        FROM note_tasks t
        JOIN notes n ON n.id = t.note_id AND n.user_id = t.user_id
        JOIN notebooks b ON b.id = t.notebook_id AND b.user_id = t.user_id
        WHERE ${filters.join(" AND ")}
        ORDER BY t.sort_created_at ASC, t.note_id ASC, t.ordinal ASC
        LIMIT ?
      `,
      ...values,
      limit + 1,
    );
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const tasks = pageRows.map((task) => ({
      noteId: task.note_id,
      noteTitle: task.note_title,
      notebookId: task.notebook_id,
      notebookName: task.notebook_name,
      version: task.version,
      text: task.text,
      done: task.done === 1,
      ordinal: task.ordinal,
      depth: task.depth,
    }));
    const last = pageRows.at(-1);
    const nextCursor =
      hasMore && last
        ? encodeTaskCursor({
            sortCreatedAt: last.sort_created_at,
            noteId: last.note_id,
            ordinal: last.ordinal,
          })
        : null;

    let total: number | undefined;
    if (!cursor) {
      const countFilters = ["user_id = ?"];
      const countValues: Array<string | number> = [user.id];
      if (notebookId) {
        countFilters.push("notebook_id = ?");
        countValues.push(notebookId);
      }
      if (status !== "all") {
        countFilters.push("done = ?");
        countValues.push(status === "done" ? 1 : 0);
      }
      const count = first<{ total: number }>(
        database,
        `
          SELECT COALESCE(SUM(task_count), 0) AS total
          FROM note_task_counts
          WHERE ${countFilters.join(" AND ")}
        `,
        ...countValues,
      );
      total = Number(count?.total ?? 0);
    }
    return json({ tasks, total, nextCursor });
  }

  if (resource === "tasks" && id === "toggle" && method === "POST") {
    const payload = await readJson<{
      noteId?: unknown;
      version?: unknown;
      ordinal?: unknown;
      text?: unknown;
      completed?: unknown;
    }>(request, TASK_TOGGLE_MAX_BYTES);
    if (
      !payload ||
      typeof payload.noteId !== "string" ||
      !NOTE_ID_PATTERN.test(payload.noteId) ||
      !Number.isSafeInteger(payload.version) ||
      (payload.version as number) < 1 ||
      !Number.isSafeInteger(payload.ordinal) ||
      (payload.ordinal as number) < 0 ||
      typeof payload.text !== "string" ||
      payload.text.length > NOTE_CONTENT_MAX_LENGTH ||
      typeof payload.completed !== "boolean"
    )
      return jsonError(400, "INVALID_ARGUMENT", "任务定位信息无效");

    const current = getNote(database, user.id, payload.noteId);
    if (!current || current.deleted_at !== null) return jsonError(404, "NOT_FOUND", "笔记不存在");
    if (current.version !== payload.version)
      return jsonError(409, "VERSION_CONFLICT", "笔记已发生变化，请刷新任务列表后重试");

    const task = extractMarkdownTasks(current.content_markdown)[payload.ordinal as number];
    if (!task || task.text !== payload.text || task.completed !== payload.completed)
      return jsonError(409, "VERSION_CONFLICT", "任务已发生变化，请刷新任务列表后重试");

    const marker = findMarkdownTaskMarker(current.content_markdown, task.ordinal);
    if (!marker || marker.checked !== task.completed)
      return jsonError(409, "VERSION_CONFLICT", "无法安全定位任务，请刷新任务列表后重试");

    const replacement = task.completed ? "[ ]" : "[x]";
    const contentMarkdown =
      current.content_markdown.slice(0, marker.start) +
      replacement +
      current.content_markdown.slice(marker.end);
    if (
      !updateNote(
        database,
        current,
        user.id,
        current.title,
        contentMarkdown,
        current.notebook_id,
        current.is_favorite,
        current.deleted_at,
      )
    )
      return jsonError(409, "VERSION_CONFLICT", "笔记已发生变化，请刷新任务列表后重试");

    const updated = getNote(database, user.id, payload.noteId);
    publishWorkspaceChange(
      options,
      user.id,
      { resource: "notes", noteId: payload.noteId },
      request,
    );
    return updated
      ? json({ note: toFullNote(updated) })
      : jsonError(404, "NOT_FOUND", "笔记不存在");
  }

  return null;
}
