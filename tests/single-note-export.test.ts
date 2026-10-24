import { expect, test } from "bun:test";
import { openDatabase } from "../server/db";
import { ensureEnvironmentUser } from "../server/routes/auth";
import { handleExportRoute } from "../server/routes/export";
import { createNote } from "../server/routes/notes";

test("exports one note without changing its Markdown links", async () => {
  const database = await openDatabase(":memory:");
  try {
    const user = await ensureEnvironmentUser(database, {
      username: "owner",
      password: "test-password",
    });
    const inbox = database
      .query("SELECT id FROM notebooks WHERE user_id = ? AND is_system = 1")
      .get(user.id) as { id: string };
    const markdown = [
      "/api/assets/first-asset",
      "https://notes.example/api/assets/second-asset",
      "https://notes.example:8443/base/api/assets/third-asset",
      "https://notes.example/api/assets/fourth-asset?download=1#image",
      "https://images.example/photo.png",
    ]
      .map((source, index) => `![image${index}](${source})`)
      .join("\n\n");
    const noteId = createNote(database, user.id, inbox.id, "Markdown export", markdown);
    const request = new Request(`http://xiangying.test/api/notes/${noteId}/export`);
    const response = handleExportRoute(
      {
        request,
        url: new URL(request.url),
        method: "GET",
        segments: ["notes", noteId, "export"],
        options: { database },
      },
      user,
    );

    if (!response) throw new Error("Export route did not respond");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(markdown);
  } finally {
    database.close();
  }
});
