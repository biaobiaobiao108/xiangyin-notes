import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type SqliteDatabase } from "../server/db";
import { cleanupOrphanAssets, ORPHAN_ASSET_CLEANUP_INTERVAL_SECONDS, removeAssetFiles } from "../server/routes/assets";

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
    expect(database.query("SELECT COUNT(*) AS count FROM image_assets").get()).toEqual({ count: 0 });

    await rm(targetPath, { recursive: true });
    await Bun.write(targetPath, "retry after restart");
    const cleanupTimestamp = Math.floor(Date.now() / 1000) + ORPHAN_ASSET_CLEANUP_INTERVAL_SECONDS + 1;
    await cleanupOrphanAssets(database, assetRoot, cleanupTimestamp);

    expect(await Bun.file(targetPath).exists()).toBe(false);
    expect(await readdir(queueRoot)).toEqual([]);
  });
});
