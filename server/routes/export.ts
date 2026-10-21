import { all, ASSET_REFERENCE_PATTERN, first, jsonError, type RouteContext, type UserRow } from "../core";
import { createZipReadableStream, type ZipStreamEntry } from "../../shared/zip";

export const EXPORT_MAX_BYTES = 512 * 1024 * 1024;

type ExportNoteRow = {
  id: string;
  title: string;
  updated_at: number;
  notebook_name: string;
  content_byte_size: number;
};

type ExportAssetRow = {
  id: string;
  storage_path: string;
  original_name: string;
  mime_type: string;
  byte_size: number;
};

const ARCHIVE_ASSET_EXTENSIONS: Record<string, string> = {
  "image/gif": ".gif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

function safeArchiveName(value: string, fallback: string, maxLength: number) {
  const name = (value.trim() || fallback).replace(/[\\/:*?"<>|\0\r\n]/g, "_").slice(0, maxLength);
  return !name || /^\.+$/u.test(name) ? fallback : name;
}

function safeArchiveAssetStem(value: string) {
  const safeName = safeArchiveName(value, "image", 64);
  const extensionStart = safeName.lastIndexOf(".");
  const stem = extensionStart > 0 ? safeName.slice(0, extensionStart) : safeName;
  return stem.slice(0, 64) || "image";
}

async function* oneChunk(bytes: Uint8Array) {
  yield bytes;
}

export async function handleExportRoute(ctx: RouteContext, user: UserRow): Promise<Response | null> {
  const { url, method, options } = ctx;
  const { database, assets } = options;

  if (method !== "GET" || url.pathname !== "/api/export") return null;
  if (!assets) return jsonError(503, "ASSET_STORAGE_UNAVAILABLE", "附件存储暂不可用");

  const notes = await all<ExportNoteRow>(
    database,
    `
    SELECT n.id, n.title, n.updated_at, b.name AS notebook_name,
      length(CAST(n.content_markdown AS BLOB)) AS content_byte_size
    FROM notes n
    JOIN notebooks b ON b.id = n.notebook_id
    WHERE n.user_id = ? AND n.deleted_at IS NULL
    ORDER BY b.sort_order, b.name, n.updated_at DESC
    `,
    user.id,
  );

  const assetRows = await all<ExportAssetRow>(
    database,
    `SELECT a.id, a.storage_path, a.original_name, a.mime_type, a.byte_size
     FROM image_assets a
     JOIN notes n ON n.id = a.note_id AND n.user_id = a.user_id AND n.deleted_at IS NULL
     WHERE a.user_id = ?`,
    user.id,
  );

  const exportAssets: Array<ExportAssetRow & { name: string }> = [];
  const assetFileNameMap = new Map<string, string>();
  for (const asset of assetRows) {
    if (!await assets.head(asset.storage_path)) continue;
    const extension = ARCHIVE_ASSET_EXTENSIONS[asset.mime_type] ?? ".bin";
    const name = `attachments/${asset.id}_${safeArchiveAssetStem(asset.original_name)}${extension}`;
    exportAssets.push({ ...asset, name });
    assetFileNameMap.set(asset.id.toLowerCase(), name);
  }

  if (exportAssets.length + notes.length > 0xffff) return jsonError(413, "EXPORT_TOO_LARGE", "导出文件包含的条目过多");
  const estimatedBytes = exportAssets.reduce((total, asset) => total + asset.byte_size, 0)
    + notes.reduce((total, note) => total + note.content_byte_size * 2, 0)
    + (exportAssets.length + notes.length) * 512
    + 22;
  if (estimatedBytes > EXPORT_MAX_BYTES) return jsonError(413, "EXPORT_TOO_LARGE", "导出内容超过 512 MiB 限制，请减少附件后重试");

  const usedPaths = new Set<string>();
  const noteEntries = notes.map((note) => {
    const notebookDir = safeArchiveName(note.notebook_name, "收件箱", 100);
    const baseTitle = safeArchiveName(note.title, "未命名笔记", 100);
    let name = `${notebookDir}/${baseTitle}.md`;
    let counter = 1;
    while (usedPaths.has(name.toLowerCase())) name = `${notebookDir}/${baseTitle} (${counter++}).md`;
    usedPaths.add(name.toLowerCase());
    return { ...note, name };
  });

  const entries = async function* (): AsyncGenerator<ZipStreamEntry> {
    for (const asset of exportAssets) {
      yield {
        name: asset.name,
        stream: async function* () {
          const object = await assets.get(asset.storage_path);
          if (!object) return;
          const reader = object.body.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              yield value;
            }
          } finally {
            reader.releaseLock();
          }
        },
      };
    }

    const encoder = new TextEncoder();
    // Local copy: the shared pattern is global, and mutating its lastIndex in a
    // generator loop is fragile if another caller iterates it concurrently.
    // Absolute HTTPS image sources are also accepted when saving notes. Consume
    // their full prefix so the exported path cannot retain a hostname or base path.
    const assetReference = new RegExp(`(?:https:\\/\\/[^\\s)<>]*?)?${ASSET_REFERENCE_PATTERN.source}`, ASSET_REFERENCE_PATTERN.flags);
    for (const note of noteEntries) {
      const row = await first<{ content_markdown: string }>(database, "SELECT content_markdown FROM notes WHERE id = ? AND user_id = ? AND deleted_at IS NULL", note.id, user.id);
      if (!row) continue;
      const content = row.content_markdown.replace(assetReference, (match, id: string) => {
        const localRel = assetFileNameMap.get(id.toLowerCase());
        const encodedPath = localRel?.split("/").map((segment) => encodeURIComponent(segment).replace(/[()]/g, (character) => character === "(" ? "%28" : "%29")).join("/");
        return encodedPath ? `../${encodedPath}` : match;
      });
      const bytes = encoder.encode(content);
      yield { name: note.name, mtime: new Date(note.updated_at * 1000), stream: () => oneChunk(bytes) };
    }
  };

  const body = createZipReadableStream(entries());
  const dateStr = new Date().toISOString().slice(0, 10);
  const headers = new Headers({
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="xiangying-notes-${dateStr}.zip"`,
    "Cache-Control": "no-store",
  });
  return new Response(body, { headers });
}
