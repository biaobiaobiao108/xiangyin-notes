import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { api } from "../api";

export function useWorkspaceSession() {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const [currentUserKey, setCurrentUserKey] = useState("");

  const handleUnauthorized = useCallback(
    () => navigate(`/login${window.location.search}`, { replace: true }),
    [navigate],
  );

  useEffect(() => {
    let disposed = false;
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
        } catch {
          if (!disposed) navigate(`/login${window.location.search}`, { replace: true });
        }
      })
      .catch(() => {
        if (!disposed) navigate(`/login${window.location.search}`, { replace: true });
      });
    return () => {
      disposed = true;
    };
  }, [navigate]);

  return { ready, currentUserKey, handleUnauthorized };
}
