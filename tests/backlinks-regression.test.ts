import { afterEach, beforeEach, expect, test } from "bun:test";
import { openDatabase, type SqliteDatabase } from "../server/db";
import { handleRequest } from "../server/index";
import { MAX_SHORT_TERM_CONTENT_CHARS, MAX_SHORT_TERMS_PER_NOTE } from "../server/note-search";

let database: SqliteDatabase;
let cookie: string;
let notebookId: string;
const environment = { XIANGYING_USERNAME: "owner", XIANGYING_PASSWORD: "backlinks test passphrase 1234" };

test("backlink dialog keeps linked status icon-only and metadata grouped on mobile", async () => {
  const component = await Bun.file("app/editor/backlinks-panel.tsx").text();
  const styles = await Bun.file("app/styles.css").text();
  expect(component).toContain('role: "img", "aria-label": "已链接", title: "已链接"');
  expect(component).toContain('<Link2 size={13} aria-hidden="true" />');
  expect(component).not.toContain("<span>已链接</span>");
  expect(styles).toContain(".backlinks-dialog .backlink-card-title-button { display: grid;");
  expect(styles).toContain(".backlinks-dialog .backlink-card-time { flex: none; margin-left: auto; white-space: nowrap;");
});

async function request(path: string, method = "GET", payload?: unknown) {
  const response = await handleRequest(new Request(`http://xiangying.test${path}`, {
    method,
    headers: cookie ? { Cookie: cookie } : undefined,
    body: payload === undefined ? undefined : JSON.stringify(payload),
  }), { database, environment, clientRoot: "dist/client", clientAddress: "backlinks-regression" });
  const body = await response.json() as any;
  return { response, body };
}

beforeEach(async () => {
  database = await openDatabase(":memory:");
  cookie = "";
  const response = await handleRequest(new Request("http://xiangying.test/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: environment.XIANGYING_USERNAME, password: environment.XIANGYING_PASSWORD }),
  }), { database, environment, clientRoot: "dist/client", clientAddress: crypto.randomUUID() });
  cookie = response.headers.get("Set-Cookie")!.split(";", 1)[0]!;
  notebookId = (await request("/api/notebooks")).body.notebooks[0].id;
});

afterEach(() => database.close());

async function createNote(title: string, contentMarkdown = "") {
  const result = await request("/api/notes", "POST", { notebookId, title, contentMarkdown });
  expect(result.response.status).toBe(201);
  return result.body.note;
}

for (const trashedRole of ["source", "target"] as const) {
  test(`link mention rejects a trashed ${trashedRole} and preserves the source`, async () => {
    const target = await createNote("苹果");
    const source = await createNote("来源", "苹果在这里");
    const trashed = trashedRole === "source" ? source : target;
    const deletion = await request(`/api/notes/${trashed.id}`, "PATCH", { version: trashed.version, deleted: true });
    expect(deletion.response.status).toBe(200);
    const before = (await request(`/api/notes/${source.id}`)).body.note;
    const result = await request(`/api/notes/${target.id}/link-mention`, "POST", {
      sourceNoteId: source.id, sourceVersion: before.version, matchStart: 0, matchEnd: 2, matchText: "苹果",
    });
    expect(result.response.status).toBe(409);
    expect(result.body.error.code).toBe("NOTE_IN_TRASH");
    const after = (await request(`/api/notes/${source.id}`)).body.note;
    expect(after.contentMarkdown).toBe(before.contentMarkdown);
    expect(after.version).toBe(before.version);
    expect(after.deletedAt).toBe(before.deletedAt);
  });
}

for (const limit of ["content", "terms"] as const) {
  test(`backlinks find a short-title mention beyond the ${limit} index limit`, async () => {
    const target = await createNote("苹果");
    const prefix = limit === "content"
      ? "甲".repeat(MAX_SHORT_TERM_CONTENT_CHARS + 1)
      : Array.from({ length: MAX_SHORT_TERMS_PER_NOTE }, (_, index) => String.fromCodePoint(0x4e00 + index)).join(" ");
    const content = `${prefix}\n苹果在这里`;
    const source = await createNote("来源", content);
    expect(database.query("SELECT term FROM note_short_terms WHERE note_id = ? AND term = ?").get(source.id, "苹果")).toBeNull();
    const result = await request(`/api/notes/${target.id}/backlinks`);
    expect(result.response.status).toBe(200);
    expect(result.body.truncated).toBe(false);
    expect(result.body.unlinkedMentions).toHaveLength(1);
    expect(result.body.unlinkedMentions[0]).toMatchObject({
      sourceNoteId: source.id, matchIndex: prefix.length + 1, matchText: "苹果", sourceVersion: source.version,
    });
  });
}
