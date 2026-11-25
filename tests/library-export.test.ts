import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { inflateRawSync } from "node:zlib";
import { openDatabase } from "../server/db";
import { ensureEnvironmentUser } from "../server/routes/auth";
import { handleExportRoute } from "../server/routes/export";
import { createNote } from "../server/routes/notes";
import { removeAssetFiles, retryPendingAssetDeletions } from "../server/routes/assets";

function readZipEntries(archive: Uint8Array) {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  let endOfCentralDirectory = -1;
  const earliestOffset = Math.max(0, archive.byteLength - 22 - 0xffff);
  for (let offset = archive.byteLength - 22; offset >= earliestOffset; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      endOfCentralDirectory = offset;
      break;
    }
  }
  if (endOfCentralDirectory < 0) throw new Error("ZIP end of central directory not found");

  const entryCount = view.getUint16(endOfCentralDirectory + 10, true);
  let cursor = view.getUint32(endOfCentralDirectory + 16, true);
  const entries = new Map<string, Uint8Array>();
  for (let index = 0; index < entryCount; index += 1) {
    if (view.getUint32(cursor, true) !== 0x02014b50)
      throw new Error("Invalid ZIP central directory entry");
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = new TextDecoder().decode(archive.slice(cursor + 46, cursor + 46 + nameLength));

    if (view.getUint32(localOffset, true) !== 0x04034b50)
      throw new Error("Invalid ZIP local file header");
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = archive.slice(dataOffset, dataOffset + compressedSize);
    const contents =
      method === 0
        ? compressed
        : method === 8
          ? new Uint8Array(inflateRawSync(compressed))
          : (() => {
              throw new Error(`Unsupported ZIP compression method ${method}`);
            })();
    entries.set(name, contents);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

test("export retains attachments deleted while its stream is active", async () => {
  const root = await mkdtemp(join(tmpdir(), "xiangyin-export-retain-"));
  const database = await openDatabase(join(root, "library.sqlite"));
  try {
    const user = await ensureEnvironmentUser(database, {
      username: "owner",
      password: "test-password",
    });
    const inbox = database
      .query("SELECT id FROM notebooks WHERE user_id = ? AND is_system = 1")
      .get(user.id) as { id: string };
    const noteId = createNote(database, user.id, inbox.id, "测试", "");
    const assetId = crypto.randomUUID();
    const storagePath = `${user.id}/${assetId}.png`;
    await mkdir(join(root, user.id));
    await Bun.write(join(root, storagePath), "image bytes");
    database
      .query(
        "INSERT INTO image_assets (id,user_id,note_id,storage_path,original_name,mime_type,byte_size,width,height,created_at) VALUES (?,?,?,?,?,'image/png',11,1,1,1)",
      )
      .run(assetId, user.id, noteId, storagePath, "image.png");
    const request = new Request("http://localhost/api/export/library");
    const response = await handleExportRoute(
      {
        request,
        url: new URL(request.url),
        method: "GET",
        segments: ["export", "library"],
        options: { database, assetRoot: root },
      },
      user,
    );
    if (!response) throw new Error("missing response");
    await removeAssetFiles(root, [storagePath]);
    expect(await Bun.file(join(root, storagePath)).exists()).toBe(true);
    const entries = readZipEntries(new Uint8Array(await response.arrayBuffer()));
    expect(new TextDecoder().decode(entries.get(`附件/${assetId}.png`))).toBe("image bytes");
    await retryPendingAssetDeletions(root);
    expect(await Bun.file(join(root, storagePath)).exists()).toBe(false);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("library export includes owned notes, trash, memos, attachments and metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "xiangyin-export-test-"));
  const database = await openDatabase(join(root, "library.sqlite"));
  try {
    const user = await ensureEnvironmentUser(database, {
      username: "owner",
      password: "test-password",
    });
    const inbox = database
      .query("SELECT id FROM notebooks WHERE user_id = ? AND is_system = 1")
      .get(user.id) as { id: string };
    const otherUserId = crypto.randomUUID();
    const otherNotebookId = crypto.randomUUID();
    database
      .query(
        "INSERT INTO users (id, username, password_hash, password_salt, created_at) VALUES (?, 'other', 'hash', 'salt', 1)",
      )
      .run(otherUserId);
    database
      .query(
        "INSERT INTO notebooks (id, user_id, name, created_at, updated_at) VALUES (?, ?, '其他用户', 1, 1)",
      )
      .run(otherNotebookId, otherUserId);
    const otherNoteId = createNote(
      database,
      otherUserId,
      otherNotebookId,
      "私有笔记",
      "其他用户的正文",
    );
    const assetId = crypto.randomUUID();
    const source = `/api/assets/${assetId}`;
    const unchanged = `路径 ${source}\n\n[${source}](https://elsewhere.example/)\n\n\`${source}\`\n\n\`\`\`\n${source}\n\`\`\`\n\n![外部](https://elsewhere.example${source})`;
    const markdown = `![图片](${source}?w=100)\n\n${unchanged}\n\n[引用图片][图片引用]\n\n[图片引用]: <${source}>`;
    const noteId = createNote(database, user.id, inbox.id, "重复标题", "");
    const trashId = createNote(database, user.id, inbox.id, "重复标题", "回收站正文");
    database.query("UPDATE notes SET deleted_at = 123, is_favorite = 1 WHERE id = ?").run(trashId);
    const notebookA = crypto.randomUUID();
    const notebookB = crypto.randomUUID();
    const emptyNotebook = crypto.randomUUID();
    const longNotebook = crypto.randomUUID();
    const insertNotebook = database.query(
      "INSERT INTO notebooks (id, user_id, name, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)",
    );
    insertNotebook.run(notebookA, user.id, "项目/甲", 1);
    insertNotebook.run(notebookB, user.id, "项目:甲", 2);
    insertNotebook.run(emptyNotebook, user.id, "CON", 3);
    insertNotebook.run(longNotebook, user.id, "😀".repeat(80), 4);
    const noteA = createNote(database, user.id, notebookA, "项目笔记", "甲项目正文");
    const noteB = createNote(database, user.id, notebookB, "项目笔记", "乙项目正文");
    const longNote = createNote(database, user.id, longNotebook, "😀".repeat(80), "长文件名正文");
    const memoId = crypto.randomUUID();
    const laterMemoId = crypto.randomUUID();
    const earlierMemoId = crypto.randomUUID();
    const insertMemo = database.query(
      "INSERT INTO memos (id,user_id,content_markdown,search_text,version,created_at,updated_at) VALUES (?,?,?,?,1,?,?)",
    );
    const boundary = Date.parse("2026-10-31T16:30:00Z");
    const later = Date.parse("2026-11-15T02:00:00Z");
    const earlier = Date.parse("2026-10-20T02:00:00Z");
    insertMemo.run(memoId, user.id, "随记正文", "随记正文", boundary, boundary);
    insertMemo.run(laterMemoId, user.id, "另一条随记", "另一条随记", later, later);
    insertMemo.run(earlierMemoId, user.id, "上个月", "上个月", earlier, earlier);
    await mkdir(join(root, user.id));
    const storagePath = `${user.id}/${assetId}.png`;
    await Bun.write(join(root, storagePath), new Uint8Array([1, 2, 3]));
    database
      .query(
        "INSERT INTO image_assets (id,user_id,note_id,storage_path,original_name,mime_type,byte_size,width,height,created_at) VALUES (?,?,?,?,?,'image/png',3,1,1,1)",
      )
      .run(assetId, user.id, noteId, storagePath, "原图.png");
    database.query("UPDATE notes SET content_markdown = ? WHERE id = ?").run(markdown, noteId);
    const request = new Request("http://localhost/api/export/library?timeZone=Asia%2FShanghai");
    const ctx = {
      request,
      url: new URL(request.url),
      method: "GET",
      segments: ["export", "library"],
      options: { database, assetRoot: root },
    };
    const response = await handleExportRoute(ctx, user);
    if (!response) throw new Error("missing export response");
    expect(response.status).toBe(200);
    database.query("UPDATE notes SET content_markdown = 'changed later' WHERE id = ?").run(noteId);
    database.query("UPDATE memos SET content_markdown = 'changed later' WHERE id = ?").run(memoId);
    const whileStreaming = database
      .query<{ log: number; checkpointed: number }, []>("PRAGMA wal_checkpoint(PASSIVE)")
      .get()!;
    expect(whileStreaming.log).toBeGreaterThan(0);
    expect(whileStreaming.checkpointed).toBe(whileStreaming.log);
    const zip = join(root, "library.zip");
    await Bun.write(zip, response);
    const entries = readZipEntries(new Uint8Array(await Bun.file(zip).arrayBuffer()));
    const read = async (name: string) => {
      const contents = entries.get(name);
      if (!contents) throw new Error(`Missing ZIP entry: ${name}`);
      return new TextDecoder().decode(contents);
    };
    const metadata = JSON.parse(await read("metadata.json"));
    expect(metadata.notes.some((note: { id: string }) => note.id === noteId)).toBe(true);
    expect(metadata.notes.some((note: { id: string }) => note.id === otherNoteId)).toBe(false);
    expect(
      metadata.notebooks.some((notebook: { id: string }) => notebook.id === otherNotebookId),
    ).toBe(false);
    expect(metadata.notes.find((note: { id: string }) => note.id === trashId).deleted_at).toBe(123);
    const folderFor = (id: string) =>
      metadata.notebooks.find((item: { id: string }) => item.id === id).folder;
    const noteFor = (id: string) => metadata.notes.find((item: { id: string }) => item.id === id);
    expect(folderFor(inbox.id)).toBe("笔记/收件箱");
    expect(noteFor(noteId).file.startsWith(`${folderFor(inbox.id)}/`)).toBe(true);
    expect(noteFor(trashId).file.startsWith(`${folderFor(inbox.id)}/`)).toBe(true);
    expect(folderFor(notebookA)).toBe("笔记/项目_甲");
    expect(folderFor(notebookB)).toBe("笔记/项目_甲 (2)");
    expect(folderFor(emptyNotebook)).toBe("笔记/_CON");
    expect(noteFor(noteA).file.startsWith(`${folderFor(notebookA)}/`)).toBe(true);
    expect(noteFor(noteB).file.startsWith(`${folderFor(notebookB)}/`)).toBe(true);
    expect(await read(noteFor(noteA).file)).toBe("甲项目正文");
    expect(await read(noteFor(noteB).file)).toBe("乙项目正文");
    expect(await read(noteFor(longNote).file)).toBe("长文件名正文");
    for (const component of noteFor(longNote).file.split("/"))
      expect(new TextEncoder().encode(component).length).toBeLessThanOrEqual(255);
    expect(
      [...entries.keys()].some((name) => name.startsWith(`${folderFor(emptyNotebook)}/`)),
    ).toBe(true);
    expect(metadata.timeZone).toBe("Asia/Shanghai");
    const first = metadata.memos.find((memo: { id: string }) => memo.id === memoId);
    const second = metadata.memos.find((memo: { id: string }) => memo.id === laterMemoId);
    const previous = metadata.memos.find((memo: { id: string }) => memo.id === earlierMemoId);
    expect(first.file).toBe("随记/2026-11.md");
    expect(second.file).toBe(first.file);
    expect([first.index, second.index]).toEqual([1, 2]);
    expect(previous.file).toBe("随记/2026-10.md");
    const file = metadata.notes.find((note: { id: string }) => note.id === noteId).file;
    expect(posix.normalize(posix.join(posix.dirname(file), `../../附件/${assetId}.png`))).toBe(
      metadata.assets[0].file,
    );
    expect(await read(file)).toBe(
      `![图片](../../附件/${assetId}.png?w=100)\n\n${unchanged}\n\n[引用图片][图片引用]\n\n[图片引用]: <../../附件/${assetId}.png>`,
    );
    expect(await read(first.file)).toBe(
      "# 2026-11 随记\n\n## 2026-11-01 00:30:00\n\n随记正文\n\n---\n\n## 2026-11-15 10:00:00\n\n另一条随记\n",
    );
    expect(await read(previous.file)).toContain("上个月");
    expect(await read(metadata.assets[0].file)).toBe("\u0001\u0002\u0003");
    const cancelled = await handleExportRoute(ctx, user);
    if (!cancelled?.body) throw new Error("missing export stream");
    database.query("UPDATE notes SET content_markdown = 'after snapshot' WHERE id = ?").run(noteId);
    const beforeCancel = database.query("PRAGMA wal_checkpoint(PASSIVE)").get() as {
      log: number;
      checkpointed: number;
    };
    expect(beforeCancel.checkpointed).toBe(beforeCancel.log);
    await cancelled.body.cancel();
    const afterCancel = database.query("PRAGMA wal_checkpoint(PASSIVE)").get() as {
      log: number;
      checkpointed: number;
    };
    expect(afterCancel.checkpointed).toBe(afterCancel.log);
    await rm(join(root, storagePath));
    const failure = await handleExportRoute({ ...ctx, method: "HEAD" }, user);
    expect(failure?.status).toBe(500);
    const badUrl = new URL("http://localhost/api/export/library?timeZone=invalid");
    const badTimeZone = await handleExportRoute({ ...ctx, url: badUrl }, user);
    expect(badTimeZone?.status).toBe(400);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
