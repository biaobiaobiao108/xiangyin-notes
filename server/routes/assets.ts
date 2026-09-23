import { mkdir, rename } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ImageAssetSummary } from "../../shared/types";
import {
  all,
  first,
  type ImageAssetRow,
  json,
  jsonError,
  now,
  readBodyBytes,
  type RouteContext,
  type SqliteDatabase,
  toImageAsset,
  type UserRow,
} from "../core";
import { databasePathFromEnv } from "../db";
import { IMAGE_ALLOWED_MIME_TYPES, IMAGE_MAX_BYTES, extensionForMimeType, inspectImage } from "../images";

type RuntimeEnvironment = Record<string, string | undefined>;

export const ORPHAN_ASSET_TTL_SECONDS = 24 * 60 * 60;
export const ORPHAN_ASSET_CLEANUP_INTERVAL_SECONDS = 60 * 60;
export const IMAGE_UPLOAD_MAX_BODY_BYTES = IMAGE_MAX_BYTES + 256 * 1024;
let nextOrphanAssetCleanupAt = 0;

export function assetRootFromEnv(environment: RuntimeEnvironment = Bun.env) {
  const configured = environment.ASSETS_PATH?.trim();
  if (configured) return resolve(configured);
  const databasePath = databasePathFromEnv(environment);
  return databasePath === ":memory:" ? resolve("./data/attachments") : join(dirname(resolve(databasePath)), "attachments");
}

export function assetFilePath(assetRoot: string, storagePath: string) {
  const root = resolve(assetRoot);
  const requested = resolve(root, storagePath);
  const pathFromRoot = relative(root, requested);
  if (isAbsolute(pathFromRoot) || pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || pathFromRoot.startsWith(sep)) return null;
  return requested;
}

export function safeOriginalName(value: string) {
  const normalized = value.replace(/[\\/\0]/g, "_").trim();
  return (normalized || "image").slice(0, 200);
}

export function assetPathsForNotes(database: SqliteDatabase, userId: string, noteIds: string[]) {
  if (!noteIds.length) return [] as string[];
  return all<{ storage_path: string }>(database, `SELECT storage_path FROM image_assets WHERE user_id = ? AND note_id IN (${noteIds.map(() => "?").join(",")})`, userId, ...noteIds).map((asset) => asset.storage_path);
}

export async function removeAssetFiles(assetRoot: string, storagePaths: string[]) {
  for (const storagePath of storagePaths) {
    const filePath = assetFilePath(assetRoot, storagePath);
    if (!filePath) {
      console.warn("[assets] refused to delete an unsafe storage path", storagePath);
      continue;
    }
    try {
      await Bun.file(filePath).unlink();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("[assets] failed to delete asset file", filePath, error);
    }
  }
}

export async function cleanupOrphanAssets(database: SqliteDatabase, assetRoot: string) {
  const timestamp = now();
  if (timestamp < nextOrphanAssetCleanupAt) return;
  nextOrphanAssetCleanupAt = timestamp + ORPHAN_ASSET_CLEANUP_INTERVAL_SECONDS;
  const staleAssets = all<{ id: string; storage_path: string }>(database, `
    SELECT a.id, a.storage_path
    FROM image_assets a
    WHERE a.created_at <= ?
      AND (
        a.note_id IS NULL
        OR (
          NOT EXISTS (
            SELECT 1
            FROM notes n
            WHERE n.id = a.note_id
              AND instr(n.content_markdown, '/api/assets/' || a.id) > 0
          )
          AND NOT EXISTS (
            SELECT 1
            FROM shares s
            WHERE s.note_id = a.note_id
              AND s.revoked_at IS NULL
              AND s.expires_at > ?
              AND instr(s.snapshot_content_markdown, a.id) > 0
          )
        )
      )
    LIMIT 100
  `, timestamp - ORPHAN_ASSET_TTL_SECONDS, timestamp);
  if (!staleAssets.length) return;
  const deleteStaleAssets = database.transaction(() => {
    const deletedPaths: string[] = [];
    const statement = database.query(`
      DELETE FROM image_assets
      WHERE id = ?
        AND (
          note_id IS NULL
          OR (
            NOT EXISTS (
              SELECT 1
              FROM notes n
              WHERE n.id = image_assets.note_id
                AND instr(n.content_markdown, '/api/assets/' || image_assets.id) > 0
            )
            AND NOT EXISTS (
              SELECT 1
              FROM shares s
              WHERE s.note_id = image_assets.note_id
                AND s.revoked_at IS NULL
                AND s.expires_at > ?
                AND instr(s.snapshot_content_markdown, image_assets.id) > 0
            )
          )
        )
    `);
    for (const asset of staleAssets) {
      if (statement.run(asset.id, timestamp).changes) deletedPaths.push(asset.storage_path);
    }
    return deletedPaths;
  });
  await removeAssetFiles(assetRoot, deleteStaleAssets());
}

export async function uploadImageAsset(request: Request, database: SqliteDatabase, user: UserRow, assetRoot: string) {
  const body = await readBodyBytes(request, IMAGE_UPLOAD_MAX_BODY_BYTES);
  if (!body.ok) {
    return body.reason === "too-large"
      ? jsonError(413, "IMAGE_TOO_LARGE", "图片超过 10 MiB 大小限制")
      : jsonError(400, "INVALID_IMAGE_UPLOAD", "图片上传数据无效");
  }

  let formData: FormData;
  try {
    const formHeaders = new Headers();
    const contentType = request.headers.get("Content-Type");
    if (contentType) formHeaders.set("Content-Type", contentType);
    formData = await new Request(request.url, {
      method: request.method,
      headers: formHeaders,
      body: body.bytes.buffer as ArrayBuffer,
    }).formData();
  } catch {
    return jsonError(400, "INVALID_IMAGE_UPLOAD", "图片上传数据无效");
  }
  const entry = formData.get("file");
  if (!(entry instanceof File)) return jsonError(400, "INVALID_IMAGE_UPLOAD", "请选择图片文件");
  if (entry.size <= 0 || entry.size > IMAGE_MAX_BYTES) return jsonError(413, "IMAGE_TOO_LARGE", "图片超过 10 MiB 大小限制");

  const bytes = new Uint8Array(await entry.arrayBuffer());
  const inspection = inspectImage(bytes);
  if (!inspection || !IMAGE_ALLOWED_MIME_TYPES.has(inspection.mimeType)) return jsonError(415, "UNSUPPORTED_IMAGE", "只支持 JPEG、PNG、WebP 和 GIF 图片");

  const id = crypto.randomUUID();
  const storagePath = `${user.id}/${id}${extensionForMimeType(inspection.mimeType)}`;
  const filePath = assetFilePath(assetRoot, storagePath);
  if (!filePath) return jsonError(500, "ASSET_STORAGE_ERROR", "图片存储路径无效");
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.uploading-${crypto.randomUUID()}`;
  try {
    await Bun.write(temporaryPath, bytes);
    await rename(temporaryPath, filePath);
    database.query("INSERT INTO image_assets (id, user_id, storage_path, original_name, mime_type, byte_size, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, user.id, storagePath, safeOriginalName(entry.name), inspection.mimeType, bytes.byteLength, inspection.width, inspection.height, now());
  } catch (error) {
    await Bun.file(temporaryPath).unlink().catch(() => undefined);
    await Bun.file(filePath).unlink().catch(() => undefined);
    throw error;
  }

  const asset = first<ImageAssetRow>(database, "SELECT id, user_id, note_id, storage_path, original_name, mime_type, byte_size, width, height, document_order, created_at FROM image_assets WHERE id = ? AND user_id = ?", id, user.id);
  return asset ? json({ asset: toImageAsset(asset) }, 201) : jsonError(500, "ASSET_STORAGE_ERROR", "图片保存失败");
}

export async function serveImageAsset(request: Request, database: SqliteDatabase, userId: string, assetId: string, assetRoot: string, cacheControl = "private, max-age=3600") {
  const asset = first<ImageAssetRow>(database, "SELECT id, user_id, note_id, storage_path, original_name, mime_type, byte_size, width, height, document_order, created_at FROM image_assets WHERE id = ? AND user_id = ?", assetId, userId);
  if (!asset) return jsonError(404, "ASSET_NOT_FOUND", "图片不存在");
  const filePath = assetFilePath(assetRoot, asset.storage_path);
  if (!filePath) return jsonError(404, "ASSET_NOT_FOUND", "图片不存在");
  const file = Bun.file(filePath);
  if (!(await file.exists())) return jsonError(404, "ASSET_NOT_FOUND", "图片不存在");
  const headers = new Headers({
    "Content-Type": asset.mime_type,
    "Content-Length": String(asset.byte_size),
    "Content-Disposition": "inline",
    "Cache-Control": cacheControl,
  });
  return new Response(request.method === "HEAD" ? null : file, { headers });
}

export async function handleAssetsRoute(ctx: RouteContext, user: UserRow, assetRoot: string): Promise<Response | null> {
  const { request, method, segments, options } = ctx;
  const { database } = options;
  const resource = segments[0] ?? "";
  const id = segments[1] ?? "";
  const subresource = segments[2] ?? "";

  if (resource !== "assets") return null;

  if (!id && method === "POST") {
    return await uploadImageAsset(request, database, user, assetRoot);
  }

  if (id && !subresource && (method === "GET" || method === "HEAD")) {
    return await serveImageAsset(request, database, user.id, id, assetRoot);
  }

  return null;
}
