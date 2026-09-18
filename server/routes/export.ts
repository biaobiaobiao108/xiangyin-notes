import { all, jsonError, type RouteContext, type UserRow } from "../core";
import { createZipStream, type ZipStreamEntry } from "../zip";
import { assetFilePath } from "./assets";

const ASSET_REFERENCE_PATTERN = /\/api\/assets\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?=[?#)\s]|$)/giu;
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
  byte_size: number;
};

function safeArchiveName(value: string, fallback: string, maxLength: number) {
  return (value.trim() || fallback).replace(/[\\/:*?"<>|\0\r\n]/g, "_").slice(0, maxLength) || fallback;
}

async function* oneChunk(bytes: Uint8Array) {
  yield bytes;
}

export async function handleExportRoute(ctx: RouteContext, user: UserRow, assetRoot: string): Promise<Response | null> {
  const { url, method, options } = ctx;
  const { database } = options;

  if (method !== "GET" || url.pathname !== "/api/export") return null;

  const notes = all<ExportNoteRow>(
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

  const assetRows = all<ExportAssetRow>(
    database,
    "SELECT id, storage_path, original_name, byte_size FROM image_assets WHERE user_id = ?",
    user.id,
  );

  const exportAssets: Array<ExportAssetRow & { file: Bun.BunFile; name: string }> = [];
  const assetFileNameMap = new Map<string, string>();
  for (const asset of assetRows) {
    const filePath = assetFilePath(assetRoot, asset.storage_path);
    if (!filePath) continue;
    const file = Bun.file(filePath);
    if (!(await file.exists())) continue;
    const safeName = safeArchiveName(asset.original_name, "image", 80);
    const name = `attachments/${asset.id.slice(0, 8)}_${safeName}`;
    exportAssets.push({ ...asset, file, name });
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
      yield { name: asset.name, stream: () => asset.file.stream() };
    }

    const contentStatement = database.query("SELECT content_markdown FROM notes WHERE id = ? AND user_id = ? AND deleted_at IS NULL");
    const encoder = new TextEncoder();
    for (const note of noteEntries) {
      const row = contentStatement.get(note.id, user.id) as { content_markdown: string } | null;
      if (!row) continue;
      ASSET_REFERENCE_PATTERN.lastIndex = 0;
      const content = row.content_markdown.replace(ASSET_REFERENCE_PATTERN, (_match, id: string) => {
        const localRel = assetFileNameMap.get(id.toLowerCase());
        return localRel ? `../${localRel}` : `/api/assets/${id}`;
      });
      const bytes = encoder.encode(content);
      yield { name: note.name, mtime: new Date(note.updated_at * 1000), stream: () => oneChunk(bytes) };
    }
  };

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of createZipStream(entries())) controller.enqueue(chunk);
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
  const dateStr = new Date().toISOString().slice(0, 10);
  const headers = new Headers({
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="xiangying-notes-${dateStr}.zip"`,
    "Cache-Control": "no-store",
  });
  return new Response(body, { headers });
}
