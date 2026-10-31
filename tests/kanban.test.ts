import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type SqliteDatabase } from "../server/db";
import { handleRequest } from "../server/index";

let database: SqliteDatabase;
let assetRoot: string;
const environment: Record<string, string | undefined> = {
  XIANGYING_USERNAME: "owner",
  XIANGYING_PASSWORD: "a long passphrase 1234",
};

beforeEach(async () => {
  database = await openDatabase(":memory:");
  assetRoot = join(tmpdir(), `xiangying-kanban-assets-${crypto.randomUUID()}`);
});

afterEach(async () => {
  database.close();
  await rm(assetRoot, { recursive: true, force: true });
});

async function api(path: string, init: RequestInit = {}, cookie?: string) {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("Cookie", cookie);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return handleRequest(new Request(`http://localhost${path}`, { ...init, headers }), {
    database,
    environment,
    assetRoot,
    clientAddress: "127.0.0.1",
  });
}

async function login() {
  const response = await api("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({
      username: "owner",
      password: "a long passphrase 1234",
    }),
  });
  const cookie = response.headers.get("Set-Cookie");
  expect(cookie).toBeTruthy();
  return cookie!;
}

describe("Kanban API", () => {
  test("full kanban lifecycle: add card, move across columns, archive, unarchive, remove", async () => {
    const cookie = await login();

    // 1. Create a notebook and two notes
    const createNbRes = await api(
      "/api/notebooks",
      {
        method: "POST",
        body: JSON.stringify({ name: "自媒体选题", color: "#2d6a4f", icon: "folder" }),
      },
      cookie,
    );
    const { notebook } = (await createNbRes.json()) as { notebook: { id: string } };

    const note1Res = await api(
      "/api/notes",
      {
        method: "POST",
        body: JSON.stringify({
          notebookId: notebook.id,
          title: "选题 A：AI 时代工作流",
          contentMarkdown: "核心观点：简单实用。",
        }),
      },
      cookie,
    );
    const { note: note1 } = (await note1Res.json()) as { note: { id: string } };

    const note2Res = await api(
      "/api/notes",
      {
        method: "POST",
        body: JSON.stringify({
          notebookId: notebook.id,
          title: "选题 B：视频脚本结构拆解",
          contentMarkdown: "起承转合。",
        }),
      },
      cookie,
    );
    const { note: note2 } = (await note2Res.json()) as { note: { id: string } };

    // 2. Add note1 to kanban (defaults to 'inbox')
    const add1Res = await api(
      "/api/kanban/cards",
      {
        method: "POST",
        body: JSON.stringify({ noteId: note1.id }),
      },
      cookie,
    );
    expect(add1Res.status).toBe(201);
    const { card: card1 } = (await add1Res.json()) as {
      card: { noteId: string; status: string; sortOrder: number };
    };
    expect(card1.noteId).toBe(note1.id);
    expect(card1.status).toBe("inbox");

    // 3. Add note2 directly to 'doing'
    const add2Res = await api(
      "/api/kanban/cards",
      {
        method: "POST",
        body: JSON.stringify({ noteId: note2.id, status: "doing", sortOrder: 500 }),
      },
      cookie,
    );
    expect(add2Res.status).toBe(201);
    const { card: card2 } = (await add2Res.json()) as {
      card: { noteId: string; status: string; sortOrder: number };
    };
    expect(card2.noteId).toBe(note2.id);
    expect(card2.status).toBe("doing");
    expect(card2.sortOrder).toBe(500);

    // 4. List kanban cards
    const listRes = await api("/api/kanban", { method: "GET" }, cookie);
    expect(listRes.status).toBe(200);
    const { cards: activeCards } = (await listRes.json()) as {
      cards: Array<{ noteId: string; status: string; note: { title: string } }>;
    };
    expect(activeCards.length).toBe(2);
    expect(activeCards.find((c) => c.noteId === note1.id)?.status).toBe("inbox");
    expect(activeCards.find((c) => c.noteId === note2.id)?.status).toBe("doing");

    // 5. Filter by notebook
    const filterRes = await api(`/api/kanban?notebookId=${notebook.id}`, { method: "GET" }, cookie);
    const { cards: filteredCards } = (await filterRes.json()) as { cards: unknown[] };
    expect(filteredCards.length).toBe(2);

    // 6. Update card status (move note1 to 'doing')
    const patchRes = await api(
      `/api/kanban/cards/${note1.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ status: "doing", sortOrder: 200 }),
      },
      cookie,
    );
    expect(patchRes.status).toBe(200);
    const { card: patchedCard } = (await patchRes.json()) as {
      card: { status: string; sortOrder: number };
    };
    expect(patchedCard.status).toBe("doing");
    expect(patchedCard.sortOrder).toBe(200);

    // 7. Archive card (move note1 to 'archived')
    const archiveRes = await api(
      `/api/kanban/cards/${note1.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ status: "archived" }),
      },
      cookie,
    );
    expect(archiveRes.status).toBe(200);

    // Check active cards does not include archived note1
    const listAfterArchive = await api("/api/kanban", { method: "GET" }, cookie);
    const { cards: activeAfterArchive } = (await listAfterArchive.json()) as {
      cards: Array<{ noteId: string }>;
    };
    expect(activeAfterArchive.length).toBe(1);
    expect(activeAfterArchive[0].noteId).toBe(note2.id);

    // Check archived cards list
    const archivedListRes = await api("/api/kanban/archived", { method: "GET" }, cookie);
    expect(archivedListRes.status).toBe(200);
    const { cards: archivedCards } = (await archivedListRes.json()) as {
      cards: Array<{ noteId: string; status: string }>;
    };
    expect(archivedCards.length).toBe(1);
    expect(archivedCards[0].noteId).toBe(note1.id);
    expect(archivedCards[0].status).toBe("archived");

    // 8. Restore archived card to 'done'
    const restoreRes = await api(
      `/api/kanban/cards/${note1.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ status: "done" }),
      },
      cookie,
    );
    expect(restoreRes.status).toBe(200);

    // 9. Delete/remove card from kanban (without deleting note)
    const deleteCardRes = await api(`/api/kanban/cards/${note2.id}`, { method: "DELETE" }, cookie);
    expect(deleteCardRes.status).toBe(200);

    const listAfterDelete = await api("/api/kanban", { method: "GET" }, cookie);
    const { cards: finalCards } = (await listAfterDelete.json()) as {
      cards: Array<{ noteId: string }>;
    };
    expect(finalCards.length).toBe(1);
    expect(finalCards[0].noteId).toBe(note1.id);

    // Note2 still exists in regular notes
    const note2Check = await api(`/api/notes/${note2.id}`, { method: "GET" }, cookie);
    expect(note2Check.status).toBe(200);

    // 10. Trashing note1 hides it from kanban
    await api(
      "/api/notes/batch",
      {
        method: "PATCH",
        body: JSON.stringify({ notes: [{ id: note1.id, version: 1 }], deleted: true }),
      },
      cookie,
    );
    const listAfterTrash = await api("/api/kanban", { method: "GET" }, cookie);
    const { cards: cardsAfterTrash } = (await listAfterTrash.json()) as {
      cards: Array<{ noteId: string }>;
    };
    expect(cardsAfterTrash.length).toBe(0);

    // Restoring note1 restores it to kanban
    await api(
      "/api/notes/batch",
      {
        method: "PATCH",
        body: JSON.stringify({ notes: [{ id: note1.id, version: 2 }], deleted: false }),
      },
      cookie,
    );
    const listAfterRestore = await api("/api/kanban", { method: "GET" }, cookie);
    const { cards: cardsAfterRestore } = (await listAfterRestore.json()) as {
      cards: Array<{ noteId: string }>;
    };
    expect(cardsAfterRestore.length).toBe(1);
    expect(cardsAfterRestore[0].noteId).toBe(note1.id);
  });
});
