import { useEffect, useRef } from "react";

export type UseWorkspaceShortcutsOptions = {
  focusMode: boolean;
  hasModalOpen: boolean;
  toggleSidebar: () => void;
  toggleFocusMode: () => void;
  toggleTypewriterMode: () => void;
  exitFocusMode: () => void;
  openCommandMenu: (initialQuery?: string) => void;
  toggleViewLayout?: () => void;
  isCardEditing?: boolean;
  onExitCardEditing?: () => void;
  hasSelection?: boolean;
  clearSelection?: () => void;
  outlineOpen?: boolean;
  closeOutline?: () => void;
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
    toggleViewLayout,
    isCardEditing = false,
    onExitCardEditing,
    hasSelection = false,
    clearSelection,
    outlineOpen = false,
    closeOutline,
  } = options;

  const focusModeRef = useRef(focusMode);
  focusModeRef.current = focusMode;
  const isCardEditingRef = useRef(isCardEditing);
  isCardEditingRef.current = isCardEditing;
  const hasModalOpenRef = useRef(hasModalOpen);
  hasModalOpenRef.current = hasModalOpen;
  const hasSelectionRef = useRef(hasSelection);
  hasSelectionRef.current = hasSelection;
  const outlineOpenRef = useRef(outlineOpen);
  outlineOpenRef.current = outlineOpen;
  const handlersRef = useRef({ toggleSidebar, toggleFocusMode, toggleTypewriterMode, exitFocusMode, openCommandMenu, toggleViewLayout, onExitCardEditing, clearSelection, closeOutline });
  handlersRef.current = { toggleSidebar, toggleFocusMode, toggleTypewriterMode, exitFocusMode, openCommandMenu, toggleViewLayout, onExitCardEditing, clearSelection, closeOutline };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const isMod = event.ctrlKey || event.metaKey;
      const { toggleSidebar, toggleFocusMode, toggleTypewriterMode, exitFocusMode, openCommandMenu, toggleViewLayout, onExitCardEditing, clearSelection, closeOutline } = handlersRef.current;

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
      } else if (event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey && (event.key === "v" || event.key === "V")) {
        event.preventDefault();
        toggleViewLayout?.();
      } else if (event.key === "Escape") {
        if (!hasModalOpenRef.current) {
          if (hasSelectionRef.current && clearSelection) {
            event.preventDefault();
            clearSelection();
          } else if (outlineOpenRef.current && closeOutline) {
            event.preventDefault();
            closeOutline();
          } else if (focusModeRef.current) {
            exitFocusMode();
          } else if (isCardEditingRef.current && onExitCardEditing) {
            event.preventDefault();
            onExitCardEditing();
          }
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
