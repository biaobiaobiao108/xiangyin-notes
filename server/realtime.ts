import type { WorkspaceChangeMessage, WorkspaceChangeResource } from "../shared/realtime";
import { jsonError, type ServerOptions } from "./core";
import { cleanupExpiredSessions, isResponse, requireUser } from "./routes/auth";

export const REALTIME_PATH = "/api/realtime";
export const REALTIME_CLIENT_ID_HEADER = "X-Xiangying-Client-Id";
export const REALTIME_HEARTBEAT_MS = 25_000;

const CLIENT_ID_PATTERN = /^[\x21-\x7E]{1,128}$/u;

export type RealtimeSocketData = {
  userId: string;
  clientId: string | null;
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

  add(socket: Bun.ServerWebSocket<RealtimeSocketData>) {
    const userConnections = this.connections.get(socket.data.userId) ?? new Set<Bun.ServerWebSocket<RealtimeSocketData>>();
    userConnections.add(socket);
    this.connections.set(socket.data.userId, userConnections);
  }

  remove(socket: Bun.ServerWebSocket<RealtimeSocketData>) {
    const userConnections = this.connections.get(socket.data.userId);
    if (!userConnections) return;
    userConnections.delete(socket);
    if (!userConnections.size) this.connections.delete(socket.data.userId);
  }

  publish(userId: string, change: { resource: WorkspaceChangeResource; noteId?: string }, sourceClientId: string | null = null) {
    const userConnections = this.connections.get(userId);
    if (!userConnections?.size) return;

    const message: WorkspaceChangeMessage = {
      type: "workspace.changed",
      revision: ++this.revision,
      resource: change.resource,
      ...(change.noteId ? { noteId: change.noteId } : {}),
    };
    const serialized = JSON.stringify(message);
    for (const socket of userConnections) {
      if (sourceClientId && socket.data.clientId === sourceClientId) continue;
      socket.sendText(serialized);
    }
  }

  startHeartbeat() {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      for (const userConnections of this.connections.values()) {
        for (const socket of userConnections) socket.ping();
      }
    }, REALTIME_HEARTBEAT_MS);
  }

  stop() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const userConnections of this.connections.values()) {
      for (const socket of userConnections) socket.close(1001, "server shutting down");
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
  options: Pick<ServerOptions, "realtime"> | undefined,
  userId: string,
  change: { resource: WorkspaceChangeResource; noteId?: string },
  request?: Request,
) {
  options?.realtime?.publish(userId, change, request ? requestClientId(request) : null);
}

export async function upgradeRealtimeRequest(
  request: Request,
  server: Bun.Server<RealtimeSocketData>,
  options: ServerOptions,
): Promise<Response | null> {
  if (request.method !== "GET") return jsonError(405, "METHOD_NOT_ALLOWED", "实时连接只支持 GET", { Allow: "GET" });
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return jsonError(426, "UPGRADE_REQUIRED", "需要使用 WebSocket 连接");
  if (!options.realtime) return jsonError(503, "REALTIME_NOT_CONFIGURED", "实时连接暂不可用");

  cleanupExpiredSessions(options.database);
  const user = await requireUser(options.database, options.environment ?? {}, request);
  if (isResponse(user)) return user;

  const upgraded = server.upgrade(request, {
    data: {
      userId: user.id,
      clientId: realtimeClientIdFromUrl(request),
    },
  });
  return upgraded ? null : jsonError(400, "REALTIME_UPGRADE_FAILED", "无法建立实时连接");
}
