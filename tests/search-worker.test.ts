import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../server/db";
import { createSearchExecutor } from "../server/search-executor";
import { handleRequest } from "../server/index";
import { ensureEnvironmentUser } from "../server/routes/auth";
import { createNote } from "../server/routes/notes";

test("file-backed searches run through the worker with short and cased terms", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xiangying-search-worker-"));
  const databasePath = join(directory, "notes.sqlite");
  const database = await openDatabase(databasePath);
  const executor = createSearchExecutor(database);
  const environment = {
    XIANGYING_USERNAME: "worker-search-owner",
    XIANGYING_PASSWORD: "worker-search-password",
  };

  try {
    const user = await ensureEnvironmentUser(database, {
      username: environment.XIANGYING_USERNAME,
      password: environment.XIANGYING_PASSWORD,
    });
    const inbox = database
      .query("SELECT id FROM notebooks WHERE user_id = ? AND is_system = 1")
      .get(user.id) as { id: string };
    const cjkNote = createNote(database, user.id, inbox.id, "项目笔记", "正文里的项目关键字");
    createNote(database, user.id, inbox.id, "École", "Accent body");

    const login = await handleRequest(
      new Request("http://worker-search.test/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          username: environment.XIANGYING_USERNAME,
          password: environment.XIANGYING_PASSWORD,
        }),
      }),
      { database, environment },
    );
    const cookie = login.headers.get("Set-Cookie")!.split(";", 1)[0]!;

    const search = async (query: string) => {
      const response = await handleRequest(
        new Request(
          `http://worker-search.test/api/notes?view=all&query=${encodeURIComponent(query)}&includeMatch=1`,
          { headers: { Cookie: cookie } },
        ),
        { database, environment, searchExecutor: executor },
      );
      expect(response.status).toBe(200);
      return response.json() as Promise<{
        total: number;
        notes: Array<{ id: string; match?: { field: string; snippet?: string } }>;
      }>;
    };

    const short = await search("项目");
    expect(short.total).toBe(1);
    expect(short.notes[0]?.id).toBe(cjkNote);
    expect(short.notes[0]?.match?.field).toBe("title");

    const cased = await search("É");
    expect(cased.total).toBe(1);
    expect(cased.notes[0]?.match?.field).toBe("title");
  } finally {
    await executor?.close();
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
