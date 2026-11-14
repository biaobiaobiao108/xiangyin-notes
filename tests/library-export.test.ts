import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../server/db";
import { ensureEnvironmentUser } from "../server/routes/auth";
import { handleExportRoute } from "../server/routes/export";
import { createNote } from "../server/routes/notes";

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
    const markdown = `![图片](${source}?w=100)\n\n\`${source}\`\n\n\`\`\`\n${source}\n\`\`\`\n\n![外部](https://elsewhere.example${source})`;
    const noteId = createNote(database, user.id, inbox.id, "重复标题", "");
    const trashId = createNote(database, user.id, inbox.id, "重复标题", "回收站正文");
    database.query("UPDATE notes SET deleted_at = 123, is_favorite = 1 WHERE id = ?").run(trashId);
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
    const zip = join(root, "library.zip");
    await Bun.write(zip, response);
    const read = async (name: string) => {
      const suffix = /[0-9a-f-]{36}|\d{4}-\d{2}\.md/u.exec(name)?.[0];
      const process = Bun.spawn(["unzip", "-p", zip, suffix ? `*${suffix}*` : name], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const value = await new Response(process.stdout).text();
      expect(await process.exited).toBe(0);
      return value;
    };
    const metadata = JSON.parse(await read("metadata.json"));
    expect(metadata.notes.some((note: { id: string }) => note.id === noteId)).toBe(true);
    expect(metadata.notes.some((note: { id: string }) => note.id === otherNoteId)).toBe(false);
    expect(
      metadata.notebooks.some((notebook: { id: string }) => notebook.id === otherNotebookId),
    ).toBe(false);
    expect(metadata.notes.find((note: { id: string }) => note.id === trashId).deleted_at).toBe(123);
    expect(metadata.timeZone).toBe("Asia/Shanghai");
    const first = metadata.memos.find((memo: { id: string }) => memo.id === memoId);
    const second = metadata.memos.find((memo: { id: string }) => memo.id === laterMemoId);
    const previous = metadata.memos.find((memo: { id: string }) => memo.id === earlierMemoId);
    expect(first.file).toBe("随记/2026-11.md");
    expect(second.file).toBe(first.file);
    expect([first.index, second.index]).toEqual([1, 2]);
    expect(previous.file).toBe("随记/2026-10.md");
    const file = metadata.notes.find((note: { id: string }) => note.id === noteId).file;
    expect(await read(file)).toBe(
      `![图片](../附件/${assetId}.png?w=100)\n\n\`${source}\`\n\n\`\`\`\n${source}\n\`\`\`\n\n![外部](https://elsewhere.example${source})`,
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
    expect(beforeCancel.checkpointed).toBeLessThan(beforeCancel.log);
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
