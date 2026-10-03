import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type SyntheticEvent } from "react";
import { AlignVerticalSpaceAround, Archive, Bookmark, Check, Copy, Download, FilePlus2, FileSearch, FolderInput, ImageDown, LayoutGrid, Maximize2, Monitor, Moon, PanelLeft, Search, Sun, Trash2, X, type LucideIcon } from "lucide-react";
import type { Notebook } from "../shared/types";
import { parseCreateNoteCommand, parseMoveNoteCommand, parseSearchPrefixCommand, type CreateNoteCommand } from "./command-parser";
import { FloatingScrollbar } from "./floating-scrollbar";
import { altKey, modKey } from "./platform";
import type { ThemePreference } from "./theme";

export type CommandId = "new-note" | "search-notes" | "find-in-note" | "toggle-sidebar" | "toggle-view-layout" | "toggle-focus-mode" | "toggle-typewriter-mode" | "set-theme-light" | "set-theme-dark" | "set-theme-system" | "copy-note-markdown" | "favorite" | "trash" | "restore" | "install-app" | "move-to-notebook" | "export-notes" | "export-image";

type CommandOption = {
  key: string;
  label: string;
  shortcut: string;
  icon: LucideIcon;
  kind: "command" | "create-note" | "in-note-search" | "global-search" | "move-note";
  id?: CommandId;
  createNote?: CreateNoteCommand;
  searchTerm?: string;
  detail?: string;
  isCurrent?: boolean;
  notebook?: Notebook;
};

type CommandMenuProps = {
  open: boolean;
  onClose: () => void;
  onCommand: (id: CommandId) => void;
  onCreateNoteInNotebook: (command: CreateNoteCommand) => void;
  canRestore: boolean;
  canMoveToTrash: boolean;
  notebooks: Notebook[];
  currentNotebookId?: string;
  onMoveNoteToNotebook?: (notebookId: string) => void;
  focusMode?: boolean;
  typewriterMode?: boolean;
  viewLayout?: "three-column" | "cards";
  isMobileViewport?: boolean;
  canInstallApp: boolean;
  showIosInstallHint: boolean;
  standalone: boolean;
  hasSelectedNote?: boolean;
  onSearchInCurrentNote?: (term: string) => void;
  onSearchGlobal?: (term: string) => void;
  onFocusGlobalSearch?: () => void;
  initialQuery?: string;
  themePreference: ThemePreference;
};

export function CommandMenu({
  open,
  onClose,
  onCommand,
  onCreateNoteInNotebook,
  canRestore,
  canMoveToTrash,
  notebooks,
  currentNotebookId,
  onMoveNoteToNotebook,
  focusMode = false,
  typewriterMode = false,
  viewLayout = "three-column",
  isMobileViewport = false,
  canInstallApp,
  showIosInstallHint,
  standalone,
  hasSelectedNote = false,
  onSearchInCurrentNote,
  onSearchGlobal,
  onFocusGlobalSearch,
  initialQuery = "",
  themePreference,
}: CommandMenuProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const ignoreNextCancelRef = useRef(false);
  const ignoreNextCancelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const lastMousePositionRef = useRef<{ x: number; y: number } | null>(null);
  const mobileTouchScrollingRef = useRef(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);

  const commands = useMemo<Array<{ id: CommandId; label: string; shortcut: string; icon: LucideIcon; detail?: string; isCurrent?: boolean; keywords?: string }>>(() => [
    { id: "new-note", label: "新建笔记", shortcut: "↵", icon: FilePlus2 },
    { id: "search-notes" as const, label: "全局搜索笔记", shortcut: "↵", icon: Search },
    ...(hasSelectedNote && canMoveToTrash ? [{ id: "move-to-notebook" as const, label: "移动到笔记本", shortcut: "↵", icon: FolderInput }] : []),
    ...(hasSelectedNote ? [{ id: "find-in-note" as const, label: "在当前笔记中查找", shortcut: `${modKey} F`, icon: FileSearch }] : []),
    { id: "toggle-sidebar", label: isMobileViewport ? "返回笔记本首页" : "切换侧栏", shortcut: `${modKey} \\`, icon: PanelLeft },
    { id: "toggle-view-layout", label: viewLayout === "cards" ? isMobileViewport ? "切换到列表视图" : "切换到三栏列表视图" : "切换到卡片网格视图", shortcut: `${altKey} V`, icon: LayoutGrid },
    { id: "toggle-focus-mode", label: focusMode ? "退出沉浸模式" : "进入沉浸模式", shortcut: `${modKey} ⇧ F`, icon: Maximize2 },
    { id: "toggle-typewriter-mode", label: typewriterMode ? "退出打字机模式" : "开启打字机模式", shortcut: `${altKey} ⇧ T`, icon: AlignVerticalSpaceAround },
    { id: "set-theme-light", label: "浅色模式", shortcut: "↵", icon: Sun, isCurrent: themePreference === "light", keywords: "主题 外观" },
    { id: "set-theme-dark", label: "深色模式", shortcut: "↵", icon: Moon, isCurrent: themePreference === "dark", keywords: "主题 外观 tokyo night" },
    { id: "set-theme-system", label: "外观跟随系统", shortcut: "↵", icon: Monitor, isCurrent: themePreference === "system", keywords: "主题 外观 系统 跟随系统" },
    ...(hasSelectedNote ? [{ id: "copy-note-markdown" as const, label: "复制当前笔记 Markdown", shortcut: "↵", icon: Copy, keywords: "复制 正文 全文 markdown" }] : []),
    ...(hasSelectedNote ? [{ id: "export-image" as const, label: "导出图片", shortcut: "↵", icon: ImageDown, keywords: "PNG 图片 导出" }] : []),
    ...(hasSelectedNote ? [{ id: "favorite" as const, label: "切换收藏", shortcut: "↵", icon: Bookmark }] : []),
    ...(canMoveToTrash ? [{ id: "trash" as const, label: "移入回收站", shortcut: "↵", icon: Trash2 }] : []),
    ...(canRestore ? [{ id: "restore" as const, label: "恢复笔记", shortcut: "↵", icon: Archive }] : []),
    { id: "export-notes" as const, label: "导出全部笔记 (ZIP)", shortcut: "↵", icon: Download },
    ...(!standalone && (canInstallApp || showIosInstallHint) ? [{ id: "install-app" as const, label: "安装象映笔记", shortcut: "↵", icon: Download }] : []),
  ], [canInstallApp, canMoveToTrash, canRestore, focusMode, hasSelectedNote, isMobileViewport, showIosInstallHint, standalone, themePreference, typewriterMode, viewLayout]);

  const createNoteResult = useMemo(() => parseCreateNoteCommand(query, notebooks), [notebooks, query]);
  const parsedSearchPrefix = useMemo(() => parseSearchPrefixCommand(query), [query]);
  const moveNoteResult = useMemo(() => hasSelectedNote && canMoveToTrash ? parseMoveNoteCommand(query, notebooks) : null, [canMoveToTrash, hasSelectedNote, notebooks, query]);

  const filteredCommands = useMemo(() => {
    if (parsedSearchPrefix || moveNoteResult?.kind === "list") return [];
    const term = query.trim();
    return commands
      .filter((command) => command.label.includes(term) || command.id.includes(term.toLowerCase()) || command.keywords?.includes(term))
      .map((command) => ({ ...command, key: command.id, kind: "command" as const }));
  }, [commands, moveNoteResult, parsedSearchPrefix, query]);

  const options = useMemo<CommandOption[]>(() => {
    if (moveNoteResult?.kind === "list") {
      return moveNoteResult.matches.map((notebook) => {
        const isCurrent = notebook.id === currentNotebookId;
        return {
          key: `move-notebook:${notebook.id}`,
          label: `移动至“${notebook.name}”`,
          shortcut: "↵",
          icon: FolderInput,
          kind: "move-note" as const,
          notebook,
          detail: isCurrent ? "当前所在笔记本" : notebook.isSystem ? "系统内置" : "",
        };
      });
    }

    if (createNoteResult?.kind === "match") {
      return [{
        key: "create-note-in-notebook",
        label: `在“${createNoteResult.command.notebookName}”中新建“${createNoteResult.command.title}”`,
        shortcut: "Enter",
        icon: FilePlus2,
        kind: "create-note",
        createNote: createNoteResult.command,
      }];
    }

    if (parsedSearchPrefix) {
      const term = parsedSearchPrefix.term;
      if (!term) return [];
      if (parsedSearchPrefix.scope === "in-note") {
        return [{
          key: "action:in-note-search",
          label: `在当前笔记中查找“${term}”`,
          shortcut: "↵",
          icon: FileSearch,
          kind: "in-note-search",
          searchTerm: term,
          detail: hasSelectedNote ? "在当前笔记中高亮并定位匹配项" : "当前未打开笔记",
        }];
      }
      if (parsedSearchPrefix.scope === "global") {
        return [{
          key: "action:global-search",
          label: `在全部笔记中搜索“${term}”`,
          shortcut: "↵",
          icon: Search,
          kind: "global-search",
          searchTerm: term,
          detail: "在全部笔记中全文检索并列出结果",
        }];
      }
    }

    return filteredCommands;
  }, [createNoteResult, currentNotebookId, filteredCommands, hasSelectedNote, moveNoteResult, parsedSearchPrefix]);

  const createNoteError = createNoteResult?.kind === "error" ? createNoteResult.message : "";
  const moveNoteError = moveNoteResult?.kind === "error" ? moveNoteResult.message : "";
  const feedbackMessage = createNoteError || moveNoteError;
  const emptySearchPrefix = Boolean(parsedSearchPrefix && !parsedSearchPrefix.term);

  const updateQuery = (next: string) => {
    mobileTouchScrollingRef.current = false;
    lastMousePositionRef.current = null;
    setQuery(next);
    setSelected(0);
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    let focusFrame = 0;
    if (open && !dialog.open) {
      mobileTouchScrollingRef.current = false;
      lastMousePositionRef.current = null;
      returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
      if (listRef.current) listRef.current.scrollTop = 0;
      const nextQuery = initialQuery ?? "";
      setQuery(nextQuery);
      setSelected(0);
      // Browsing commands on touch should not start a keyboard/viewport transition
      // while Safari is still creating the dialog's native scrolling layer.
      // An explicit search query still opens directly into search.
      if (!isMobileViewport || nextQuery) {
        focusFrame = requestAnimationFrame(() => {
          if (!dialog.open) return;
          searchRef.current?.focus(isMobileViewport ? { preventScroll: true } : undefined);
          if (nextQuery) searchRef.current?.select();
        });
      }
    }
    if (!open && dialog.open) {
      lastMousePositionRef.current = null;
      dialog.close();
      const target = returnFocusRef.current;
      returnFocusRef.current = null;
      if (target?.isConnected) target.focus({ preventScroll: true });
    }
    return () => cancelAnimationFrame(focusFrame);
  }, [initialQuery, isMobileViewport, open]);

  useEffect(() => {
    setSelected((current) => Math.min(current, Math.max(options.length - 1, 0)));
  }, [options.length]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;

    const alignSelectedRow = () => {
      // A touch scroll owns its position, including when the software keyboard closes.
      if (isMobileViewport && mobileTouchScrollingRef.current) return;
      const selectedElement = list.querySelector<HTMLElement>(".command-row.is-selected");
      if (!selectedElement) return;

      // Measure in layout coordinates so dialog animations and browser-specific
      // subpixel rounding cannot change the command list's scroll alignment.
      const selectedTop = selectedElement.offsetTop - list.offsetTop;
      const selectedBottom = selectedTop + selectedElement.offsetHeight;
      const endInset = Number.parseFloat(getComputedStyle(list).getPropertyValue("--command-list-bottom-inset")) || 0;
      const visibleTop = list.scrollTop + list.clientTop;
      const visibleBottom = list.scrollTop + list.clientHeight - endInset;

      if (selectedTop < visibleTop) {
        list.scrollTop = Math.max(0, selectedTop - list.clientTop);
      } else if (selectedBottom > visibleBottom) {
        list.scrollTop = selectedBottom + endInset - list.clientHeight;
      }
    };

    alignSelectedRow();
    if (typeof ResizeObserver === "undefined") return;
    const resizeObserver = new ResizeObserver(alignSelectedRow);
    resizeObserver.observe(list);
    return () => resizeObserver.disconnect();
  }, [isMobileViewport, selected]);

  const execute = useCallback((option: CommandOption) => {
    if (option.createNote) {
      onCreateNoteInNotebook(option.createNote);
    } else if (option.kind === "move-note" && option.notebook) {
      onMoveNoteToNotebook?.(option.notebook.id);
    } else if (option.kind === "in-note-search" && option.searchTerm) {
      onSearchInCurrentNote?.(option.searchTerm);
    } else if (option.kind === "global-search" && option.searchTerm) {
      onSearchGlobal?.(option.searchTerm);
    } else if (option.id === "search-notes") {
      setQuery("全局搜索 ");
      setSelected(0);
      searchRef.current?.focus();
      return;
    } else if (option.id === "find-in-note") {
      setQuery("搜索 ");
      setSelected(0);
      searchRef.current?.focus();
      return;
    } else if (option.id === "move-to-notebook") {
      setQuery("移动至 ");
      setSelected(0);
      searchRef.current?.focus();
      return;
    } else if (option.id) {
      onCommand(option.id);
    }
    onClose();
  }, [onClose, onCommand, onCreateNoteInNotebook, onMoveNoteToNotebook, onSearchInCurrentNote, onSearchGlobal]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && (event.isComposing || event.keyCode === 229)) {
        ignoreNextCancelRef.current = true;
        if (ignoreNextCancelTimerRef.current !== null) clearTimeout(ignoreNextCancelTimerRef.current);
        ignoreNextCancelTimerRef.current = setTimeout(() => {
          ignoreNextCancelRef.current = false;
          ignoreNextCancelTimerRef.current = null;
        }, 0);
        return;
      }
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        mobileTouchScrollingRef.current = false;
        lastMousePositionRef.current = null;
        setSelected((current) => Math.min(current + 1, Math.max(options.length - 1, 0)));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        mobileTouchScrollingRef.current = false;
        lastMousePositionRef.current = null;
        setSelected((current) => Math.max(current - 1, 0));
      } else if (event.key === "Enter" && !event.isComposing && event.keyCode !== 229 && options[selected]) {
        event.preventDefault();
        execute(options[selected]);
      }
    };
    dialog.addEventListener("keydown", onKeyDown);
    return () => {
      dialog.removeEventListener("keydown", onKeyDown);
      if (ignoreNextCancelTimerRef.current !== null) clearTimeout(ignoreNextCancelTimerRef.current);
      ignoreNextCancelTimerRef.current = null;
      ignoreNextCancelRef.current = false;
    };
  }, [execute, onClose, options, selected]);

  const handleRowMouseMove = (index: number, event: React.MouseEvent) => {
    if (!lastMousePositionRef.current) {
      // 记录初始指针坐标，不视为有效物理位移（防止打开瞬间直接命中鼠标下方命令）
      lastMousePositionRef.current = { x: event.clientX, y: event.clientY };
      return;
    }
    const deltaX = Math.abs(event.clientX - lastMousePositionRef.current.x);
    const deltaY = Math.abs(event.clientY - lastMousePositionRef.current.y);
    // 只有当指针在视口中真正发生物理位移（阈值 >= 4px）时，才视为用户主动使用鼠标浏览选择
    if (deltaX + deltaY >= 4) {
      lastMousePositionRef.current = { x: event.clientX, y: event.clientY };
      if (selected !== index) {
        setSelected(index);
      }
    }
  };

  const handleCancel = (event: SyntheticEvent<HTMLDialogElement>) => {
    event.preventDefault();
    if (ignoreNextCancelRef.current) {
      ignoreNextCancelRef.current = false;
      if (ignoreNextCancelTimerRef.current !== null) clearTimeout(ignoreNextCancelTimerRef.current);
      ignoreNextCancelTimerRef.current = null;
      return;
    }
    onClose();
  };

  let previousSection = "";

  return (
    <dialog ref={dialogRef} className={`command-dialog${isMobileViewport ? " command-dialog--mobile" : ""}`} aria-labelledby="command-menu-title" onCancel={handleCancel}>
      <div className="command-dialog-header"><h2 id="command-menu-title">命令菜单</h2>{isMobileViewport ? <button className="icon-button" type="button" aria-label="关闭命令面板" onClick={onClose}><X size={20} aria-hidden="true" /></button> : <kbd>Esc</kbd>}</div>
      <div className="command-search-wrap">
        <Search size={18} aria-hidden="true" />
        <input
          ref={searchRef}
          value={query}
          onChange={(event) => updateQuery(event.target.value)}
          aria-label="搜索命令或笔记内容"
        />
      </div>
      <div className="command-list-wrap">
        <div
          id="command-list-scroll-region"
          ref={listRef}
          className="command-list floating-scrollbar-target"
          role="listbox"
          aria-label="命令和笔记搜索结果"
          onPointerDownCapture={(event) => { if (isMobileViewport) mobileTouchScrollingRef.current = event.pointerType !== "mouse"; }}
        >
          {feedbackMessage ? <div className="command-feedback" role="status">{feedbackMessage}</div> : options.length ? options.map((command, index) => {
            const Icon = command.icon;
            const section = command.kind === "create-note" ? "操作"
              : (command.kind === "in-note-search" || command.kind === "global-search") ? "搜索"
              : command.kind === "move-note" ? "移动笔记"
              : "命令";
            const heading = section !== previousSection && section !== "命令" ? <div className="command-section-label" key={`${command.key}-section`}>{section}</div> : null;
            const commandDetail = command.detail || "";
            previousSection = section;
            return (
              <Fragment key={command.key}>
                {heading}
                <button
                  type="button"
                  className={`command-row ${command.kind === "in-note-search" || command.kind === "global-search" ? "command-row--search" : ""} ${selected === index ? "is-selected" : ""}`}
                  role="option"
                  aria-selected={selected === index}
                  onPointerDown={(event) => { if (!isMobileViewport || event.pointerType === "mouse") setSelected(index); }}
                  onMouseMove={(event) => { if (!isMobileViewport) handleRowMouseMove(index, event); }}
                  onClick={() => execute(command)}
                >
                  {command.kind === "move-note" && command.notebook ? (
                    <span className="notebook-dot" style={{ background: command.notebook.color, width: 10, height: 10, marginInline: 4 }} />
                  ) : (
                    <Icon size={18} />
                  )}
                  <span className="command-row-content">
                    <span className="command-row-label">{command.label}</span>
                    {commandDetail && <span className="command-row-detail">{commandDetail}</span>}
                  </span>
                  <span className="command-row-trailing">
                    {command.isCurrent && <span className="command-row-current" role="img" aria-label="当前主题"><Check size={16} aria-hidden="true" /></span>}
                    <kbd>{command.shortcut}</kbd>
                  </span>
                </button>
              </Fragment>
            );
          }) : <div className="command-empty">{emptySearchPrefix ? "请输入搜索关键词" : query.trim() ? "没有匹配的命令" : "没有可用的命令"}</div>}
        </div>
        <FloatingScrollbar
          scrollTargetRef={listRef}
          controlsId="command-list-scroll-region"
          ariaLabel="命令列表滚动条"
          placement="right"
        />
      </div>
    </dialog>
  );
}
