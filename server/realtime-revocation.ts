import type { ServerOptions } from "./core";

export type RealtimeSessionRevoker = {
  revokeUser(userId: string): void;
  revokeSession(userId: string, tokenHash: string): void;
};

export function createRealtimeSessionRevoker(options: Pick<ServerOptions, "realtime" | "realtimeNamespace" | "waitUntil"> | undefined): RealtimeSessionRevoker | undefined {
  if (!options?.realtime && !options?.realtimeNamespace) return undefined;

  const dispatch = (userId: string, action: "revoke-user" | "revoke-session", tokenHash?: string) => {
    const namespace = options.realtimeNamespace;
    if (!namespace) return;
    const task = namespace.get(namespace.idFromName(userId)).fetch(new Request(`https://realtime.internal/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, ...(tokenHash ? { tokenHash } : {}) }),
    })).then((response) => {
      if (!response.ok) throw new Error(`Realtime revocation failed: ${response.status}`);
    });
    if (options.waitUntil) options.waitUntil(task);
    else void task.catch((error) => console.warn("[realtime] session revocation failed", error));
  };

  return {
    revokeUser(userId) {
      options.realtime?.revokeUser(userId);
      dispatch(userId, "revoke-user");
    },
    revokeSession(userId, tokenHash) {
      options.realtime?.revokeSession(tokenHash);
      dispatch(userId, "revoke-session", tokenHash);
    },
  };
}
