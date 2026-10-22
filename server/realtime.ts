import type { WorkspaceChangeMessage, WorkspaceChangeResource } from "../shared/realtime";
import { digestHex, getPublicOrigin, jsonError, SESSION_COOKIE, type ServerOptions } from "./core";
import { cleanupExpiredSessions, cookieValue, isResponse, requireUser } from "./routes/auth";
import { createRealtimeSessionRevoker } from "./realtime-revocation";

export const REALTIME_PATH = "/api/realtime";
export const REALTIME_CLIENT_ID_HEADER = "X-Xiangying-Client-Id";
export const REALTIME_HEARTBEAT_MS = 25_000;
export const MAX_CONNECTIONS_PER_USER = 32;

const CLIENT_ID_PATTERN = /^[\x21-\x7E]{1,128}$/u;

export type RealtimeSocketData = {
  userId: string;
  clientId: string | null;
  sessionTokenHash?: string;
};

function normalizeClientId(value: string | null | undefined) {
  const normalized = value?.trim() ?? "";
  return normalized && CLIENT_ID_PATTERN.test(normalized) ? normalized : null;
}

export function requestClientId(request: Request) {
  return normalizeClientId(request.headers.get(REALTIME_CLIENT_ID_HEADER));
}

export function realtimeClientIdFromUrl(request: Request) {
  return normalizeClientId(new URL(request.url).searchParams.get("clientId"));
}

export class RealtimeHub {
  private readonly connections = new Map<string, Set<Bun.ServerWebSocket<RealtimeSocketData>>>();
  private revision = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  private closeMatching(predicate: (socket: Bun.ServerWebSocket<RealtimeSocketData>) => boolean) {
    for (const userConnections of this.connections.values()) {
      for (const socket of userConnections) {
        if (!predicate(socket)) continue;
        this.remove(socket);
        try {
          socket.close(1008, "session revoked");
        } catch {}
      }
    }
  }

  revokeUser(userId: string) {
    this.closeMatching((socket) => socket.data?.userId === userId);
  }

  revokeSession(tokenHash: string) {
    this.closeMatching((socket) => socket.data?.sessionTokenHash === tokenHash);
  }

  add(socket: Bun.ServerWebSocket<RealtimeSocketData>) {
    const userId = socket.data?.userId;
    if (!userId) return;
    const userConnections =
      this.connections.get(userId) ?? new Set<Bun.ServerWebSocket<RealtimeSocketData>>();
    if (userConnections.size >= MAX_CONNECTIONS_PER_USER) {
      const oldest = userConnections.values().next().value;
      if (oldest) {
        userConnections.delete(oldest);
        try {
          oldest.close(1008, "connection limit exceeded");
        } catch {}
      }
    }
    userConnections.add(socket);
    this.connections.set(userId, userConnections);
  }

  remove(socket: Bun.ServerWebSocket<RealtimeSocketData>) {
    const userId = socket.data?.userId;
    if (!userId) return;
    const userConnections = this.connections.get(userId);
    if (!userConnections) return;
    userConnections.delete(socket);
    if (!userConnections.size) this.connections.delete(userId);
  }

  publish(
    userId: string,
    change: { resource: WorkspaceChangeResource; noteId?: string },
    sourceClientId: string | null = null,
  ) {
    const userConnections = this.connections.get(userId);
    if (!userConnections?.size) return;

    const message: WorkspaceChangeMessage = {
      type: "workspace.changed",
      revision: ++this.revision,
      resource: change.resource,
      ...(change.noteId ? { noteId: change.noteId } : {}),
    };
    const serialized = JSON.stringify(message);
    const deadSockets: Bun.ServerWebSocket<RealtimeSocketData>[] = [];
    for (const socket of userConnections) {
      if (sourceClientId && socket.data?.clientId === sourceClientId) continue;
      try {
        socket.sendText(serialized);
      } catch {
        deadSockets.push(socket);
      }
    }
    for (const socket of deadSockets) {
      this.remove(socket);
      try {
        socket.close(1006, "send failed");
      } catch {}
    }
  }

  startHeartbeat() {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      const deadSockets: Bun.ServerWebSocket<RealtimeSocketData>[] = [];
      for (const userConnections of this.connections.values()) {
        for (const socket of userConnections) {
          try {
            socket.ping();
          } catch {
            deadSockets.push(socket);
          }
        }
      }
      for (const socket of deadSockets) {
        this.remove(socket);
        try {
          socket.close(1006, "heartbeat failed");
        } catch {}
      }
    }, REALTIME_HEARTBEAT_MS);
  }

  stop() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const userConnections of this.connections.values()) {
      for (const socket of userConnections) {
        try {
          socket.close(1001, "server shutting down");
        } catch {}
      }
    }
    this.connections.clear();
  }

  getConnectionCount(userId?: string) {
    if (userId) return this.connections.get(userId)?.size ?? 0;
    let count = 0;
    for (const userConnections of this.connections.values()) count += userConnections.size;
    return count;
  }
}

export function publishWorkspaceChange(
  options: Pick<ServerOptions, "realtime" | "realtimeNamespace" | "waitUntil"> | undefined,
  userId: string,
  change: { resource: WorkspaceChangeResource; noteId?: string },
  request?: Request,
) {
  options?.realtime?.publish(userId, change, request ? requestClientId(request) : null);
  const namespace = options?.realtimeNamespace;
  if (!namespace) return;
  const task = namespace.get(namespace.idFromName(userId)).fetch(
    new Request("https://realtime.internal/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...change, clientId: request ? requestClientId(request) : null }),
    }),
  );
  if (options.waitUntil) options.waitUntil(task);
  else void task.catch((error) => console.warn("[realtime] broadcast failed", error));
}

export async function handleRealtimeRequest(
  request: Request,
  options: ServerOptions,
): Promise<Response> {
  if (request.method !== "GET")
    return jsonError(405, "METHOD_NOT_ALLOWED", "实时连接只支持 GET", { Allow: "GET" });
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
    return jsonError(426, "UPGRADE_REQUIRED", "需要使用 WebSocket 连接");
  if (!options.realtimeNamespace)
    return jsonError(503, "REALTIME_NOT_CONFIGURED", "实时连接暂不可用");

  const origin = request.headers.get("Origin");
  if (origin) {
    const requestUrl = new URL(request.url);
    const allowedOrigins = new Set([requestUrl.origin]);
    try {
      allowedOrigins.add(getPublicOrigin(requestUrl, options.environment));
    } catch {}
    if (!allowedOrigins.has(origin)) {
      return jsonError(403, "FORBIDDEN_ORIGIN", "非法的实时连接来源");
    }
  }

  await cleanupExpiredSessions(options.database);
  const user = await requireUser(
    options.database,
    options.environment ?? {},
    request,
    createRealtimeSessionRevoker(options),
  );
  if (isResponse(user)) return user;
  const namespace = options.realtimeNamespace;
  const response = await namespace.get(namespace.idFromName(user.id)).fetch(request);
  return response;
}

/** Test/development adapter for the former Bun websocket upgrader. Production uses the Durable Object handler above. */
export async function upgradeRealtimeRequest(
  request: Request,
  server: Pick<Bun.Server<RealtimeSocketData>, "upgrade">,
  options: ServerOptions,
): Promise<Response | null> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
    return jsonError(426, "UPGRADE_REQUIRED", "需要使用 WebSocket 连接");
  const origin = request.headers.get("Origin");
  if (origin) {
    const requestUrl = new URL(request.url);
    if (
      origin !== requestUrl.origin &&
      origin !== getPublicOrigin(requestUrl, options.environment)
    ) {
      return jsonError(403, "FORBIDDEN_ORIGIN", "非法的实时连接来源");
    }
  }
  await cleanupExpiredSessions(options.database);
  const realtime = createRealtimeSessionRevoker(options);
  const user = await requireUser(options.database, options.environment ?? {}, request, realtime);
  if (isResponse(user)) return user;
  const clientId = realtimeClientIdFromUrl(request) ?? requestClientId(request);
  const session = cookieValue(request.headers.get("Cookie"), SESSION_COOKIE);
  if (!session) return jsonError(401, "UNAUTHENTICATED", "请先登录");
  const sessionTokenHash = await digestHex(session);
  return server.upgrade(request, { data: { userId: user.id, clientId, sessionTokenHash } })
    ? null
    : jsonError(400, "WEBSOCKET_UPGRADE_FAILED", "无法建立实时连接");
}
