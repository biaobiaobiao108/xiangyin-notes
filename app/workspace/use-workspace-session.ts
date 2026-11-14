import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { api, ApiError } from "../api";

export function useWorkspaceSession() {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const [currentUserKey, setCurrentUserKey] = useState("");
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  const handleUnauthorized = useCallback(
    () => navigate(`/login${window.location.search}`, { replace: true }),
    [navigate],
  );
  const retry = useCallback(() => {
    setConnectionError(null);
    setRetryToken((value) => value + 1);
  }, []);

  useEffect(() => {
    let disposed = false;
    setConnectionError(null);
    void api
      .bootstrap()
      .then(async (status) => {
        if (!status.configured) {
          navigate(`/setup${window.location.search}`, { replace: true });
          return;
        }
        try {
          const session = await api.me();
          if (!disposed) {
            setCurrentUserKey(session.user.username);
            setReady(true);
          }
        } catch (error) {
          if (disposed) return;
          if (error instanceof ApiError && error.status === 401)
            navigate(`/login${window.location.search}`, { replace: true });
          else setConnectionError("无法连接服务器，请检查网络或服务是否仍在运行。");
        }
      })
      .catch((error) => {
        if (disposed) return;
        if (error instanceof ApiError) {
          if (error.status === 401) navigate(`/login${window.location.search}`, { replace: true });
          else setConnectionError("服务器暂时无法响应，请稍后重试。");
        } else {
          setConnectionError("无法连接服务器，请检查网络或服务是否仍在运行。");
        }
      });
    return () => {
      disposed = true;
    };
  }, [navigate, retryToken]);

  return { ready, currentUserKey, handleUnauthorized, connectionError, retry };
}
