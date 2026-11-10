import { useCallback, useState } from "react";
import { flushSync } from "react-dom";

export type ViewLayout = "three-column" | "cards";

function readStoredFlag(key: string) {
  try {
    return localStorage.getItem(key) === "true";
  } catch {
    return false;
  }
}

function writeStoredFlag(key: string, value: boolean) {
  try {
    localStorage.setItem(key, String(value));
  } catch {}
}

export function useWorkspacePreferences() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [focusMode, setFocusMode] = useState(() => readStoredFlag("xiangying_focus_mode"));
  const [typewriterMode, setTypewriterMode] = useState(() =>
    readStoredFlag("xiangying_typewriter_mode"),
  );
  const [viewLayout, setViewLayout] = useState<ViewLayout>(() => {
    try {
      return (localStorage.getItem("xiangying_view_layout") as ViewLayout) || "three-column";
    } catch {
      return "three-column";
    }
  });

  const toggleFocusMode = useCallback(() => {
    setFocusMode((current) => {
      const next = !current;
      writeStoredFlag("xiangying_focus_mode", next);
      return next;
    });
  }, []);

  const toggleTypewriterMode = useCallback(() => {
    setTypewriterMode((current) => {
      const next = !current;
      writeStoredFlag("xiangying_typewriter_mode", next);
      return next;
    });
  }, []);

  const exitFocusMode = useCallback(() => {
    setFocusMode(false);
    writeStoredFlag("xiangying_focus_mode", false);
  }, []);

  const toggleSidebar = useCallback(() => {
    const toggle = () => setSidebarCollapsed((value) => !value);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion || typeof document.startViewTransition !== "function") {
      toggle();
      return;
    }
    document.startViewTransition(() => flushSync(toggle));
  }, []);

  return {
    sidebarCollapsed,
    setSidebarCollapsed,
    toggleSidebar,
    focusMode,
    toggleFocusMode,
    exitFocusMode,
    typewriterMode,
    toggleTypewriterMode,
    viewLayout,
    setViewLayout,
  };
}
