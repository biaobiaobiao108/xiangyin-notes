import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type SqliteDatabase } from "../server/db";
import { handleRequest } from "../server/index";

let database: SqliteDatabase;
let clientRoot: string;

beforeEach(async () => {
  database = await openDatabase(":memory:");
  clientRoot = await mkdtemp(join(tmpdir(), "xiangying-static-routes-"));
  await Bun.write(join(clientRoot, "index.html"), "<html><body>app</body></html>");
});

afterEach(async () => {
  database.close();
  await rm(clientRoot, { recursive: true, force: true });
});

for (const pathname of ["/app", "/app/", "/login", "/login/"]) {
  test(`serves the SPA shell at ${pathname}`, async () => {
    const response = await handleRequest(new Request(`http://xiangying.test${pathname}`), {
      database,
      clientRoot,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("app");
  });
}

test("still rejects unknown extensionless routes", async () => {
  const response = await handleRequest(new Request("http://xiangying.test/unknown/"), {
    database,
    clientRoot,
  });
  expect(response.status).toBe(404);
});
