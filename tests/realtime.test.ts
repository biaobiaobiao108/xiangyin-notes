import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations, openDatabase, type SqliteDatabase } from "../server/db";
import { handleRequest } from "../server/index";
import {
  REALTIME_CLIENT_ID_HEADER,
  RealtimeHub,
  type RealtimeSocketData,
  upgradeRealtimeRequest,
} from "../server/realtime";

const environment: Record<string, string | undefined> = {
  XIANGYING_USERNAME: "owner",
  XIANGYING_PASSWORD: "a long passphrase 1234",
  XIANGYING_API_TOKEN: "shortcut-api-token-1234567890",
};

let database: SqliteDatabase;
let assetRoot: string;

type FakeSocket = {
  socket: Bun.ServerWebSocket<RealtimeSocketData>;
  messages: string[];
  pings: number;
  closed: boolean;
};

function fakeSocket(userId: string, clientId: string | null): FakeSocket {
  const state: { messages: string[]; pings: number; closed: boolean } = {
    messages: [],
    pings: 0,
    closed: false,
  };
  const socket = {
    data: { userId, clientId },
    sendText(message: string) {
      state.messages.push(message);
      return message.length;
    },
    ping() {
      state.pings += 1;
      return 1;
    },
    close() {
      state.closed = true;
    },
  } as unknown as Bun.ServerWebSocket<RealtimeSocketData>;
  return {
    socket,
    messages: state.messages,
    get pings() { return state.pings; },
    get closed() { return state.closed; },
  };
}

async function request(path: string, init: RequestInit = {}, options: { realtime?: RealtimeHub; cookie?: string; clientId?: string } = {}) {
  const headers = new Headers(init.headers);
  if (options.cookie) headers.set("Cookie", options.cookie);
  if (options.clientId) headers.set(REALTIME_CLIENT_ID_HEADER, options.clientId);
  const response = await handleRequest(new Request(`http://xiangying.test${path}`, { ...init, headers }), {
    database,
    environment,
    assetRoot,
    realtime: options.realtime,
    clientAddress: `test-${crypto.randomUUID()}`,
  });
  const body = await response.json().catch(() => null) as Record<string, any> | null;
  return { response, body, cookie: response.headers.get("Set-Cookie")?.split(";", 1)[0] };
}

beforeEach(async () => {
  database = await openDatabase(":memory:");
  await applyMigrations(database);
  assetRoot = join(tmpdir(), `xiangying-notes-realtime-${crypto.randomUUID()}`);
});

afterEach(async () => {
  database.close();
  await rm(assetRoot, { recursive: true, force: true });
});

describe("RealtimeHub", () => {
  test("publishes only to the target user and excludes the source client", () => {
    const hub = new RealtimeHub();
    const owner = fakeSocket("owner", "browser-1");
    const ownerOtherTab = fakeSocket("owner", "browser-2");
    const otherUser = fakeSocket("other-user", "browser-3");
    hub.add(owner.socket);
    hub.add(ownerOtherTab.socket);
    hub.add(otherUser.socket);

    hub.publish("owner", { resource: "notes", noteId: "note-1" }, "browser-1");
    hub.publish("owner", { resource: "notebooks" });

    expect(owner.messages).toHaveLength(1);
    expect(JSON.parse(owner.messages[0])).toMatchObject({ type: "workspace.changed", resource: "notebooks" });
    expect(ownerOtherTab.messages).toHaveLength(2);
    expect(otherUser.messages).toHaveLength(0);
    expect(JSON.parse(ownerOtherTab.messages[0])).toEqual({
      type: "workspace.changed",
      revision: 1,
      resource: "notes",
      noteId: "note-1",
    });
    expect(JSON.parse(ownerOtherTab.messages[1])).toEqual({
      type: "workspace.changed",
      revision: 2,
      resource: "notebooks",
    });

    hub.remove(ownerOtherTab.socket);
    expect(hub.getConnectionCount("owner")).toBe(1);
    hub.stop();
    expect(owner.closed).toBe(true);
    expect(otherUser.closed).toBe(true);
    expect(hub.getConnectionCount()).toBe(0);
  });

  test("bounds connections per user by evicting the oldest socket and cleans up faulty sockets", () => {
    const hub = new RealtimeHub();
    const sockets: FakeSocket[] = [];
    for (let i = 0; i < 33; i++) {
      const s = fakeSocket("user-limit", `client-${i}`);
      sockets.push(s);
      hub.add(s.socket);
    }
    expect(hub.getConnectionCount("user-limit")).toBe(32);
    expect(sockets[0]!.closed).toBe(true);
    expect(sockets[32]!.closed).toBe(false);

    // Test faulty socket in publish
    const brokenSocket = {
      data: { userId: "faulty-user", clientId: "broken" },
      sendText() {
        throw new Error("broken pipe");
      },
      close() {},
    } as unknown as Bun.ServerWebSocket<RealtimeSocketData>;
    hub.add(brokenSocket);
    expect(hub.getConnectionCount("faulty-user")).toBe(1);
    expect(() => hub.publish("faulty-user", { resource: "notes" })).not.toThrow();
    expect(hub.getConnectionCount("faulty-user")).toBe(0);
    hub.stop();
  });
});

describe("Realtime HTTP integration", () => {
  test("requires the existing session before upgrading the WebSocket", async () => {
    const hub = new RealtimeHub();
    let upgradeCalls = 0;
    const server = {
      upgrade() {
        upgradeCalls += 1;
        return true;
      },
    } as unknown as Bun.Server<RealtimeSocketData>;

    const response = await upgradeRealtimeRequest(
      new Request("http://xiangying.test/api/realtime", { headers: { Upgrade: "websocket" } }),
      server,
      { database, environment, realtime: hub },
    );

    expect(response?.status).toBe(401);
    expect(upgradeCalls).toBe(0);
    hub.stop();
  });

  test("rejects cross-site websocket hijacking with 403 when origin does not match", async () => {
    const hub = new RealtimeHub();
    const login = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "owner", password: environment.XIANGYING_PASSWORD }) });
    expect(login.cookie).toBeTruthy();

    const server = {
      upgrade() {
        return true;
      },
    } as unknown as Bun.Server<RealtimeSocketData>;

    // Foreign origin attempt
    const hijacked = await upgradeRealtimeRequest(
      new Request("http://xiangying.test/api/realtime", {
        headers: {
          Upgrade: "websocket",
          Cookie: login.cookie!,
          Origin: "https://evil-attacker.example.com",
        },
      }),
      server,
      { database, environment, realtime: hub },
    );
    expect(hijacked?.status).toBe(403);
    const body = await hijacked?.json();
    expect(body?.error?.code).toBe("FORBIDDEN_ORIGIN");

    // Same-origin attempt succeeds
    const legitimate = await upgradeRealtimeRequest(
      new Request("http://xiangying.test/api/realtime", {
        headers: {
          Upgrade: "websocket",
          Cookie: login.cookie!,
          Origin: "http://xiangying.test",
        },
      }),
      server,
      { database, environment, realtime: hub },
    );
    expect(legitimate).toBeNull();
    hub.stop();
  });

  test("authenticates the upgrade and emits import and link-mention events", async () => {
    const hub = new RealtimeHub();
    const login = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "owner", password: environment.XIANGYING_PASSWORD }) });
    expect(login.cookie).toBeTruthy();
    const userId = login.body?.user?.id as string;
    const socket = fakeSocket(userId, "browser-1");
    hub.add(socket.socket);

    let upgradeData: RealtimeSocketData | undefined;
    const server = {
      upgrade(_request: Request, options: { data: RealtimeSocketData }) {
        upgradeData = options.data;
        return true;
      },
    } as unknown as Bun.Server<RealtimeSocketData>;
    const upgradeResponse = await upgradeRealtimeRequest(
      new Request("http://xiangying.test/api/realtime?clientId=browser-1", { headers: { Upgrade: "websocket", Cookie: login.cookie! } }),
      server,
      { database, environment, realtime: hub },
    );
    expect(upgradeResponse).toBeNull();
    expect(upgradeData).toEqual({ userId, clientId: "browser-1" });

    const importHeaders = {
      Authorization: `Bearer ${environment.XIANGYING_API_TOKEN}`,
      "Content-Type": "text/markdown",
      "Idempotency-Key": "realtime-import-1",
    };
    const imported = await request("/api/import", {
      method: "POST",
      headers: importHeaders,
      body: "跨设备事件测试",
    }, { realtime: hub });
    expect(imported.response.status).toBe(201);
    expect(socket.messages).toHaveLength(1);
    expect(JSON.parse(socket.messages[0])).toMatchObject({
      type: "workspace.changed",
      resource: "notes",
      noteId: imported.body?.note?.id,
    });

    const replay = await request("/api/import", {
      method: "POST",
      headers: importHeaders,
      body: "跨设备事件测试",
    }, { realtime: hub });
    expect(replay.response.status).toBe(200);
    expect(socket.messages).toHaveLength(1);

    const sourceSuppressed = await request("/api/import", {
      method: "POST",
      headers: { ...importHeaders, "Idempotency-Key": "realtime-import-source" },
      body: "当前标签页发起的导入",
    }, { realtime: hub, clientId: "browser-1" });
    expect(sourceSuppressed.response.status).toBe(201);
    expect(socket.messages).toHaveLength(1);

    // Link mention event test
    const targetNote = await request("/api/notes", {
      method: "POST",
      body: JSON.stringify({ title: "提及目标" }),
    }, { cookie: login.cookie, realtime: hub });
    const targetId = targetNote.body?.note?.id as string;

    const sourceNote = await request("/api/notes", {
      method: "POST",
      body: JSON.stringify({ title: "来源笔记", contentMarkdown: "这里包含提及目标的正文" }),
    }, { cookie: login.cookie, realtime: hub });
    const sourceId = sourceNote.body?.note?.id as string;
    const sourceVersion = sourceNote.body?.note?.version as number;

    const linkMentionRes = await request(`/api/notes/${targetId}/link-mention`, {
      method: "POST",
      body: JSON.stringify({
        sourceNoteId: sourceId,
        sourceVersion,
        matchStart: 4,
        matchEnd: 8,
        matchText: "提及目标",
      }),
    }, { cookie: login.cookie, realtime: hub, clientId: "other-client" });
    expect(linkMentionRes.response.status).toBe(200);

    const lastMessage = JSON.parse(socket.messages[socket.messages.length - 1]!);
    expect(lastMessage).toMatchObject({
      type: "workspace.changed",
      resource: "notes",
      noteId: sourceId,
    });

    const renamed = await request(`/api/notes/${targetId}`, {
      method: "PATCH",
      body: JSON.stringify({ version: targetNote.body?.note?.version, title: "新提及目标" }),
    }, { cookie: login.cookie, realtime: hub, clientId: "other-client" });
    expect(renamed.response.status).toBe(200);
    const renameMessage = JSON.parse(socket.messages[socket.messages.length - 1]!);
    expect(renameMessage).toMatchObject({ type: "workspace.changed", resource: "notes" });
    expect(renameMessage).not.toHaveProperty("noteId");
    const updatedSource = await request(`/api/notes/${sourceId}`, {}, { cookie: login.cookie });
    expect(updatedSource.body?.note?.contentMarkdown).toContain("[[新提及目标]]");

    hub.stop();
  });
});
