import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase } from "../server/test-db";
import type { TestSqliteDatabase } from "../server/test-db";
import { cleanupOrphanAssets, ORPHAN_ASSET_CLEANUP_INTERVAL_SECONDS, removeAssetFiles } from "../server/routes/assets";
import { MemoryR2Bucket } from "./memory-r2";

let database: TestSqliteDatabase;
let bucket: MemoryR2Bucket;

beforeEach(async () => {
  database = await openDatabase(":memory:");
  bucket = new MemoryR2Bucket();
});

afterEach(() => database.close());

describe("R2 asset cleanup", () => {
  test("deletes object keys in batches", async () => {
    await bucket.put("owner/old.png", new Uint8Array([1]));
    await removeAssetFiles(bucket, ["owner/old.png"]);
    expect(bucket.objects.has("owner/old.png")).toBe(false);
  });

  test("removes old unregistered UUID assets from R2", async () => {
    const now = Math.floor(Date.now() / 1000) + ORPHAN_ASSET_CLEANUP_INTERVAL_SECONDS + 1;
    const key = `${crypto.randomUUID()}/${crypto.randomUUID()}.png`;
    await bucket.put(key, new Uint8Array([1]));
    bucket.objects.get(key)!.uploaded = new Date((now - 25 * 60 * 60) * 1000);
    await cleanupOrphanAssets(database, bucket, now);
    expect(bucket.objects.has(key)).toBe(false);
  });
});
