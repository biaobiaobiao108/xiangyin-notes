import { useEffect, useState } from "react";

export function useWorkspaceOffline({
  onOffline,
  onOnline,
}: {
  onOffline: () => void;
  onOnline: () => void;
}) {
  const [isOffline, setIsOffline] = useState(
    () => typeof navigator !== "undefined" && navigator.onLine === false,
  );

  useEffect(() => {
    const handleOffline = () => {
      setIsOffline(true);
      onOffline();
    };
    const handleOnline = () => {
      setIsOffline(false);
      onOnline();
    };
    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    return () => {
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
    };
  }, [onOffline, onOnline]);

  return isOffline;
}
