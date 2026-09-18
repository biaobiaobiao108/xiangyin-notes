import { all, type RouteContext, type UserRow } from "../core";
import { createZip, type ZipEntry } from "../zip";
import { assetFilePath } from "./assets";

const ASSET_REFERENCE_PATTERN = /\/api\/assets\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?=[?#)\s]|$)/giu;

export async function handleExportRoute(ctx: RouteContext, user: UserRow, assetRoot: string): Promise<Response | null> {
  const { url, method, options } = ctx;
  const { database } = options;

  if (method !== "GET" || url.pathname !== "/api/export") return null;

  const notes = all<{ id: string; title: string; content_markdown: string; updated_at: number; notebook_name: string }>(
    database,
    `
    SELECT n.id, n.title, n.content_markdown, n.updated_at, b.name AS notebook_name
    FROM notes n
    JOIN notebooks b ON b.id = n.notebook_id
    WHERE n.user_id = ? AND n.deleted_at IS NULL
    ORDER BY b.sort_order, b.name, n.updated_at DESC
    `,
    user.id,
  );

  const assetRows = all<{ id: string; storage_path: string; original_name: string }>(
    database,
    "SELECT id, storage_path, original_name FROM image_assets WHERE user_id = ?",
    user.id,
  );

  const entries: ZipEntry[] = [];
  const usedPaths = new Set<string>();

  const assetFileNameMap = new Map<string, string>();
  for (const asset of assetRows) {
    const filePath = assetFilePath(assetRoot, asset.storage_path);
    if (!filePath) continue;
    const file = Bun.file(filePath);
    if (!(await file.exists())) continue;
    const safeName = asset.original_name.replace(/[\\/:*?"<>|]/g, "_").slice(0, 80) || "image";
    const attachmentRelPath = `attachments/${asset.id.slice(0, 8)}_${safeName}`;
    assetFileNameMap.set(asset.id.toLowerCase(), attachmentRelPath);
    entries.push({
      name: attachmentRelPath,
      data: new Uint8Array(await file.arrayBuffer()),
    });
  }

  for (const note of notes) {
    const notebookDir = (note.notebook_name.trim() || "收件箱").replace(/[\\/:*?"<>|]/g, "_");
    const baseTitle = (note.title.trim() || "未命名笔记").replace(/[\\/:*?"<>|]/g, "_").slice(0, 100);
    let filename = `${notebookDir}/${baseTitle}.md`;
    let counter = 1;
    while (usedPaths.has(filename.toLowerCase())) {
      filename = `${notebookDir}/${baseTitle} (${counter}).md`;
      counter += 1;
    }
    usedPaths.add(filename.toLowerCase());

    let content = note.content_markdown;
    ASSET_REFERENCE_PATTERN.lastIndex = 0;
    content = content.replace(ASSET_REFERENCE_PATTERN, (_match, id: string) => {
      const localRel = assetFileNameMap.get(id.toLowerCase());
      return localRel ? `../${localRel}` : `/api/assets/${id}`;
    });

    entries.push({
      name: filename,
      data: content,
      mtime: new Date(note.updated_at * 1000),
    });
  }

  const zipBytes = createZip(entries);
  const dateStr = new Date().toISOString().slice(0, 10);
  const headers = new Headers({
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="xiangying-notes-${dateStr}.zip"`,
    "Cache-Control": "no-store",
  });
  return new Response(zipBytes.buffer as ArrayBuffer, { headers });
}
