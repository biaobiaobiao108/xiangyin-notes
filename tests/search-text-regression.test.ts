import { expect, test } from "bun:test";
import { openDatabase } from "../server/db";
import { handleRequest } from "../server/index";
import { waitForOrphanAssetCleanup } from "../server/routes/assets";
import { ensureEnvironmentUser } from "../server/routes/auth";
import { createNote } from "../server/routes/notes";

async function fixture() {
  const database = await openDatabase(":memory:");
  const environment = {
    XIANGYING_USERNAME: "search-text-owner",
    XIANGYING_PASSWORD: "search-text-test-password",
  };
  const user = await ensureEnvironmentUser(database, {
    username: environment.XIANGYING_USERNAME,
    password: environment.XIANGYING_PASSWORD,
  });
  const notebook = database
    .query("SELECT id FROM notebooks WHERE user_id = ? AND is_system = 1")
    .get(user.id) as { id: string };
  const login = await handleRequest(
    new Request("http://search-text.test/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        username: environment.XIANGYING_USERNAME,
        password: environment.XIANGYING_PASSWORD,
      }),
    }),
    { database, environment },
  );
  const cookie = login.headers.get("Set-Cookie")!.split(";", 1)[0]!;
  return {
    database,
    userId: user.id,
    notebookId: notebook.id,
    environment,
    cookie,
    create: (title: string, markdown: string) =>
      createNote(database, user.id, notebook.id, title, markdown),
    search: (query: string, includeMatch = false) =>
      handleRequest(
        new Request(
          `http://search-text.test/api/notes?query=${encodeURIComponent(query)}&sort=relevance${includeMatch ? "&includeMatch=1" : ""}`,
          { headers: { Cookie: cookie } },
        ),
        { database, environment },
      ),
  };
}

test("short search uses Unicode case folding for accents and Greek sigma", async () => {
  const f = await fixture();
  try {
    const note = f.create("Short search", "École and Σίσυφος");
    for (const query of ["é", "É", "σ", "ς"]) {
      const response = await f.search(query);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { notes: Array<{ id: string }> };
      expect(body.notes.map(({ id }) => id)).toContain(note);
    }
  } finally {
    await waitForOrphanAssetCleanup(f.database);
    f.database.close();
  }
});

test("short index does not equate dotless i with ASCII I", async () => {
  const f = await fixture();
  try {
    const note = f.create("标题", "甲ı乙");
    const response = await f.search("I");
    const body = (await response.json()) as { notes: Array<{ id: string }> };
    expect(body.notes.map(({ id }) => id)).not.toContain(note);
  } finally {
    await waitForOrphanAssetCleanup(f.database);
    f.database.close();
  }
});

test("short search indexes emoji and punctuation without a body scan", async () => {
  const f = await fixture();
  try {
    const note = f.create("Symbols", "A😊B foo.bar");
    for (const query of ["😊", ".", "foo."]) {
      const response = await f.search(query);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { notes: Array<{ id: string }> };
      expect(body.notes.map(({ id }) => id)).toContain(note);
    }
  } finally {
    await waitForOrphanAssetCleanup(f.database);
    f.database.close();
  }
});

test("overflow search and snippets use the same Unicode matching as indexing", async () => {
  const f = await fixture();
  try {
    const content = `${"x".repeat(40_100)}  École in the overflow section`;
    const note = f.create("Overflow", content);
    for (const query of ["é", "école"]) {
      const response = await f.search(query, true);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        notes: Array<{ id: string; match: { field: string; snippet: string } }>;
      };
      const result = body.notes.find((item) => item.id === note);
      expect(result?.match.field).toBe("content");
      expect(result?.match.snippet).toContain("École");
      expect(result?.match.snippet.length).toBeLessThanOrEqual(200);
    }
  } finally {
    await waitForOrphanAssetCleanup(f.database);
    f.database.close();
  }
});

test("long FTS relevance search stays scoped to the authenticated user", async () => {
  const f = await fixture();
  try {
    const other = await ensureEnvironmentUser(f.database, {
      username: "other-search-text-owner",
      password: "other-search-text-password",
    });
    const otherNotebook = f.database
      .query("SELECT id FROM notebooks WHERE user_id = ? AND is_system = 1")
      .get(other.id) as { id: string };
    const otherNote = createNote(
      f.database,
      other.id,
      otherNotebook.id,
      "Private",
      "sharedneedle private corpus",
    );
    const ownNote = f.create("Mine", "sharedneedle own corpus");

    const response = await f.search("sharedneedle");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { total: number; notes: Array<{ id: string }> };
    expect(body.total).toBe(1);
    expect(body.notes.map(({ id }) => id)).toContain(ownNote);
    expect(body.notes.map(({ id }) => id)).not.toContain(otherNote);
  } finally {
    await waitForOrphanAssetCleanup(f.database);
    f.database.close();
  }
});
