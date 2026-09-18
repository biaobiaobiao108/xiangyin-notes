import { useEffect, useRef } from "react";

export type UseWorkspaceShortcutsOptions = {
  focusMode: boolean;
  hasModalOpen: boolean;
  toggleSidebar: () => void;
  toggleFocusMode: () => void;
  toggleTypewriterMode: () => void;
  exitFocusMode: () => void;
  openCommandMenu: (initialQuery?: string) => void;
};

export function useWorkspaceShortcuts(options: UseWorkspaceShortcutsOptions) {
  const {
    focusMode,
    hasModalOpen,
    toggleSidebar,
    toggleFocusMode,
    toggleTypewriterMode,
    exitFocusMode,
    openCommandMenu,
  } = options;

  const focusModeRef = useRef(focusMode);
  focusModeRef.current = focusMode;
  const hasModalOpenRef = useRef(hasModalOpen);
  hasModalOpenRef.current = hasModalOpen;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const isMod = event.ctrlKey || event.metaKey;

      if (isMod && (event.key === "/" || event.key === "k" || event.key === "K")) {
        event.preventDefault();
        openCommandMenu("");
      } else if (isMod && (event.key === "f" || event.key === "F") && !event.shiftKey) {
        event.preventDefault();
        const selectedText = window.getSelection()?.toString().trim() ?? "";
        const initial = selectedText && selectedText.length <= 50 ? selectedText : "";
        openCommandMenu(initial);
      } else if (isMod && event.key === "\\") {
        event.preventDefault();
        toggleSidebar();
      } else if (isMod && event.shiftKey && (event.key === "f" || event.key === "F")) {
        event.preventDefault();
        toggleFocusMode();
      } else if (event.altKey && event.shiftKey && (event.key === "t" || event.key === "T")) {
        event.preventDefault();
        toggleTypewriterMode();
      } else if (event.key === "Escape") {
        if (focusModeRef.current && !hasModalOpenRef.current) {
          exitFocusMode();
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [exitFocusMode, openCommandMenu, toggleFocusMode, toggleSidebar, toggleTypewriterMode]);
}
