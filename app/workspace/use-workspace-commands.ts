import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
} from "react";
import type { NavigateFunction } from "react-router";
import type { Note } from "../../shared/types";
import { api } from "../api";
import type { CommandId } from "../command-menu";
import { copyPlainText } from "../editor/code-block-copy";
import { installPwa, type PwaState } from "../pwa";
import type { ThemePreference } from "../theme";
import type { ViewLayout } from "./use-workspace-preferences";

export type UseWorkspaceCommandsOptions = {
  ready: boolean;
  selectedRef: MutableRefObject<Note | null>;
  splitSelectedRef: MutableRefObject<Note | null>;
  editorMarkdownReaderRef: MutableRefObject<((noteId: string) => string | null) | null>;
  searchRef: RefObject<HTMLInputElement | null>;
  activePane: "primary" | "secondary";
  splitNoteId: string | null;
  isMobileViewport: boolean;
  viewLayout: ViewLayout;
  pwaState: PwaState;
  flushPendingSaves: (mode: "now") => Promise<void>;
  hasUnsavedWork: () => boolean;
  createNoteInInbox: () => Promise<Note | null | void>;
  openMobileList: () => void;
  openMobileHome: () => void;
  openKanban: () => void | Promise<void>;
  handleToggleSplit: () => void;
  toggleViewLayout: () => void;
  toggleFocusMode: () => void;
  toggleAutoReadingMode: () => void;
  toggleTypewriterMode: () => void;
  toggleFavorite: () => void;
  moveToTrash: () => void;
  restoreFromTrash: () => void;
  handleExportImage: () => void;
  handleExportNote: () => Promise<void>;
  handleExportLibrary: () => Promise<void>;
  setSidebarCollapsed: Dispatch<SetStateAction<boolean>>;
  setThemePreference: (preference: ThemePreference) => void;
  setCommandOpen: Dispatch<SetStateAction<boolean>>;
  setCommandInitialQuery: Dispatch<SetStateAction<string>>;
  setTasksOpen: Dispatch<SetStateAction<boolean>>;
  setCardEditingNoteId: Dispatch<SetStateAction<string | null>>;
  setReplaceRequest: Dispatch<
    SetStateAction<{ noteId: string; token: number; query: string } | null>
  >;
  notifyInfo: (message: string) => void;
  notifyWarning: (message: string) => void;
  notifyError: (message: string) => void;
  navigate: NavigateFunction;
};

/** Encapsulates workspace command dispatch, logout, find/replace, and startup URL actions. */
export function useWorkspaceCommands({
  ready,
  selectedRef,
  splitSelectedRef,
  editorMarkdownReaderRef,
  searchRef,
  activePane,
  splitNoteId,
  isMobileViewport,
  viewLayout,
  pwaState,
  flushPendingSaves,
  hasUnsavedWork,
  createNoteInInbox,
  openMobileList,
  openMobileHome,
  openKanban,
  handleToggleSplit,
  toggleViewLayout,
  toggleFocusMode,
  toggleAutoReadingMode,
  toggleTypewriterMode,
  toggleFavorite,
  moveToTrash,
  restoreFromTrash,
  handleExportImage,
  handleExportNote,
  handleExportLibrary,
  setSidebarCollapsed,
  setThemePreference,
  setCommandOpen,
  setCommandInitialQuery,
  setTasksOpen,
  setCardEditingNoteId,
  setReplaceRequest,
  notifyInfo,
  notifyWarning,
  notifyError,
  navigate,
}: UseWorkspaceCommandsOptions) {
  const shortcutHandledRef = useRef(false);

  const openCommandMenu = useCallback(
    (initialQuery = "") => {
      setCommandInitialQuery(initialQuery);
      setCommandOpen(true);
    },
    [setCommandInitialQuery, setCommandOpen],
  );

  const openReplaceInCurrentNote = useCallback(() => {
    const note =
      activePane === "secondary" && splitNoteId ? splitSelectedRef.current : selectedRef.current;
    if (!note) {
      notifyWarning("当前未打开笔记，无法查找替换");
      return;
    }
    const selection = window.getSelection();
    const selectedText = selection?.anchorNode?.parentElement?.closest(".editor-panel")
      ? selection.toString()
      : "";
    setCommandOpen(false);
    setTasksOpen(false);
    if (!isMobileViewport && viewLayout === "cards" && !splitNoteId) setCardEditingNoteId(note.id);
    setReplaceRequest((current) => ({
      noteId: note.id,
      token: (current?.token ?? 0) + 1,
      query: selectedText.length <= 50 ? selectedText : "",
    }));
  }, [
    activePane,
    isMobileViewport,
    notifyWarning,
    selectedRef,
    setCardEditingNoteId,
    setCommandOpen,
    setReplaceRequest,
    setTasksOpen,
    splitNoteId,
    splitSelectedRef,
    viewLayout,
  ]);

  const copyNoteMarkdown = useCallback(async () => {
    const note = selectedRef.current;
    if (!note) return;
    const markdown = editorMarkdownReaderRef.current?.(note.id) ?? note.contentMarkdown;
    try {
      await copyPlainText(markdown);
      notifyInfo("笔记 Markdown 已复制");
    } catch {
      notifyError("复制失败，请检查浏览器剪贴板权限");
    }
  }, [editorMarkdownReaderRef, notifyError, notifyInfo, selectedRef]);

  const logout = useCallback(async () => {
    await flushPendingSaves("now");
    if (hasUnsavedWork()) {
      notifyWarning("仍有内容未保存，请稍后再退出");
      return;
    }
    try {
      await api.logout();
    } catch {
      notifyError("退出登录失败，请检查网络后重试");
      return;
    }
    navigate(`/login${window.location.search}`, { replace: true });
  }, [flushPendingSaves, hasUnsavedWork, navigate, notifyError, notifyWarning]);

  const command = useCallback(
    (id: CommandId) => {
      if (id === "logout") void logout();
      if (id === "new-note") void createNoteInInbox();
      if (id === "find-in-note") {
        const selectedText = window.getSelection()?.toString().trim() ?? "";
        const initial = selectedText && selectedText.length <= 50 ? selectedText : "";
        setCommandInitialQuery(initial);
        setCommandOpen(true);
      }
      if (id === "toggle-sidebar") {
        if (isMobileViewport) openMobileHome();
        else setSidebarCollapsed((value) => !value);
      }
      if (id === "toggle-split") handleToggleSplit();
      if (id === "toggle-view-layout") toggleViewLayout();
      if (id === "toggle-focus-mode") toggleFocusMode();
      if (id === "toggle-auto-reading") toggleAutoReadingMode();
      if (id === "toggle-typewriter-mode") toggleTypewriterMode();
      if (id === "set-theme-light") setThemePreference("light");
      if (id === "set-theme-dark") setThemePreference("dark");
      if (id === "set-theme-system") setThemePreference("system");
      if (id === "copy-note-markdown") void copyNoteMarkdown();
      if (id === "favorite") toggleFavorite();
      if (id === "open-kanban") void openKanban();
      if (id === "trash") moveToTrash();
      if (id === "restore") restoreFromTrash();
      if (id === "export-image") handleExportImage();
      if (id === "export-note") void handleExportNote();
      if (id === "export-library") void handleExportLibrary();
      if (id === "install-app") {
        if (pwaState.canInstall) void installPwa();
        else if (pwaState.showIosInstallHint && !pwaState.standalone)
          notifyInfo("请在 Safari 中点击分享，再选择“添加到主屏幕”");
      }
    },
    [
      copyNoteMarkdown,
      createNoteInInbox,
      handleExportImage,
      handleExportLibrary,
      handleExportNote,
      handleToggleSplit,
      isMobileViewport,
      logout,
      moveToTrash,
      notifyInfo,
      openKanban,
      openMobileHome,
      pwaState,
      restoreFromTrash,
      setCommandInitialQuery,
      setCommandOpen,
      setSidebarCollapsed,
      setThemePreference,
      toggleAutoReadingMode,
      toggleFavorite,
      toggleFocusMode,
      toggleTypewriterMode,
      toggleViewLayout,
    ],
  );

  useEffect(() => {
    if (!ready || shortcutHandledRef.current) return;
    const action = new URLSearchParams(window.location.search).get("action");
    if (action === "new-note") void createNoteInInbox();
    if (action === "search") {
      openMobileList();
      requestAnimationFrame(() => searchRef.current?.focus());
    }
    shortcutHandledRef.current = true;
    if (action)
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${window.location.hash}`,
      );
  }, [createNoteInInbox, openMobileList, ready, searchRef]);

  return { openCommandMenu, openReplaceInCurrentNote, logout, command };
}
