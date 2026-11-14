import { stat } from "node:fs/promises";
import { extname } from "node:path";
import { Database } from "bun:sqlite";
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
  const characters = Array.from(name.trim().replace(/[\\/:*?"<>|\x00-\x1f]/gu, "_")).slice(0, 80);
  const encoder = new TextEncoder();
  let result = "";
  let bytes = 0;
  for (const character of characters) {
    const size = encoder.encode(character).length;
    if (bytes + size > 180) break;
    result += character;
    bytes += size;
  }
  result = result.replace(/[. ]+$/u, "");
  return result || "未命名笔记";
}

function notebookFolders(notebooks: Array<{ id: string; name: string }>) {
  const used = new Set<string>();
  return new Map(
    notebooks.map(({ id, name }) => {
      let base = safeName(name).replace(/[. ]+$/u, "") || "未命名笔记本";
      if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(base)) base = `_${base}`;
      let folder = base;
      let suffix = 2;
      while (used.has(folder.normalize("NFC").toLowerCase())) folder = `${base} (${suffix++})`;
      used.add(folder.normalize("NFC").toLowerCase());
      return [id, `笔记/${folder}`] as const;
    }),
  );
}

function portableMarkdown(markdown: string, assetNames: Map<string, string>, assetPrefix: string) {
  if (!assetNames.size || !markdown.toLowerCase().includes("/api/assets/")) return markdown;
  const blocks = findCodeFenceIntervals(markdown);
  const excluded = [...blocks, ...findInlineCodeIntervals(markdown, blocks)];
  return markdown.replace(
    /(?<![\w/:.])\/api\/assets\/([0-9a-f-]{36})(?![0-9a-z-])/giu,
    (match, id: string, offset: number) => {
      if (excluded.some((range) => offset >= range.start && offset < range.end)) return match;
      const name = assetNames.get(id.toLowerCase());
      return name ? `${assetPrefix}/${name}` : match;
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
  const timeZone = ctx.url.searchParams.get("timeZone") || "UTC";
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    return jsonError(400, "INVALID_TIME_ZONE", "导出时区无效");
  }
  const originalDatabase = ctx.options.database;
  const useSnapshotConnection = ctx.method !== "HEAD" && originalDatabase.filename !== ":memory:";
  const database = useSnapshotConnection
    ? new Database(originalDatabase.filename, { readonly: true })
    : originalDatabase;
  let snapshotClosed = false;
  const closeSnapshot = () => {
    if (!useSnapshotConnection || snapshotClosed) return;
    snapshotClosed = true;
    database.close();
  };
  let streamOwnsSnapshot = false;
  try {
    if (useSnapshotConnection) database.exec("BEGIN");
    const deferContent = ctx.method === "HEAD" || useSnapshotConnection;
    // Read synchronously before the first await so each table describes the same database state.
    const readSnapshot = () => ({
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
        `SELECT id, notebook_id, title, ${deferContent ? "''" : "content_markdown"} AS content_markdown, is_favorite, deleted_at, version, created_at, updated_at FROM notes WHERE user_id = ? ORDER BY id`,
        user.id,
      ),
      memos: all<LibraryMemo>(
        database,
        `SELECT id, ${deferContent ? "''" : "content_markdown"} AS content_markdown, version, created_at, updated_at FROM memos WHERE user_id = ? ORDER BY created_at, id`,
        user.id,
      ),
      textBytes: database
        .query(
          `SELECT
      COALESCE((SELECT SUM(length(CAST(content_markdown AS BLOB))) FROM notes WHERE user_id = ?), 0) +
      COALESCE((SELECT SUM(length(CAST(content_markdown AS BLOB))) FROM memos WHERE user_id = ?), 0) AS total`,
        )
        .get(user.id, user.id) as { total: number },
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
    });
    const snapshot = useSnapshotConnection ? readSnapshot() : database.transaction(readSnapshot)();
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
    const folders = notebookFolders(snapshot.notebooks);
    if (snapshot.notes.some((note) => !folders.has(note.notebook_id)))
      return jsonError(500, "EXPORT_NOTEBOOK_MISSING", "笔记所属笔记本不可用，无法完成整库导出");
    const noteEntries = snapshot.notes.map(({ content_markdown: _content, ...note }) => ({
      ...note,
      file: `${folders.get(note.notebook_id)}/${note.id} ${safeName(note.title)}.md`,
    }));
    const memoMonths = new Map<string, Array<{ id: string; time: string; content: string }>>();
    const memoMetadata = snapshot.memos.map(({ content_markdown, ...memo }) => {
      const parts = Object.fromEntries(
        formatter.formatToParts(memo.created_at).map(({ type, value }) => [type, value]),
      );
      const month = `${parts.year}-${parts.month}`;
      const time = `${month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
      const items = memoMonths.get(month) ?? [];
      items.push({ id: memo.id, time, content: content_markdown });
      memoMonths.set(month, items);
      return { ...memo, file: `随记/${month}.md`, index: items.length };
    });
    for (const memo of snapshot.memos) memo.content_markdown = "";
    const metadata = JSON.stringify(
      {
        format: "xiangyin-notes-library",
        version: 2,
        exportedAt: new Date().toISOString(),
        timeZone,
        notebooks: snapshot.notebooks.map((notebook) => ({
          ...notebook,
          folder: folders.get(notebook.id),
        })),
        kanban: snapshot.kanban,
        notes: noteEntries,
        memos: memoMetadata,
        assets: snapshot.assets.map(({ storage_path: _storagePath, ...asset }) => ({
          ...asset,
          file: `附件/${assetNames.get(asset.id.toLowerCase())}`,
        })),
      },
      null,
      2,
    );
    const readme = `象映笔记整库导出\n\n笔记按笔记本分别存放，每篇为独立 Markdown 文件；回收站笔记也在所属笔记本目录中。随记按创建时间在 ${timeZone} 时区归入每月一个 Markdown 文件，同一文件中按时间排列。每条随记的原始时间和文件内顺序保存在 metadata.json。图片保存在附件目录。笔记本、看板、收藏、回收站状态及时间等信息保存在 metadata.json。正文中的本地图片路径已改为相对路径，代码中的原文保持不变。Wiki 链接和外部图片链接保持原样。\n\n此压缩包用于阅读与迁移，不是完整数据库备份，也不能直接导入象映笔记。未提交到服务的草稿不包含在内。\n`;
    const encoder = new TextEncoder();
    const entriesCount = folders.size + noteEntries.length + memoMonths.size + files.length + 2;
    // Allow for longer local image paths, monthly headings, ZIP headers and the central directory.
    const estimatedSize =
      files.reduce((sum, file) => sum + file.size + 1024, 0) +
      Math.ceil(snapshot.textBytes.total * 1.15) +
      [...folders.values()].reduce(
        (sum, path) => sum + 2 * encoder.encode(`${path}/`).length + 128,
        0,
      ) +
      noteEntries.reduce((sum, note) => sum + 2 * encoder.encode(note.file).length + 128, 0) +
      snapshot.memos.length * 128 +
      memoMonths.size * 1024 +
      encoder.encode(metadata).length +
      encoder.encode(readme).length +
      4096;
    if (entriesCount >= 0xffff || estimatedSize >= 0xffffffff)
      return jsonError(413, "EXPORT_TOO_LARGE", "整库内容超过 ZIP 导出大小限制，请使用数据库备份");
    if (ctx.method === "HEAD")
      return new Response(null, { status: 200, headers: { "Cache-Control": "no-store" } });
    const noteBody = database.query(
      "SELECT content_markdown FROM notes WHERE id = ? AND user_id = ?",
    );
    const memoBody = database.query(
      "SELECT content_markdown FROM memos WHERE id = ? AND user_id = ?",
    );
    async function* entries(): AsyncGenerator<ZipStreamEntry> {
      yield textEntry("说明.txt", readme);
      yield textEntry("metadata.json", metadata);
      for (const folder of folders.values()) yield textEntry(`${folder}/`, "");
      for (let index = 0; index < noteEntries.length; index++) {
        const note = snapshot.notes[index]!;
        const body = useSnapshotConnection
          ? (noteBody.get(note.id, user.id) as { content_markdown: string }).content_markdown
          : note.content_markdown;
        const content = portableMarkdown(body, assetNames, "../../附件");
        note.content_markdown = "";
        yield textEntry(noteEntries[index]!.file, content);
      }
      for (const [month, items] of memoMonths) {
        yield {
          name: `随记/${month}.md`,
          stream: async function* () {
            yield encoder.encode(`# ${month} 随记\n\n`);
            for (let index = 0; index < items.length; index++) {
              const item = items[index]!;
              const body = useSnapshotConnection
                ? (memoBody.get(item.id, user.id) as { content_markdown: string }).content_markdown
                : item.content;
              yield encoder.encode(
                `${index ? "\n---\n\n" : ""}## ${item.time}\n\n${portableMarkdown(body, assetNames, "../附件")}\n`,
              );
              item.content = "";
            }
          },
        };
      }
      for (const file of files)
        yield { name: `附件/${file.name}`, stream: () => Bun.file(file.path).stream() };
    }
    const reader = createZipReadableStream(entries()).getReader();
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (chunk.done) {
              closeSnapshot();
              controller.close();
            } else controller.enqueue(chunk.value);
          } catch (error) {
            closeSnapshot();
            controller.error(error);
          }
        },
        async cancel(reason) {
          try {
            await reader.cancel(reason);
          } finally {
            closeSnapshot();
          }
        },
      },
      { highWaterMark: 0 },
    );
    const response = new Response(body, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="xiangyin-library-${new Date().toISOString().slice(0, 10)}.zip"`,
        "Cache-Control": "no-store",
      },
    });
    streamOwnsSnapshot = true;
    return response;
  } finally {
    if (!streamOwnsSnapshot) closeSnapshot();
  }
}
