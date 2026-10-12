import {
  all,
  first,
  type ImageAssetRow,
  json,
  jsonError,
  now,
  readBodyBytes,
  type RouteContext,
  type R2BucketBinding,
  type SqliteDatabase,
  toImageAsset,
  type UserRow,
} from "../core";
import { IMAGE_ALLOWED_MIME_TYPES, IMAGE_MAX_BYTES, extensionForMimeType, inspectImage } from "../images";

export const ORPHAN_ASSET_TTL_SECONDS = 24 * 60 * 60;
export const ORPHAN_ASSET_CLEANUP_INTERVAL_SECONDS = 60 * 60;
export const IMAGE_UPLOAD_MAX_BODY_BYTES = IMAGE_MAX_BYTES + 256 * 1024;
const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ASSET_OWNER_DIRECTORY = new RegExp(`^${UUID_PATTERN}$`, "u");
const ASSET_FILE_NAME = new RegExp(`^${UUID_PATTERN}\\.(?:jpg|png|webp|gif)$`, "u");
const nextOrphanAssetCleanupAt = new WeakMap<object, number>();

export function safeOriginalName(value: string) {
  const normalized = value.replace(/[\\/\0]/g, "_").trim();
  return (normalized || "image").slice(0, 200);
}

export async function assetPathsForNotes(database: SqliteDatabase, userId: string, noteIds: string[]) {
  if (!noteIds.length) return [] as string[];
  const assets = await all<{ storage_path: string }>(database, `SELECT storage_path FROM image_assets WHERE user_id = ? AND note_id IN (${noteIds.map(() => "?").join(",")})`, userId, ...noteIds);
  return assets.map((asset) => asset.storage_path);
}

/** Remove backing objects after their metadata rows have been deleted. */
export async function removeAssetFiles(bucket: R2BucketBinding, storagePaths: string[]) {
  if (!storagePaths.length) return;
  try {
    for (let index = 0; index < storagePaths.length; index += 1000) {
      await bucket.delete(storagePaths.slice(index, index + 1000));
    }
  } catch (error) {
    console.warn("[assets] failed to delete R2 objects", storagePaths, error);
  }
}

/** Remove stale database references and old R2 objects that never got a metadata row. */
export async function cleanupOrphanAssets(database: SqliteDatabase, bucket: R2BucketBinding, timestamp = now()) {
  const bucketKey = bucket as object;
  if (timestamp < (nextOrphanAssetCleanupAt.get(bucketKey) ?? 0)) return;
  nextOrphanAssetCleanupAt.set(bucketKey, timestamp + ORPHAN_ASSET_CLEANUP_INTERVAL_SECONDS);

  const staleAssets = await all<{ id: string; storage_path: string }>(database, `
    SELECT a.id, a.storage_path
    FROM image_assets a
    WHERE a.created_at <= ?
      AND (a.note_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM notes n
        WHERE n.id = a.note_id
          AND instr(lower(n.content_markdown), '/api/assets/' || lower(a.id)) > 0
      ))
    LIMIT 100
  `, timestamp - ORPHAN_ASSET_TTL_SECONDS);

  if (staleAssets.length) {
    const deleteResults = await database.batch(staleAssets.map((asset) => ({
      sql: `
        DELETE FROM image_assets
        WHERE id = ?
          AND created_at <= ?
          AND (note_id IS NULL OR NOT EXISTS (
            SELECT 1 FROM notes n
            WHERE n.id = image_assets.note_id
              AND instr(lower(n.content_markdown), '/api/assets/' || lower(image_assets.id)) > 0
          ))
      `,
      values: [asset.id, timestamp - ORPHAN_ASSET_TTL_SECONDS],
    })));
    await removeAssetFiles(bucket, staleAssets.filter((_asset, index) => deleteResults[index]?.changes).map((asset) => asset.storage_path));
  }

  // R2 uploads can outlive a failed metadata insert. Sweep only old, UUID-shaped
  // keys so unrelated objects in a shared bucket are never considered.
  let cursor: string | undefined;
  let pagesProcessed = 0;
  do {
    const page = await bucket.list({ limit: 1000, ...(cursor ? { cursor } : {}) });
    pagesProcessed += 1;
    const staleObjects = page.objects.filter((object) => {
      if (!object.uploaded || Math.floor(object.uploaded.getTime() / 1000) > timestamp - ORPHAN_ASSET_TTL_SECONDS) return false;
      const [owner, fileName, ...rest] = object.key.split("/");
      return rest.length === 0 && ASSET_OWNER_DIRECTORY.test(owner ?? "") && ASSET_FILE_NAME.test(fileName ?? "");
    });
    if (staleObjects.length) {
      const keys = staleObjects.map((o) => o.key);
      const foundPaths = new Set<string>();
      for (let i = 0; i < keys.length; i += 50) {
        const batchKeys = keys.slice(i, i + 50);
        const rows = await all<{ storage_path: string }>(
          database,
          `SELECT storage_path FROM image_assets WHERE storage_path IN (${batchKeys.map(() => "?").join(",")})`,
          ...batchKeys,
        );
        for (const row of rows) foundPaths.add(row.storage_path);
      }
      const unlinkedKeys = keys.filter((key) => !foundPaths.has(key));
      if (unlinkedKeys.length) {
        await removeAssetFiles(bucket, unlinkedKeys);
      }
    }
    cursor = page.truncated && pagesProcessed < 5 ? page.cursor : undefined;
  } while (cursor);
}

export async function uploadImageAsset(request: Request, database: SqliteDatabase, bucket: R2BucketBinding, user: UserRow) {
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
  let objectStored = false;
  try {
    await bucket.put(storagePath, bytes, { httpMetadata: { contentType: inspection.mimeType } });
    objectStored = true;
    await database.query("INSERT INTO image_assets (id, user_id, storage_path, original_name, mime_type, byte_size, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, user.id, storagePath, safeOriginalName(entry.name), inspection.mimeType, bytes.byteLength, inspection.width, inspection.height, now());
  } catch (error) {
    if (objectStored) await bucket.delete(storagePath).catch((cleanupError) => console.warn("[assets] failed to roll back an interrupted R2 upload", id, cleanupError));
    throw error;
  }

  const asset = await first<ImageAssetRow>(database, "SELECT id, user_id, note_id, storage_path, original_name, mime_type, byte_size, width, height, document_order, created_at FROM image_assets WHERE id = ? AND user_id = ?", id, user.id);
  return asset ? json({ asset: toImageAsset(asset) }, 201) : jsonError(500, "ASSET_STORAGE_ERROR", "图片保存失败");
}

export async function serveImageAsset(request: Request, database: SqliteDatabase, bucket: R2BucketBinding, userId: string, assetId: string, cacheControl = "private, max-age=3600") {
  const asset = await first<ImageAssetRow>(database, "SELECT id, user_id, note_id, storage_path, original_name, mime_type, byte_size, width, height, document_order, created_at FROM image_assets WHERE id = ? AND user_id = ?", assetId.toLowerCase(), userId);
  if (!asset) return jsonError(404, "ASSET_NOT_FOUND", "图片不存在");
  const object = await bucket.get(asset.storage_path);
  if (!object) return jsonError(404, "ASSET_NOT_FOUND", "图片不存在");
  const headers = new Headers({
    "Content-Type": asset.mime_type,
    "Content-Length": String(asset.byte_size),
    "Content-Disposition": "inline",
    "Cache-Control": cacheControl,
  });
  return new Response(request.method === "HEAD" ? null : object.body, { headers });
}

export async function handleAssetsRoute(ctx: RouteContext, user: UserRow): Promise<Response | null> {
  const { request, method, segments, options } = ctx;
  const { database, assets } = options;
  const resource = segments[0] ?? "";
  const id = segments[1] ?? "";
  const subresource = segments[2] ?? "";

  if (resource !== "assets") return null;
  if (!assets) return jsonError(503, "ASSET_STORAGE_UNAVAILABLE", "图片存储暂不可用");
  if (!id && method === "POST") return await uploadImageAsset(request, database, assets, user);
  if (id && !subresource && (method === "GET" || method === "HEAD")) {
    return await serveImageAsset(request, database, assets, user.id, id);
  }
  return null;
}
