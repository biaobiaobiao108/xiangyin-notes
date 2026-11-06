import { afterEach, beforeEach, expect, test } from "bun:test";
import { openDatabase, type SqliteDatabase } from "../server/db";
import { handleRequest } from "../server/index";

let database: SqliteDatabase;
let cookie: string;
const environment = {
  XIANGYING_USERNAME: "owner",
  XIANGYING_PASSWORD: "visible search test passphrase 1234",
};

async function request(path: string, method = "GET", payload?: unknown) {
  const response = await handleRequest(
    new Request(`http://xiangying.test${path}`, {
      method,
      headers: cookie ? { Cookie: cookie } : undefined,
      body: payload === undefined ? undefined : JSON.stringify(payload),
    }),
    { database, environment, clientRoot: "dist/client", clientAddress: "search-visible-text" },
  );
  return { response, body: (await response.json()) as any };
}

beforeEach(async () => {
  database = await openDatabase(":memory:");
  cookie = "";
  const response = await handleRequest(
    new Request("http://xiangying.test/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        username: environment.XIANGYING_USERNAME,
        password: environment.XIANGYING_PASSWORD,
      }),
    }),
    { database, environment, clientRoot: "dist/client", clientAddress: crypto.randomUUID() },
  );
  cookie = response.headers.get("Set-Cookie")!.split(";", 1)[0]!;
});

afterEach(() => {
  database.close();
});

async function createSearchFixture() {
  const inbox = (await request("/api/notebooks")).body.notebooks[0].id;
  const created = await request("/api/notes", "POST", {
    notebookId: inbox,
    title: "搜索可见文本",
    contentMarkdown: [
      '前文 <span data-annotation-id="11111111-1111-4111-8111-111111111111" data-note="隐藏关键词QZW">可见文字</span> 后文',
      "![图片](https://example.com/secret-image.png)",
      "[链接](https://example.com/hidden-target)",
    ].join("\n\n"),
  });
  expect(created.response.status).toBe(201);
  return created.body.note;
}

for (const query of ["隐藏关键词QZW", "data-annotation-id", "secret-image", "hidden-target"]) {
  test(`does not match hidden Markdown metadata: ${query}`, async () => {
    await createSearchFixture();
    const result = await request(`/api/notes?view=all&query=${encodeURIComponent(query)}`);
    expect(result.response.status).toBe(200);
    expect(result.body.notes).toHaveLength(0);
  });
}

test("matches visible text and returns a clean snippet", async () => {
  await createSearchFixture();
  const result = await request(
    `/api/notes?view=all&query=${encodeURIComponent("可见文字")}&includeMatch=1`,
  );
  expect(result.response.status).toBe(200);
  expect(result.body.notes).toHaveLength(1);
  expect(result.body.notes[0].match.snippet).toContain("可见文字");
  expect(result.body.notes[0].match.snippet).not.toContain("<span");
  expect(result.body.notes[0].match.snippet).not.toContain("data-note");
});

test("short searches use the same visible text index", async () => {
  await createSearchFixture();
  const hidden = await request(`/api/notes?view=all&query=${encodeURIComponent("隐")}`);
  expect(hidden.body.notes).toHaveLength(0);
  const visible = await request(`/api/notes?view=all&query=${encodeURIComponent("字")}`);
  expect(visible.body.notes).toHaveLength(1);
});
