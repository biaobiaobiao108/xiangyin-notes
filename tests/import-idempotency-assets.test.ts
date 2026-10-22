import { expect, test } from "bun:test";
import { openDatabase } from "../server/db";
import { ensureEnvironmentUser } from "../server/routes/auth";
import { handleImportRoute } from "../server/routes/import";

test("replays an import with attached images before validating new-note assets", async () => {
  const database = await openDatabase(":memory:");
  const environment = {
    XIANGYING_USERNAME: "owner",
    XIANGYING_PASSWORD: "test-password",
    XIANGYING_API_TOKEN: "test-import-token",
  };
  try {
    const user = await ensureEnvironmentUser(database, {
      username: environment.XIANGYING_USERNAME,
      password: environment.XIANGYING_PASSWORD,
    });
    const assetId = crypto.randomUUID();
    database
      .query(
        "INSERT INTO image_assets (id, user_id, storage_path, original_name, mime_type, byte_size, width, height, created_at) VALUES (?, ?, ?, 'image.png', 'image/png', 1, 1, 1, ?)",
      )
      .run(assetId, user.id, `${user.id}/${assetId}.png`, Math.floor(Date.now() / 1000));
    const markdown = `![image](/api/assets/${assetId})`;
    const importNote = async (body: string, key = "image-import") => {
      const request = new Request("http://xiangying.test/api/import", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${environment.XIANGYING_API_TOKEN}`,
          "Content-Type": "text/markdown",
          "Idempotency-Key": key,
        },
        body,
      });
      const response = await handleImportRoute({
        request,
        url: new URL(request.url),
        method: "POST",
        segments: ["import"],
        options: { database, environment },
      });
      if (!response) throw new Error("Import route did not respond");
      return { response, body: await response.json() };
    };

    const created = await importNote(markdown);
    expect(created.response.status).toBe(201);
    const replayed = await importNote(markdown);
    expect(replayed.response.status).toBe(200);
    expect(replayed.response.headers.get("Idempotent-Replayed")).toBe("true");
    expect(replayed.body.note.id).toBe(created.body.note.id);

    const conflict = await importNote(`${markdown}\n\nDifferent content`);
    expect(conflict.response.status).toBe(409);
    expect(conflict.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
    const reusedAsset = await importNote(markdown, "another-import");
    expect(reusedAsset.response.status).toBe(400);
    expect(reusedAsset.body.error.code).toBe("INVALID_ASSET");
    expect(database.query("SELECT note_id FROM image_assets WHERE id = ?").get(assetId)).toEqual({
      note_id: created.body.note.id,
    });
  } finally {
    database.close();
  }
});
