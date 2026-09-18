import { useEffect, useRef } from "react";
import { realtimeClientId } from "../api";
import type { WorkspaceChangeMessage, WorkspaceChangeResource } from "../../shared/realtime";

const REALTIME_PATH = "/api/realtime";
const LIFECYCLE_RECONCILE_COOLDOWN_MS = 1_000;
const FALLBACK_RECONCILE_MS = 30_000;
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

type UseWorkspaceRealtimeOptions = {
  ready: boolean;
  onChange: (message?: WorkspaceChangeMessage) => void;
};

function isWorkspaceChangeMessage(value: unknown): value is WorkspaceChangeMessage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<WorkspaceChangeMessage>;
  const resources: WorkspaceChangeResource[] = ["notes", "notebooks", "shares"];
  return candidate.type === "workspace.changed"
    && Number.isInteger(candidate.revision)
    && resources.includes(candidate.resource as WorkspaceChangeResource)
    && (candidate.noteId === undefined || typeof candidate.noteId === "string");
}

function websocketUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(`${protocol}//${window.location.host}${REALTIME_PATH}`);
  url.searchParams.set("clientId", realtimeClientId);
  return url.toString();
}

function isOnlineAndVisible() {
  return document.visibilityState === "visible" && navigator.onLine;
}

export function useWorkspaceRealtime({ ready, onChange }: UseWorkspaceRealtimeOptions) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!ready) return;

    let disposed = false;
    let reconnectAttempt = 0;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    let lastLifecycleReconcileAt = 0;

    const clearReconnectTimer = () => {
      if (!reconnectTimer) return;
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    };

    const clearFallbackTimer = () => {
      if (!fallbackTimer) return;
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    };

    const triggerLifecycleSync = () => {
      if (disposed) return;
      const now = Date.now();
      if (now - lastLifecycleReconcileAt < LIFECYCLE_RECONCILE_COOLDOWN_MS) return;
      lastLifecycleReconcileAt = now;
      onChangeRef.current(undefined);
    };

    const scheduleFallbackReconcile = () => {
      if (disposed || !isOnlineAndVisible() || fallbackTimer) return;
      fallbackTimer = setTimeout(() => {
        fallbackTimer = null;
        if (disposed || !isOnlineAndVisible()) return;
        if (!socket || socket.readyState !== WebSocket.OPEN) triggerLifecycleSync();
        scheduleFallbackReconcile();
      }, FALLBACK_RECONCILE_MS);
    };

    const scheduleReconnect = (immediate = false) => {
      if (disposed || !isOnlineAndVisible() || reconnectTimer) return;
      const baseDelay = immediate ? 0 : RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
      const jitter = immediate ? 0 : Math.floor(baseDelay * (Math.random() * 0.2));
      if (!immediate) reconnectAttempt = Math.min(reconnectAttempt + 1, RECONNECT_DELAYS_MS.length - 1);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (!disposed) openSocket();
      }, baseDelay + jitter);
    };

    const closeSocket = (code = 1000, reason = "reconnect") => {
      const current = socket;
      socket = null;
      if (current && (current.readyState === WebSocket.OPEN || current.readyState === WebSocket.CONNECTING)) current.close(code, reason);
    };

    const openSocket = () => {
      if (disposed || !isOnlineAndVisible() || (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING))) return;
      if (typeof WebSocket === "undefined") {
        scheduleFallbackReconcile();
        return;
      }

      let nextSocket: WebSocket;
      try {
        nextSocket = new WebSocket(websocketUrl());
      } catch {
        scheduleReconnect();
        scheduleFallbackReconcile();
        return;
      }
      socket = nextSocket;

      nextSocket.addEventListener("open", () => {
        if (disposed || socket !== nextSocket) return;
        reconnectAttempt = 0;
        clearReconnectTimer();
        clearFallbackTimer();
        triggerLifecycleSync();
      });

      nextSocket.addEventListener("message", (event) => {
        if (socket !== nextSocket) return;
        try {
          const payload: unknown = JSON.parse(typeof event.data === "string" ? event.data : "");
          if (isWorkspaceChangeMessage(payload)) onChangeRef.current(payload);
        } catch {
          // Ignore malformed or future event types so the connection remains usable.
        }
      });

      nextSocket.addEventListener("close", () => {
        if (socket !== nextSocket) return;
        socket = null;
        if (disposed || !isOnlineAndVisible()) return;
        scheduleReconnect();
        scheduleFallbackReconcile();
      });

      nextSocket.addEventListener("error", () => {
        // The close event owns reconnect scheduling; browsers usually emit both events.
      });
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        triggerLifecycleSync();
        scheduleReconnect(true);
        scheduleFallbackReconcile();
        return;
      }
      clearReconnectTimer();
      clearFallbackTimer();
      closeSocket(1000, "tab hidden");
    };
    const handleFocus = () => {
      if (!isOnlineAndVisible()) return;
      triggerLifecycleSync();
      scheduleReconnect(true);
    };
    const handleOnline = () => {
      reconnectAttempt = 0;
      triggerLifecycleSync();
      scheduleReconnect(true);
      scheduleFallbackReconcile();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleFocus);
    window.addEventListener("online", handleOnline);

    if (isOnlineAndVisible()) openSocket();
    else scheduleFallbackReconcile();

    return () => {
      disposed = true;
      clearReconnectTimer();
      clearFallbackTimer();
      closeSocket(1000, "workspace closed");
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("online", handleOnline);
    };
  }, [ready]);
}
