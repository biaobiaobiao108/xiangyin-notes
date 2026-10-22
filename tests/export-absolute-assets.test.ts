import { expect, test } from "bun:test";
import { openDatabase } from "../server/test-db";
import { ensureEnvironmentUser } from "../server/routes/auth";
import { handleExportRoute } from "../server/routes/export";
import { createNote } from "../server/routes/notes";
import { MemoryR2Bucket } from "./memory-r2";

test("exports complete absolute HTTPS attachment URLs as local archive paths", async () => {
  const database = await openDatabase(":memory:");
  const assets = new MemoryR2Bucket();
  try {
    const user = await ensureEnvironmentUser(database, {
      username: "owner",
      password: "test-password",
    });
    const inbox = database
      .query("SELECT id FROM notebooks WHERE user_id = ? AND is_system = 1")
      .get(user.id) as { id: string };
    const assetId = crypto.randomUUID();
    const storagePath = `${user.id}/${assetId}.png`;
    await assets.put(storagePath, new Uint8Array([1, 2, 3]), {
      httpMetadata: { contentType: "image/png" },
    });
    database
      .query(
        "INSERT INTO image_assets (id, user_id, storage_path, original_name, mime_type, byte_size, width, height, created_at) VALUES (?, ?, ?, 'image.png', 'image/png', 3, 1, 1, ?)",
      )
      .run(assetId, user.id, storagePath, Math.floor(Date.now() / 1000));
    const sources = [
      `/api/assets/${assetId}`,
      `https://notes.example/api/assets/${assetId}`,
      `https://notes.example:8443/base/api/assets/${assetId}`,
      `https://notes.example/api/assets/${assetId}?download=1#image`,
    ];
    await createNote(
      database,
      user.id,
      inbox.id,
      "absolute assets",
      sources.map((source, index) => `![image${index}](${source})`).join("\n\n") +
        "\n\n![external](https://images.example/photo.png)",
    );
    const request = new Request("http://xiangying.test/api/export");
    const response = await handleExportRoute(
      {
        request,
        url: new URL(request.url),
        method: "GET",
        segments: ["export"],
        options: { database, assets },
      },
      user,
    );
    if (!response) throw new Error("Export route did not respond");
    expect(response.status).toBe(200);
    const archive = new TextDecoder().decode(await response.arrayBuffer());
    const localPath = `../attachments/${assetId}_image.png`;
    expect(archive).toContain(`attachments/${assetId}_image.png`);
    expect(archive.split(localPath)).toHaveLength(sources.length + 1);
    expect(archive).toContain(`![image3](${localPath}?download=1#image)`);
    expect(archive).not.toContain("https://notes.example");
    expect(archive).toContain("![external](https://images.example/photo.png)");

    // If the local file is unavailable, keep usable original URLs intact.
    await assets.delete(storagePath);
    const missingResponse = await handleExportRoute(
      {
        request,
        url: new URL(request.url),
        method: "GET",
        segments: ["export"],
        options: { database, assets },
      },
      user,
    );
    if (!missingResponse) throw new Error("Export route did not respond");
    const missingArchive = new TextDecoder().decode(await missingResponse.arrayBuffer());
    for (const source of sources) expect(missingArchive).toContain(`](${source})`);
  } finally {
    database.close();
  }
});
