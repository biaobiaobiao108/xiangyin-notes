import { stat } from "node:fs/promises";
import { extname } from "node:path";
import { findCodeFenceIntervals, findInlineCodeIntervals } from "../../shared/wiki-links";
import { createZipReadableStream, type ZipStreamEntry } from "../../shared/zip";
import { all, jsonError, type RouteContext, type UserRow } from "../core";
import { assetFilePath, assetRootFromEnv } from "./assets";

type LibraryNote = {
  id: string;
  notebook_id: string;
  title: string;
  content_markdown: string;
  is_favorite: number;
  deleted_at: number | null;
  version: number;
  created_at: number;
  updated_at: number;
};
type LibraryMemo = {
  id: string;
  content_markdown: string;
  version: number;
  created_at: number;
  updated_at: number;
};
type LibraryAsset = {
  id: string;
  note_id: string | null;
  storage_path: string;
  original_name: string;
  mime_type: string;
  byte_size: number;
  created_at: number;
};

function safeName(name: string) {
  const result = Array.from(
    name
      .trim()
      .replace(/[\\/:*?"<>|\x00-\x1f]/gu, "_")
      .replace(/[. ]+$/u, ""),
  )
    .slice(0, 80)
    .join("");
  return result || "未命名笔记";
}

function portableMarkdown(markdown: string, assetNames: Map<string, string>) {
  const blocks = findCodeFenceIntervals(markdown);
  const excluded = [...blocks, ...findInlineCodeIntervals(markdown, blocks)];
  return markdown.replace(
    /(?<![\w/:.])\/api\/assets\/([0-9a-f-]{36})(?![0-9a-z-])/giu,
    (match, id: string, offset: number) => {
      if (excluded.some((range) => offset >= range.start && offset < range.end)) return match;
      const name = assetNames.get(id.toLowerCase());
      return name ? `../附件/${name}` : match;
    },
  );
}

function textEntry(name: string, content: string): ZipStreamEntry {
  return {
    name,
    stream: async function* () {
      yield new TextEncoder().encode(content);
    },
  };
}

export async function handleLibraryExport(ctx: RouteContext, user: UserRow): Promise<Response> {
  const { database } = ctx.options;
  // Read synchronously before the first await so each table describes the same database state.
  const snapshot = database.transaction(() => ({
    notebooks: all<{
      id: string;
      name: string;
      color: string;
      icon: string;
      is_system: number;
      sort_order: number;
      created_at: number;
      updated_at: number;
    }>(
      database,
      "SELECT id, name, color, icon, is_system, sort_order, created_at, updated_at FROM notebooks WHERE user_id = ? ORDER BY sort_order, id",
      user.id,
    ),
    notes: all<LibraryNote>(
      database,
      "SELECT id, notebook_id, title, content_markdown, is_favorite, deleted_at, version, created_at, updated_at FROM notes WHERE user_id = ? ORDER BY id",
      user.id,
    ),
    memos: all<LibraryMemo>(
      database,
      "SELECT id, content_markdown, version, created_at, updated_at FROM memos WHERE user_id = ? ORDER BY id",
      user.id,
    ),
    kanban: all<{
      note_id: string;
      status: string;
      sort_order: number;
      created_at: number;
      updated_at: number;
    }>(
      database,
      "SELECT note_id, status, sort_order, created_at, updated_at FROM kanban_cards WHERE user_id = ? ORDER BY note_id",
      user.id,
    ),
    assets: all<LibraryAsset>(
      database,
      "SELECT id, note_id, storage_path, original_name, mime_type, byte_size, created_at FROM image_assets WHERE user_id = ? ORDER BY id",
      user.id,
    ),
  }))();
  const root = ctx.options.assetRoot ?? assetRootFromEnv(ctx.options.environment);
  const assetNames = new Map<string, string>();
  const files: Array<{ name: string; path: string; size: number }> = [];
  try {
    for (const asset of snapshot.assets) {
      const path = assetFilePath(root, asset.storage_path);
      if (!path) throw new Error("Invalid attachment path");
      const info = await stat(path);
      if (!info.isFile()) throw new Error("Attachment is not a file");
      const extension = extname(asset.storage_path).toLowerCase();
      if (!/^\.(?:jpg|png|gif|webp)$/u.test(extension))
        throw new Error("Invalid attachment extension");
      const name = `${asset.id}${extension}`;
      assetNames.set(asset.id.toLowerCase(), name);
      files.push({ name, path, size: info.size });
    }
  } catch (error) {
    console.error("[export] 无法读取附件，已取消整库导出", error);
    return jsonError(
      500,
      "EXPORT_ASSET_UNAVAILABLE",
      "附件不可读取，无法完成整库导出，请检查服务端日志",
    );
  }
  const noteEntries = snapshot.notes.map(({ content_markdown, ...note }) => ({
    ...note,
    file: `笔记/${note.id} ${safeName(note.title)}.md`,
    markdown: portableMarkdown(content_markdown, assetNames),
  }));
  const memoEntries = snapshot.memos.map(({ content_markdown, ...memo }) => ({
    ...memo,
    file: `随记/${memo.id}.md`,
    markdown: portableMarkdown(content_markdown, assetNames),
  }));
  const metadata = JSON.stringify(
    {
      format: "xiangyin-notes-library",
      version: 1,
      exportedAt: new Date().toISOString(),
      notebooks: snapshot.notebooks,
      kanban: snapshot.kanban,
      notes: noteEntries.map(({ markdown: _markdown, ...note }) => note),
      memos: memoEntries.map(({ markdown: _markdown, ...memo }) => memo),
      assets: snapshot.assets.map(({ storage_path: _storagePath, ...asset }) => ({
        ...asset,
        file: `附件/${assetNames.get(asset.id.toLowerCase())}`,
      })),
    },
    null,
    2,
  );
  const readme =
    "象映笔记整库导出\n\n笔记和随记为 Markdown 文件，图片保存在附件目录。笔记包含回收站内容；笔记本、看板、收藏、回收站状态及时间等信息保存在 metadata.json。正文中的本地图片路径已改为相对路径，代码中的原文保持不变。Wiki 链接和外部图片链接保持原样。\n\n此压缩包用于阅读与迁移，不是完整数据库备份，也不能直接导入象映笔记。未提交到服务的草稿不包含在内。\n";
  const encoder = new TextEncoder();
  const entriesCount = noteEntries.length + memoEntries.length + files.length + 2;
  // Include room for ZIP headers and central directory; ZIP64 is not supported.
  const estimatedSize =
    files.reduce((sum, file) => sum + file.size + 1024, 0) +
    noteEntries.reduce((sum, note) => sum + encoder.encode(note.markdown).length + 1024, 0) +
    memoEntries.reduce((sum, memo) => sum + encoder.encode(memo.markdown).length + 1024, 0) +
    encoder.encode(metadata).length +
    encoder.encode(readme).length +
    4096;
  if (entriesCount >= 0xffff || estimatedSize >= 0xffffffff)
    return jsonError(413, "EXPORT_TOO_LARGE", "整库内容超过 ZIP 导出大小限制，请使用数据库备份");
  if (ctx.method === "HEAD")
    return new Response(null, { status: 200, headers: { "Cache-Control": "no-store" } });
  async function* entries(): AsyncGenerator<ZipStreamEntry> {
    yield textEntry("说明.txt", readme);
    yield textEntry("metadata.json", metadata);
    for (const note of noteEntries) yield textEntry(note.file, note.markdown);
    for (const memo of memoEntries) yield textEntry(memo.file, memo.markdown);
    for (const file of files)
      yield { name: `附件/${file.name}`, stream: () => Bun.file(file.path).stream() };
  }
  return new Response(createZipReadableStream(entries()), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="xiangyin-library-${new Date().toISOString().slice(0, 10)}.zip"`,
      "Cache-Control": "no-store",
    },
  });
}
