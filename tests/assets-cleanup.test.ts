import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type SqliteDatabase } from "../server/db";
import {
  cleanupOrphanAssets,
  detachMemoReferencedAssets,
  ORPHAN_ASSET_CLEANUP_INTERVAL_SECONDS,
  ORPHAN_ASSET_TTL_SECONDS,
  removeAssetFiles,
  waitForOrphanAssetCleanup,
} from "../server/routes/assets";
import { ensureEnvironmentUser } from "../server/routes/auth";
import { createNote } from "../server/routes/notes";

let database: SqliteDatabase;
let assetRoot: string;

beforeEach(async () => {
  database = await openDatabase(":memory:");
  assetRoot = join(tmpdir(), `xiangyin-notes-assets-${crypto.randomUUID()}`);
});

afterEach(async () => {
  database.close();
  await rm(assetRoot, { recursive: true, force: true });
});

describe("orphan asset cleanup", () => {
  test("keeps escaped Markdown attachments in notes and memos while removing unreferenced uploads", async () => {
    const user = await ensureEnvironmentUser(database, {
      username: "owner",
      password: "test-password",
    });
    const inbox = database
      .query<{ id: string }, [string]>(
        "SELECT id FROM notebooks WHERE user_id = ? AND is_system = 1",
      )
      .get(user.id)!;
    const insert = database.query(
      "INSERT INTO image_assets (id,user_id,storage_path,original_name,mime_type,byte_size,width,height,created_at) VALUES (?,?,?,'image.png','image/png',11,1,1,1)",
    );
    const addImage = async () => {
      const id = crypto.randomUUID();
      const storagePath = `${user.id}/${id}.png`;
      await Bun.write(join(assetRoot, storagePath), "image bytes");
      insert.run(id, user.id, storagePath);
      return { id, file: Bun.file(join(assetRoot, storagePath)) };
    };
    const attached = await addImage();
    const memoOnly = await addImage();
    const unused = await addImage();
    const image = (id: string) => String.raw`![图片](\/api\/assets\/${id})`;
    const noteId = createNote(database, user.id, inbox.id, "带图片的笔记", image(attached.id));
    database
      .query(
        "INSERT INTO memos (id,user_id,content_markdown,search_text,created_at,updated_at) VALUES (?,?,?,'',1,1)",
      )
      .run(crypto.randomUUID(), user.id, `${image(attached.id)}\n${image(memoOnly.id)}`);
    await cleanupOrphanAssets(database, assetRoot, ORPHAN_ASSET_TTL_SECONDS + 100);
    expect(await attached.file.exists()).toBe(true);
    expect(await memoOnly.file.exists()).toBe(true);
    expect(await unused.file.exists()).toBe(false);
    detachMemoReferencedAssets(database, user.id, [noteId]);
    expect(
      database.query("SELECT note_id FROM image_assets WHERE id = ?").get(attached.id),
    ).toEqual({
      note_id: null,
    });
  });

  test("retries pending deletion markers when the database has no stale asset rows", async () => {
    const storagePath = "blocked/retry.png";
    const targetPath = join(assetRoot, storagePath);
    await mkdir(targetPath, { recursive: true });
    await Bun.write(join(targetPath, "nested"), "keep directory non-empty");

    const warning = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await removeAssetFiles(assetRoot, [storagePath]);
    } finally {
      warning.mockRestore();
    }
    const queueRoot = join(assetRoot, ".pending-delete");
    expect((await readdir(queueRoot)).length).toBe(1);
    expect(database.query("SELECT COUNT(*) AS count FROM image_assets").get()).toEqual({
      count: 0,
    });

    await rm(targetPath, { recursive: true });
    await Bun.write(targetPath, "retry after restart");
    const cleanupTimestamp =
      Math.floor(Date.now() / 1000) + ORPHAN_ASSET_CLEANUP_INTERVAL_SECONDS + 1;
    await cleanupOrphanAssets(database, assetRoot, cleanupTimestamp);

    expect(await Bun.file(targetPath).exists()).toBe(false);
    expect(await readdir(queueRoot)).toEqual([]);
  });

  test("sweeps stale orphan files when there are no stale database rows", async () => {
    const ownerRoot = join(assetRoot, crypto.randomUUID());
    const orphanPath = join(ownerRoot, `${crypto.randomUUID()}.png`);
    await mkdir(ownerRoot, { recursive: true });
    await Bun.write(orphanPath, "orphan without a database row");
    const oldTime = new Date(Date.now() - (ORPHAN_ASSET_TTL_SECONDS + 60) * 1000);
    await utimes(orphanPath, oldTime, oldTime);

    const timestamp = Math.floor(Date.now() / 1000) + ORPHAN_ASSET_CLEANUP_INTERVAL_SECONDS * 10;
    await cleanupOrphanAssets(database, assetRoot, timestamp);

    expect(await Bun.file(orphanPath).exists()).toBe(false);
  });

  test("coalesces concurrent cleanup and exposes a promise to await before closing the database", async () => {
    const timestamp = Math.floor(Date.now() / 1000) + ORPHAN_ASSET_CLEANUP_INTERVAL_SECONDS * 20;
    const first = cleanupOrphanAssets(database, assetRoot, timestamp);
    const second = cleanupOrphanAssets(database, assetRoot, timestamp + 1);

    expect(second).toBe(first);
    await waitForOrphanAssetCleanup(database);
    expect(database.query("SELECT COUNT(*) AS count FROM image_assets").get()).toEqual({
      count: 0,
    });
  });
});
