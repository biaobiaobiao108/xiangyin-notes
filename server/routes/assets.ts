import type { Dirent } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
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
const PENDING_ASSET_DELETE_DIRECTORY = ".pending-delete";
const PENDING_ASSET_DELETE_BATCH_SIZE = 100;
const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ASSET_OWNER_DIRECTORY = new RegExp(`^${UUID_PATTERN}$`, "u");
const ASSET_FILE_NAME = new RegExp(`^${UUID_PATTERN}\\.(?:jpg|png|webp|gif)$`, "u");
const TEMPORARY_ASSET_FILE_NAME = new RegExp(`^(${UUID_PATTERN}\\.(?:jpg|png|webp|gif))\\.uploading-${UUID_PATTERN}$`, "u");
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

function pendingAssetDeletePath(assetRoot: string, storagePath: string) {
  const marker = Buffer.from(storagePath, "utf8").toString("base64url");
  return join(resolve(assetRoot), PENDING_ASSET_DELETE_DIRECTORY, marker);
}

async function queueAssetDelete(assetRoot: string, storagePath: string) {
  const markerPath = pendingAssetDeletePath(assetRoot, storagePath);
  await mkdir(dirname(markerPath), { recursive: true });
  const marker = await open(markerPath, "a");
  await marker.close();
  return markerPath;
}

async function unlinkAssetAndMarker(filePath: string, markerPath: string) {
  try {
    await Bun.file(filePath).unlink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  await unlink(markerPath).catch(() => undefined);
  return true;
}

export async function removeAssetFiles(assetRoot: string, storagePaths: string[]) {
  for (const storagePath of storagePaths) {
    const filePath = assetFilePath(assetRoot, storagePath);
    if (!filePath) {
      console.warn("[assets] refused to delete an unsafe storage path", storagePath);
      continue;
    }
    let markerPath: string | null = null;
    try {
      markerPath = await queueAssetDelete(assetRoot, storagePath);
    } catch (error) {
      console.warn("[assets] failed to queue asset deletion", filePath, error);
    }
    try {
      await Bun.file(filePath).unlink();
      if (markerPath) await unlink(markerPath).catch(() => undefined);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (markerPath) await unlink(markerPath).catch(() => undefined);
      } else {
        console.warn("[assets] failed to delete asset file", filePath, error);
      }
    }
  }
}

export async function retryPendingAssetDeletions(assetRoot: string, limit = PENDING_ASSET_DELETE_BATCH_SIZE) {
  const queueRoot = join(resolve(assetRoot), PENDING_ASSET_DELETE_DIRECTORY);
  let markers: Dirent[];
  try {
    markers = await readdir(queueRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("[assets] failed to read pending deletion queue", queueRoot, error);
    return;
  }

  let processed = 0;
  const maxProcessed = Number.isSafeInteger(limit) ? Math.max(0, Math.min(limit, PENDING_ASSET_DELETE_BATCH_SIZE)) : PENDING_ASSET_DELETE_BATCH_SIZE;
  for (const marker of markers) {
    if (processed >= maxProcessed) break;
    if (!marker.isFile() || !/^[A-Za-z0-9_-]+$/u.test(marker.name)) continue;
    processed += 1;
    const storagePath = Buffer.from(marker.name, "base64url").toString("utf8");
    if (!storagePath || Buffer.from(storagePath, "utf8").toString("base64url") !== marker.name) {
      await unlink(join(queueRoot, marker.name)).catch(() => undefined);
      continue;
    }
    const filePath = assetFilePath(assetRoot, storagePath);
    const markerPath = join(queueRoot, marker.name);
    if (!filePath) {
      console.warn("[assets] removed an unsafe path from the pending deletion queue", marker.name);
      await unlink(markerPath).catch(() => undefined);
      continue;
    }
    if (!(await unlinkAssetAndMarker(filePath, markerPath))) {
      console.warn("[assets] pending asset deletion will be retried", filePath);
    }
  }
}

/** Sweep old filesystem-only uploads and recover interrupted uploads with a committed database row. */
export async function cleanupOrphanAssetFiles(database: SqliteDatabase, assetRoot: string, timestamp = now()) {
  let owners: Dirent[];
  try {
    owners = await readdir(resolve(assetRoot), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return;
  }

  const staleBefore = (timestamp - ORPHAN_ASSET_TTL_SECONDS) * 1000;
  const hasAsset = database.query("SELECT 1 AS found FROM image_assets WHERE storage_path = ? LIMIT 1");
  for (const owner of owners) {
    if (!owner.isDirectory() || !ASSET_OWNER_DIRECTORY.test(owner.name)) continue;
    const ownerPath = join(resolve(assetRoot), owner.name);
    let files: Dirent[];
    try {
      files = await readdir(ownerPath, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }

    for (const file of files) {
      if (!file.isFile()) continue;
      const temporaryMatch = TEMPORARY_ASSET_FILE_NAME.exec(file.name);
      if (!temporaryMatch && !ASSET_FILE_NAME.test(file.name)) continue;
      const filePath = join(ownerPath, file.name);
      let details: Awaited<ReturnType<typeof lstat>>;
      try {
        details = await lstat(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!details.isFile() || details.mtimeMs > staleBefore) continue;

      const storagePath = `${owner.name}/${temporaryMatch?.[1] ?? file.name}`;
      const registered = Boolean(hasAsset.get(storagePath));
      if (temporaryMatch && registered) {
        const finalPath = join(ownerPath, temporaryMatch[1]);
        if (await Bun.file(finalPath).exists()) {
          await unlink(filePath).catch((error) => {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          });
        } else {
          await rename(filePath, finalPath).catch((error) => {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          });
        }
      } else if (!registered) {
        await unlink(filePath).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
      }
    }
  }
}

export async function cleanupOrphanAssets(database: SqliteDatabase, assetRoot: string) {
  const timestamp = now();
  if (timestamp < nextOrphanAssetCleanupAt) return;
  nextOrphanAssetCleanupAt = timestamp + ORPHAN_ASSET_CLEANUP_INTERVAL_SECONDS;
  // Asset ids are UUIDs and references in Markdown are matched case-insensitively elsewhere,
  // so the orphan check must lowercase both sides or referenced images would be deleted.
  const staleAssets = all<{ id: string; storage_path: string }>(database, `
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
  if (!staleAssets.length) return;
  const deleteStaleAssets = database.transaction(() => {
    const deletedPaths: string[] = [];
    const statement = database.query(`
      DELETE FROM image_assets
      WHERE id = ?
        AND (note_id IS NULL OR NOT EXISTS (
          SELECT 1 FROM notes n
          WHERE n.id = image_assets.note_id
            AND instr(lower(n.content_markdown), '/api/assets/' || lower(image_assets.id)) > 0
        ))
    `);
    for (const asset of staleAssets) {
      if (statement.run(asset.id).changes) deletedPaths.push(asset.storage_path);
    }
    return deletedPaths;
  });
  const stalePaths = deleteStaleAssets();
  await retryPendingAssetDeletions(assetRoot);
  await removeAssetFiles(assetRoot, stalePaths);
  await cleanupOrphanAssetFiles(database, assetRoot, timestamp);
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
  let databaseRowInserted = false;
  try {
    await Bun.write(temporaryPath, bytes);
    database.query("INSERT INTO image_assets (id, user_id, storage_path, original_name, mime_type, byte_size, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, user.id, storagePath, safeOriginalName(entry.name), inspection.mimeType, bytes.byteLength, inspection.width, inspection.height, now());
    databaseRowInserted = true;
    await rename(temporaryPath, filePath);
  } catch (error) {
    await Bun.file(temporaryPath).unlink().catch(() => undefined);
    await Bun.file(filePath).unlink().catch(() => undefined);
    if (databaseRowInserted) {
      try {
        database.query("DELETE FROM image_assets WHERE id = ? AND user_id = ?").run(id, user.id);
      } catch (cleanupError) {
        console.warn("[assets] failed to roll back an interrupted upload record", id, cleanupError);
      }
    }
    throw error;
  }

  const asset = first<ImageAssetRow>(database, "SELECT id, user_id, note_id, storage_path, original_name, mime_type, byte_size, width, height, document_order, created_at FROM image_assets WHERE id = ? AND user_id = ?", id, user.id);
  return asset ? json({ asset: toImageAsset(asset) }, 201) : jsonError(500, "ASSET_STORAGE_ERROR", "图片保存失败");
}

export async function serveImageAsset(request: Request, database: SqliteDatabase, userId: string, assetId: string, assetRoot: string, cacheControl = "private, max-age=3600") {
  const asset = first<ImageAssetRow>(database, "SELECT id, user_id, note_id, storage_path, original_name, mime_type, byte_size, width, height, document_order, created_at FROM image_assets WHERE id = ? AND user_id = ?", assetId.toLowerCase(), userId);
  if (!asset) return jsonError(404, "ASSET_NOT_FOUND", "图片不存在");
  const filePath = assetFilePath(assetRoot, asset.storage_path);
  if (!filePath) return jsonError(404, "ASSET_NOT_FOUND", "图片不存在");
  const file = Bun.file(filePath);
  if (!(await file.exists())) return jsonError(404, "ASSET_NOT_FOUND", "图片不存在");
  const headers = new Headers({
    "Content-Type": asset.mime_type,
    // Use the real file size so a truncated or externally modified file cannot hang the response.
    "Content-Length": String(file.size),
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
