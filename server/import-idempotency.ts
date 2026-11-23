import { createHash } from "node:crypto";
import { jsonError, type SqliteDatabase } from "./core";

type ImportResource = "note" | "memo";

export function importContentHash(contentMarkdown: string) {
  return createHash("sha256").update(contentMarkdown, "utf16le").digest("hex");
}

export function getImportRequest(
  database: SqliteDatabase,
  userId: string,
  resource: ImportResource,
  id: string,
) {
  return database
    .query<{ content_hash: string }, [string, ImportResource, string]>(
      "SELECT content_hash FROM import_requests WHERE user_id = ? AND resource = ? AND resource_id = ?",
    )
    .get(userId, resource, id);
}

export function recordImportRequest(
  database: SqliteDatabase,
  userId: string,
  resource: ImportResource,
  id: string,
  contentHash: string,
) {
  database
    .query(
      "INSERT INTO import_requests (user_id, resource, resource_id, content_hash) VALUES (?, ?, ?, ?)",
    )
    .run(userId, resource, id, contentHash);
}

export function importConflict(resource: ImportResource) {
  return jsonError(
    409,
    "IDEMPOTENCY_CONFLICT",
    `Idempotency-Key 已用于其他${resource === "note" ? "笔记" : "随记"}内容`,
  );
}

export function deletedImport(resource: ImportResource) {
  return jsonError(
    410,
    "IMPORTED_RESOURCE_DELETED",
    `此请求已导入，${resource === "note" ? "笔记" : "随记"}已删除`,
    { "Idempotent-Replayed": "true" },
  );
}
