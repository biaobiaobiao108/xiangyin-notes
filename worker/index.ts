import { databaseFromBinding, type D1Binding } from "../server/db";
import type { R2BucketBinding, RealtimeNamespaceBinding } from "../server/core";
import { handleRequest } from "../server/index";
import type { WorkspaceChangeMessage } from "../shared/realtime";
import { MAX_CONNECTIONS_PER_USER, REALTIME_CLIENT_ID_HEADER } from "../server/realtime";

type StaticAssetsBinding = { fetch(request: Request): Promise<Response> };

export type Env = {
  DB: D1Binding;
  ASSETS_BUCKET: R2BucketBinding;
  ASSETS: StaticAssetsBinding;
  REALTIME_HUB: RealtimeNamespaceBinding;
  XIANGYING_USERNAME?: string;
  XIANGYING_PASSWORD?: string;
  XIANGYING_API_TOKEN?: string;
  XIANGYING_MCP_TOKEN?: string;
  PUBLIC_URL?: string;
  COOKIE_SECURE?: string;
  TRUST_PROXY?: string;
  TRUSTED_PROXY_ADDRESSES?: string;
};

type WorkerExecutionContext = { waitUntil(promise: Promise<unknown>): void };
type SocketWithAttachment = WebSocket & {
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): { clientId?: string | null } | null;
};
type RealtimeDurableState = {
  acceptWebSocket(socket: SocketWithAttachment): void;
  getWebSockets(): SocketWithAttachment[];
};

function workerEnvironment(env: Env) {
  return {
    XIANGYING_USERNAME: env.XIANGYING_USERNAME,
    XIANGYING_PASSWORD: env.XIANGYING_PASSWORD,
    XIANGYING_API_TOKEN: env.XIANGYING_API_TOKEN,
    XIANGYING_MCP_TOKEN: env.XIANGYING_MCP_TOKEN,
    PUBLIC_URL: env.PUBLIC_URL,
    COOKIE_SECURE: env.COOKIE_SECURE,
    TRUST_PROXY: env.TRUST_PROXY,
    TRUSTED_PROXY_ADDRESSES: env.TRUSTED_PROXY_ADDRESSES,
    NODE_ENV: "production",
  };
}

export default {
  async fetch(request: Request, env: Env, context: WorkerExecutionContext) {
    return handleRequest(request, {
      database: databaseFromBinding(env.DB),
      assets: env.ASSETS_BUCKET,
      staticAssets: env.ASSETS,
      realtimeNamespace: env.REALTIME_HUB,
      waitUntil: (promise) => context.waitUntil(promise),
      environment: workerEnvironment(env),
    });
  },
};

/** Per-user hibernatable WebSocket room for authenticated workspace events. */
export class RealtimeHub {
  constructor(private readonly state: RealtimeDurableState) {}

  async fetch(request: Request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/broadcast") {
      const payload = await request.json() as { resource?: string; noteId?: string; clientId?: string | null };
      if (payload.resource !== "notes" && payload.resource !== "notebooks") return new Response("Invalid broadcast", { status: 400 });
      const message: WorkspaceChangeMessage = {
        type: "workspace.changed",
        revision: Date.now(),
        resource: payload.resource,
        ...(typeof payload.noteId === "string" ? { noteId: payload.noteId } : {}),
      };
      const serialized = JSON.stringify(message);
      for (const socket of this.state.getWebSockets()) {
        if (payload.clientId && socket.deserializeAttachment()?.clientId === payload.clientId) continue;
        try {
          socket.send(serialized);
        } catch {
          socket.close(1011, "broadcast failed");
        }
      }
      return new Response(null, { status: 204 });
    }

    if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426, headers: { Allow: "GET" } });
    }

    const sockets = this.state.getWebSockets();
    if (sockets.length >= MAX_CONNECTIONS_PER_USER) sockets[0]?.close(1008, "connection limit exceeded");
    const Pair = (globalThis as unknown as { WebSocketPair: new () => { 0: WebSocket; 1: SocketWithAttachment } }).WebSocketPair;
    const pair = new Pair();
    const client = pair[0];
    const server = pair[1];
    const clientId = request.headers.get(REALTIME_CLIENT_ID_HEADER)
      ?? new URL(request.url).searchParams.get("clientId");
    server.serializeAttachment({ clientId });
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client } as ResponseInit);
  }

  webSocketMessage() {
    // The realtime channel is intentionally server-to-client only.
  }

  webSocketClose(socket: SocketWithAttachment) {
    try { socket.close(1000, "connection closed"); } catch {}
  }
}
