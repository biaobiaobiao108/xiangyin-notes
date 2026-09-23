import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { AlignVerticalSpaceAround, Archive, Bookmark, Download, FilePlus2, FileSearch, FolderInput, LayoutGrid, Link2, Maximize2, PanelLeft, Search, Trash2, type LucideIcon } from "lucide-react";
import type { Notebook } from "../shared/types";
import { parseCreateNoteCommand, parseMoveNoteCommand, parseSearchPrefixCommand, type CreateNoteCommand } from "./command-parser";
import { FloatingScrollbar } from "./floating-scrollbar";
import { altKey, modKey } from "./platform";

export type CommandId = "new-note" | "find-in-note" | "toggle-sidebar" | "toggle-view-layout" | "toggle-focus-mode" | "toggle-typewriter-mode" | "share" | "favorite" | "trash" | "restore" | "install-app" | "move-to-notebook" | "export-notes";

type CommandOption = {
  key: string;
  label: string;
  shortcut: string;
  icon: LucideIcon;
  kind: "command" | "create-note" | "in-note-search" | "move-note";
  id?: CommandId;
  createNote?: CreateNoteCommand;
  searchTerm?: string;
  detail?: string;
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
  canInstallApp: boolean;
  showIosInstallHint: boolean;
  standalone: boolean;
  hasSelectedNote?: boolean;
  onSearchInCurrentNote?: (term: string) => void;
  initialQuery?: string;
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
  canInstallApp,
  showIosInstallHint,
  standalone,
  hasSelectedNote = false,
  onSearchInCurrentNote,
  initialQuery = "",
}: CommandMenuProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);

  const commands = useMemo<Array<{ id: CommandId; label: string; shortcut: string; icon: LucideIcon }>>(() => [
    { id: "new-note", label: "新建笔记", shortcut: "↵", icon: FilePlus2 },
    ...(hasSelectedNote && canMoveToTrash ? [{ id: "move-to-notebook" as const, label: "移动到笔记本", shortcut: "↵", icon: FolderInput }] : []),
    ...(hasSelectedNote ? [{ id: "find-in-note" as const, label: "在当前笔记中查找", shortcut: `${modKey} F`, icon: FileSearch }] : []),
    { id: "toggle-sidebar", label: "切换侧栏", shortcut: `${modKey} \\`, icon: PanelLeft },
    { id: "toggle-view-layout" as const, label: viewLayout === "cards" ? "切换到三栏列表视图" : "切换到卡片网格视图", shortcut: `${altKey} V`, icon: LayoutGrid },
    { id: "toggle-focus-mode", label: focusMode ? "退出沉浸模式" : "进入沉浸模式", shortcut: `${modKey} ⇧ F`, icon: Maximize2 },
    { id: "toggle-typewriter-mode", label: typewriterMode ? "退出打字机模式" : "开启打字机模式", shortcut: `${altKey} ⇧ T`, icon: AlignVerticalSpaceAround },
    ...(hasSelectedNote ? [{ id: "share" as const, label: "分享笔记", shortcut: "↵", icon: Link2 }] : []),
    ...(hasSelectedNote ? [{ id: "favorite" as const, label: "切换收藏", shortcut: "↵", icon: Bookmark }] : []),
    ...(canMoveToTrash ? [{ id: "trash" as const, label: "移入回收站", shortcut: "↵", icon: Trash2 }] : []),
    ...(canRestore ? [{ id: "restore" as const, label: "恢复笔记", shortcut: "↵", icon: Archive }] : []),
    { id: "export-notes" as const, label: "导出全部笔记 (ZIP)", shortcut: "↵", icon: Download },
    ...(!standalone && (canInstallApp || showIosInstallHint) ? [{ id: "install-app" as const, label: "安装象映笔记", shortcut: "↵", icon: Download }] : []),
  ], [canInstallApp, canMoveToTrash, canRestore, focusMode, hasSelectedNote, showIosInstallHint, standalone, typewriterMode, viewLayout]);

  const createNoteResult = useMemo(() => parseCreateNoteCommand(query, notebooks), [notebooks, query]);
  const parsedSearchPrefix = useMemo(() => parseSearchPrefixCommand(query), [query]);
  const moveNoteResult = useMemo(() => hasSelectedNote && canMoveToTrash ? parseMoveNoteCommand(query, notebooks) : null, [canMoveToTrash, hasSelectedNote, notebooks, query]);

  const filteredCommands = useMemo(() => {
    if (parsedSearchPrefix || moveNoteResult?.kind === "list") return [];
    return commands
      .filter((command) => command.label.includes(query.trim()) || command.id.includes(query.trim().toLowerCase()))
      .map((command) => ({ ...command, key: command.id, kind: "command" as const }));
  }, [commands, moveNoteResult, parsedSearchPrefix, query]);

  const effectiveSearchTerm = parsedSearchPrefix ? parsedSearchPrefix.term : query.trim();

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

    if (!effectiveSearchTerm) {
      return filteredCommands;
    }

    const inNoteOption: CommandOption | null = hasSelectedNote ? {
      key: "action:in-note-search",
      label: `在当前笔记中查找“${effectiveSearchTerm}”`,
      shortcut: "↵",
      icon: FileSearch,
      kind: "in-note-search",
      searchTerm: effectiveSearchTerm,
      detail: "在当前笔记中高亮并定位匹配项",
    } : null;

    return [
      ...filteredCommands,
      ...(inNoteOption ? [inNoteOption] : []),
    ];
  }, [createNoteResult, currentNotebookId, effectiveSearchTerm, filteredCommands, hasSelectedNote, moveNoteResult]);

  const createNoteError = createNoteResult?.kind === "error" ? createNoteResult.message : "";
  const moveNoteError = moveNoteResult?.kind === "error" ? moveNoteResult.message : "";
  const feedbackMessage = createNoteError || moveNoteError;

  const updateQuery = (next: string) => {
    setQuery(next);
    setSelected(0);
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
      const nextQuery = initialQuery ?? "";
      setQuery(nextQuery);
      setSelected(0);
      requestAnimationFrame(() => {
        searchRef.current?.focus();
        if (nextQuery) {
          searchRef.current?.select();
        }
      });
    }
    if (!open && dialog.open) {
      dialog.close();
      const target = returnFocusRef.current;
      returnFocusRef.current = null;
      if (target?.isConnected) target.focus({ preventScroll: true });
    }
  }, [initialQuery, open]);

  useEffect(() => {
    setSelected((current) => Math.min(current, Math.max(options.length - 1, 0)));
  }, [options.length]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const selectedElement = list.querySelector<HTMLElement>(".command-row.is-selected");
    if (selectedElement) {
      selectedElement.scrollIntoView({ block: "nearest" });
    }
  }, [selected]);

  const execute = (option: CommandOption) => {
    if (option.createNote) {
      onCreateNoteInNotebook(option.createNote);
    } else if (option.kind === "move-note" && option.notebook) {
      onMoveNoteToNotebook?.(option.notebook.id);
    } else if (option.kind === "in-note-search" && option.searchTerm) {
      onSearchInCurrentNote?.(option.searchTerm);
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
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelected((current) => Math.min(current + 1, Math.max(options.length - 1, 0)));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelected((current) => Math.max(current - 1, 0));
      } else if (event.key === "Enter" && !event.isComposing && event.keyCode !== 229 && options[selected]) {
        event.preventDefault();
        execute(options[selected]);
      }
    };
    dialog.addEventListener("keydown", onKeyDown);
    return () => dialog.removeEventListener("keydown", onKeyDown);
  }, [execute, onClose, options, selected]);

  let previousSection = "";

  return (
    <dialog ref={dialogRef} className="command-dialog" aria-labelledby="command-menu-title" onCancel={(event) => { event.preventDefault(); onClose(); }}>
      <div className="command-dialog-header"><h2 id="command-menu-title">命令菜单</h2><kbd>Esc</kbd></div>
      <div className="command-search-wrap">
        <Search size={18} aria-hidden="true" />
        <input
          ref={searchRef}
          value={query}
          onChange={(event) => updateQuery(event.target.value)}
          placeholder={hasSelectedNote ? "输入命令或在当前笔记中查找……" : "输入命令……"}
          aria-label="搜索命令或当前笔记"
        />
      </div>
      <div className="command-list-wrap">
        <div
          id="command-list-scroll-region"
          ref={listRef}
          className="command-list floating-scrollbar-target"
          role="listbox"
          aria-label="命令和当前笔记搜索结果"
        >
          {feedbackMessage ? <div className="command-feedback" role="status">{feedbackMessage}</div> : options.length ? options.map((command, index) => {
            const Icon = command.icon;
            const section = command.kind === "create-note" ? "操作" : command.kind === "in-note-search" ? "搜索" : command.kind === "move-note" ? "移动笔记" : "命令";
            const heading = section !== previousSection ? <div className="command-section-label" key={`${command.key}-section`}>{section}</div> : null;
            const noteDetail = command.detail || "";
            previousSection = section;
            return (
              <Fragment key={command.key}>
                {heading}
                <button
                  type="button"
                  className={`command-row ${command.kind === "in-note-search" ? "command-row--search" : ""} ${selected === index ? "is-selected" : ""}`}
                  role="option"
                  aria-selected={selected === index}
                  onMouseEnter={() => setSelected(index)}
                  onClick={() => execute(command)}
                >
                  {command.kind === "move-note" && command.notebook ? (
                    <span className="notebook-dot" style={{ background: command.notebook.color, width: 10, height: 10, marginInline: 4 }} />
                  ) : (
                    <Icon size={18} />
                  )}
                  <span className="command-row-content">
                    <span className="command-row-label">{command.label}</span>
                    {noteDetail && <span className="command-row-detail">{noteDetail}</span>}
                  </span>
                  <kbd>{command.shortcut}</kbd>
                </button>
              </Fragment>
            );
          }) : <div className="command-empty">{query.trim() ? "没有匹配的命令" : "没有可用的命令"}</div>}
        </div>
        <FloatingScrollbar
          scrollTargetRef={listRef}
          controlsId="command-list-scroll-region"
          ariaLabel="命令列表滚动条"
          placement="right"
        />
      </div>
      <div className="command-footer"><span><Archive size={14} />使用 ↑ ↓ 选择</span><span>Enter 打开 · F3 查找下一处</span></div>
    </dialog>
  );
}
