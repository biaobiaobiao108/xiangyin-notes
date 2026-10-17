import { expect, test } from "bun:test";
import { openDatabase } from "../server/db";
import { handleRequest } from "../server/index";

for (const [title, mention] of [["AI", "ai"], ["ai", "AI"]]) {
  test(`backlinks find ${mention} as an unlinked mention of ${title}`, async () => {
    const database = await openDatabase(":memory:");
    const environment = { XIANGYING_USERNAME: "owner", XIANGYING_PASSWORD: "backlinks case test passphrase" };
    let cookie = "";
    const request = async (path: string, method = "GET", payload?: unknown) => {
      const response = await handleRequest(new Request(`http://xiangying.test${path}`, {
        method,
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      }), { database, environment, clientAddress: "backlinks-case" });
      return response;
    };

    try {
      const login = await request("/api/auth/login", "POST", {
        username: environment.XIANGYING_USERNAME,
        password: environment.XIANGYING_PASSWORD,
      });
      expect(login.status).toBe(200);
      cookie = login.headers.get("Set-Cookie")!.split(";", 1)[0]!;
      const targetResponse = await request("/api/notes", "POST", { title });
      expect(targetResponse.status).toBe(201);
      const { note: target } = await targetResponse.json() as { note: { id: string } };
      const sourceResponse = await request("/api/notes", "POST", { title: "来源", contentMarkdown: `${mention} 是正文` });
      expect(sourceResponse.status).toBe(201);
      const { note: source } = await sourceResponse.json() as { note: { id: string; version: number } };

      const response = await request(`/api/notes/${target.id}/backlinks`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        linkedReferences: [],
        unlinkedMentions: [{ sourceNoteId: source.id, sourceVersion: source.version, matchIndex: 0, matchText: mention }],
        truncated: false,
      });
    } finally {
      database.close();
    }
  });
}
