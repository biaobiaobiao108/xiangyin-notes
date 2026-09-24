import { useEffect, useRef } from "react";

function matchesShortcutLetter(event: KeyboardEvent, letter: string) {
  return event.key.toLowerCase() === letter || event.code === `Key${letter.toUpperCase()}`;
}

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

export type WorkspaceKeyboardContext = {
  focusMode: boolean;
  hasModalOpen: boolean;
  outlineOpen?: boolean;
  isCardEditing?: boolean;
  hasSelection?: boolean;
  handlers: {
    toggleSidebar: () => void;
    toggleFocusMode: () => void;
    toggleTypewriterMode: () => void;
    exitFocusMode: () => void;
    openCommandMenu: (initialQuery?: string) => void;
    toggleViewLayout?: () => void;
    onExitCardEditing?: () => void;
    clearSelection?: () => void;
    closeOutline?: () => void;
  };
};

export function handleWorkspaceKeyDown(event: KeyboardEvent, ctx: WorkspaceKeyboardContext) {
  if (event.isComposing || event.keyCode === 229) return;
  const { handlers, focusMode, hasModalOpen, outlineOpen = false, isCardEditing = false, hasSelection = false } = ctx;
  const { toggleSidebar, toggleFocusMode, toggleTypewriterMode, exitFocusMode, openCommandMenu, toggleViewLayout, onExitCardEditing, clearSelection, closeOutline } = handlers;

  if (event.key === "Escape") {
    if (hasModalOpen) return;
    const target = event.target;
    if (typeof Element !== "undefined" && target instanceof Element && target.closest("dialog[open], [role='dialog']")) return;

    // 优先级 1: 如果处于沉浸模式，优先退出沉浸模式（不受正文 ProseMirror preventDefault 影响）
    if (focusMode) {
      event.preventDefault();
      exitFocusMode();
      return;
    }

    // 优先级 2: 如果大纲打开，关闭大纲
    if (outlineOpen && closeOutline) {
      event.preventDefault();
      closeOutline();
      return;
    }

    // 优先级 3: 如果在卡片视图编辑笔记，退出卡片编辑返回网格
    if (isCardEditing && onExitCardEditing) {
      event.preventDefault();
      onExitCardEditing();
      return;
    }

    // 优先级 4: 如果有多选状态，取消选择
    if (hasSelection && clearSelection) {
      event.preventDefault();
      clearSelection();
      return;
    }

    return;
  }

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
  } else if (event.altKey && event.shiftKey && matchesShortcutLetter(event, "t")) {
    event.preventDefault();
    toggleTypewriterMode();
  } else if (event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey && matchesShortcutLetter(event, "v")) {
    event.preventDefault();
    toggleViewLayout?.();
  }
}

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
      handleWorkspaceKeyDown(event, {
        focusMode: focusModeRef.current,
        hasModalOpen: hasModalOpenRef.current,
        outlineOpen: outlineOpenRef.current,
        isCardEditing: isCardEditingRef.current,
        hasSelection: hasSelectionRef.current,
        handlers: handlersRef.current,
      });
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
