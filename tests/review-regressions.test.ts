import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type SqliteDatabase } from "../server/db";
import { handleRequest } from "../server/index";
import { cleanupOrphanAssets, ORPHAN_ASSET_TTL_SECONDS } from "../server/routes/assets";

let database: SqliteDatabase;
let root: string;
let cookie: string;
const environment = { XIANGYING_USERNAME: "review", XIANGYING_PASSWORD: "review-password-123" };
async function request(path: string, method = "GET", body?: unknown) {
  const headers = new Headers();
  if (cookie) headers.set("Cookie", cookie);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const response = await handleRequest(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { database, environment, assetRoot: root, clientAddress: "127.0.0.1" },
  );
  return {
    response,
    body: response.headers.get("Content-Type")?.includes("application/json")
      ? ((await response.json()) as any)
      : null,
  };
}
beforeEach(async () => {
  database = await openDatabase(":memory:");
  root = join(tmpdir(), `xiangyin-review-${crypto.randomUUID()}`);
  cookie = "";
  const login = await request("/api/auth/login", "POST", {
    username: environment.XIANGYING_USERNAME,
    password: environment.XIANGYING_PASSWORD,
  });
  cookie = login.response.headers.get("Set-Cookie")!;
});
afterEach(async () => {
  database.close();
  await rm(root, { recursive: true, force: true });
});

describe("review regressions", () => {
  test("returns rewritten body even when a rename requested a summary", async () => {
    const created = await request("/api/notes", "POST", {
      title: "旧名",
      contentMarkdown: "[[旧名]]",
    });
    const renamed = await request(`/api/notes/${created.body.note.id}?response=summary`, "PATCH", {
      version: 1,
      title: "新名",
    });
    expect(renamed.body.previousTitle).toBe("旧名");
    expect(renamed.body.note.contentMarkdown).toBe("[[新名]]");
  });
  test("rejects stale notebook and card writes and duplicate card creation", async () => {
    const notebook = (
      await request("/api/notebooks", "POST", { name: "测试", color: "#123456", icon: "folder" })
    ).body.notebook;
    expect(
      (
        await request(`/api/notebooks/${notebook.id}`, "PATCH", {
          name: "甲",
          expectedUpdatedAt: notebook.updatedAt,
        })
      ).response.status,
    ).toBe(200);
    expect(
      (
        await request(`/api/notebooks/${notebook.id}`, "PATCH", {
          name: "乙",
          expectedUpdatedAt: notebook.updatedAt,
        })
      ).response.status,
    ).toBe(409);
    const note = (await request("/api/notes", "POST", { title: "卡片", kanbanStatus: "doing" }))
      .body.note;
    const card = (await request("/api/kanban?status=doing")).body.cards.find(
      (value: any) => value.noteId === note.id,
    );
    expect(card).toBeTruthy();
    expect(
      (
        await request(`/api/kanban/cards/${note.id}`, "PATCH", {
          status: "done",
          expectedUpdatedAt: card.updatedAt,
        })
      ).response.status,
    ).toBe(200);
    expect(
      (
        await request(`/api/kanban/cards/${note.id}`, "PATCH", {
          status: "inbox",
          expectedUpdatedAt: card.updatedAt,
        })
      ).response.status,
    ).toBe(409);
    expect((await request("/api/kanban/cards", "POST", { noteId: note.id })).response.status).toBe(
      409,
    );
    expect(
      (
        await request(`/api/kanban/cards/${note.id}`, "DELETE", {
          expectedUpdatedAt: card.updatedAt,
        })
      ).response.status,
    ).toBe(409);
    expect(
      (await request("/api/kanban?status=done")).body.cards.some(
        (value: any) => value.noteId === note.id,
      ),
    ).toBe(true);
  });
  test("rolls back note creation if adding its kanban card fails", async () => {
    database.exec(
      "CREATE TRIGGER fail_review_card BEFORE INSERT ON kanban_cards BEGIN SELECT RAISE(ABORT, 'test failure'); END",
    );
    const before = database.query("SELECT COUNT(*) AS count FROM notes").get();
    const savedLog = console.error;
    console.error = () => {};
    try {
      expect(
        (await request("/api/notes", "POST", { title: "原子创建", kanbanStatus: "doing" })).response
          .status,
      ).toBe(500);
      expect(database.query("SELECT COUNT(*) AS count FROM notes").get()).toEqual(before);
    } finally {
      console.error = savedLog;
    }
  });
  test("keeps detached old assets for 24 hours and preserves memo references through note deletion", async () => {
    const note = (await request("/api/notes", "POST", { title: "图片" })).body.note;
    const owner = database.query("SELECT user_id FROM notes WHERE id = ?").get(note.id) as {
      user_id: string;
    };
    const id = crypto.randomUUID();
    const path = `${owner.user_id}/${id}.png`;
    await mkdir(join(root, owner.user_id), { recursive: true });
    await Bun.write(join(root, path), "test image");
    const old = Math.floor(Date.now() / 1000) - ORPHAN_ASSET_TTL_SECONDS - 10;
    database
      .query(
        "INSERT INTO image_assets (id,user_id,storage_path,original_name,mime_type,byte_size,width,height,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(id, owner.user_id, path, "image.png", "image/png", 10, 1, 1, old);
    const image = `![图片](/api/assets/${id})`;
    const withImage = (
      await request(`/api/notes/${note.id}`, "PATCH", { version: 1, contentMarkdown: image })
    ).body.note;
    const detached = (
      await request(`/api/notes/${note.id}`, "PATCH", {
        version: withImage.version,
        contentMarkdown: "",
      })
    ).body.note;
    const timestamp = Math.floor(Date.now() / 1000);
    await cleanupOrphanAssets(database, root, timestamp);
    expect(await Bun.file(join(root, path)).exists()).toBe(true);
    const reattached = (
      await request(`/api/notes/${note.id}`, "PATCH", {
        version: detached.version,
        contentMarkdown: image,
      })
    ).body.note;
    await request("/api/memos", "POST", { contentMarkdown: image });
    const trashed = (
      await request(`/api/notes/${note.id}`, "PATCH", {
        version: reattached.version,
        deleted: true,
      })
    ).body.note;
    expect(
      (await request(`/api/notes/${note.id}`, "DELETE", { version: trashed.version })).response
        .status,
    ).toBe(200);
    await cleanupOrphanAssets(database, root, timestamp + ORPHAN_ASSET_TTL_SECONDS + 2);
    expect(await Bun.file(join(root, path)).exists()).toBe(true);
    expect((await request(`/api/assets/${id}`)).response.status).toBe(200);
  });
});
