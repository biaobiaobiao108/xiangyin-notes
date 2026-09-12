import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Archive, Bookmark, Download, FilePlus2, FileSearch, FileText, Link2, Maximize2, PanelLeft, Search, Trash2, type LucideIcon } from "lucide-react";
import type { NoteSummary, Notebook } from "../shared/types";
import { parseCreateNoteCommand, parseSearchPrefixCommand, type CreateNoteCommand } from "./command-parser";
import { FloatingScrollbar } from "./floating-scrollbar";
import { modKey } from "./platform";

export type CommandId = "new-note" | "search" | "find-in-note" | "toggle-sidebar" | "toggle-focus-mode" | "share" | "favorite" | "trash" | "restore" | "install-app";

type CommandOption = {
  key: string;
  label: string;
  shortcut: string;
  icon: LucideIcon;
  kind: "command" | "create-note" | "note" | "in-note-search";
  id?: CommandId;
  createNote?: CreateNoteCommand;
  noteId?: string;
  searchTerm?: string;
  detail?: string;
};

type CommandMenuProps = {
  open: boolean;
  onClose: () => void;
  onCommand: (id: CommandId) => void;
  onCreateNoteInNotebook: (command: CreateNoteCommand) => void;
  canRestore: boolean;
  canMoveToTrash: boolean;
  notebooks: Notebook[];
  focusMode?: boolean;
  canInstallApp: boolean;
  showIosInstallHint: boolean;
  standalone: boolean;
  noteResults: NoteSummary[];
  noteSearchLoading: boolean;
  onSearchQueryChange: (query: string) => void;
  onOpenSearchResult: (noteId: string, query: string) => void;
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
  focusMode = false,
  canInstallApp,
  showIosInstallHint,
  standalone,
  noteResults,
  noteSearchLoading,
  onSearchQueryChange,
  onOpenSearchResult,
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
    ...(hasSelectedNote ? [{ id: "find-in-note" as const, label: "在当前笔记中查找", shortcut: `${modKey} F`, icon: FileSearch }] : []),
    { id: "search", label: "全局搜索笔记", shortcut: `${modKey} /`, icon: Search },
    { id: "toggle-sidebar", label: "切换侧栏", shortcut: `${modKey} \\`, icon: PanelLeft },
    { id: "toggle-focus-mode", label: focusMode ? "退出沉浸模式" : "进入沉浸模式", shortcut: `${modKey} ⇧ F`, icon: Maximize2 },
    ...(hasSelectedNote ? [{ id: "share" as const, label: "分享笔记", shortcut: "↵", icon: Link2 }] : []),
    ...(hasSelectedNote ? [{ id: "favorite" as const, label: "切换收藏", shortcut: "↵", icon: Bookmark }] : []),
    ...(canMoveToTrash ? [{ id: "trash" as const, label: "移入回收站", shortcut: "↵", icon: Trash2 }] : []),
    ...(canRestore ? [{ id: "restore" as const, label: "恢复笔记", shortcut: "↵", icon: Archive }] : []),
    ...(!standalone && (canInstallApp || showIosInstallHint) ? [{ id: "install-app" as const, label: "安装象映笔记", shortcut: "↵", icon: Download }] : []),
  ], [canInstallApp, canMoveToTrash, canRestore, focusMode, hasSelectedNote, showIosInstallHint, standalone]);

  const createNoteResult = useMemo(() => parseCreateNoteCommand(query, notebooks), [notebooks, query]);
  const parsedSearchPrefix = useMemo(() => parseSearchPrefixCommand(query), [query]);

  const filteredCommands = useMemo(() => {
    if (parsedSearchPrefix) return [];
    return commands
      .filter((command) => command.label.includes(query.trim()) || command.id.includes(query.trim().toLowerCase()))
      .map((command) => ({ ...command, key: command.id, kind: "command" as const }));
  }, [commands, parsedSearchPrefix, query]);

  const effectiveSearchTerm = parsedSearchPrefix ? parsedSearchPrefix.term : query.trim();

  const noteOptions = useMemo<CommandOption[]>(() => effectiveSearchTerm ? noteResults.map((note) => ({
    key: `note:${note.id}`,
    label: note.title || "未命名笔记",
    shortcut: "↵",
    icon: FileText,
    kind: "note",
    noteId: note.id,
    searchTerm: effectiveSearchTerm,
  })) : [], [effectiveSearchTerm, noteResults]);

  const options = useMemo<CommandOption[]>(() => {
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
      ...(inNoteOption ? [inNoteOption] : []),
      ...filteredCommands,
      ...noteOptions,
    ];
  }, [createNoteResult, effectiveSearchTerm, filteredCommands, hasSelectedNote, noteOptions]);

  const createNoteError = createNoteResult?.kind === "error" ? createNoteResult.message : "";

  const updateQuery = (next: string) => {
    setQuery(next);
    setSelected(0);
    const prefix = parseSearchPrefixCommand(next);
    const term = prefix ? prefix.term : next.trim();
    onSearchQueryChange(term);
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
      const prefix = parseSearchPrefixCommand(nextQuery);
      const term = prefix ? prefix.term : nextQuery.trim();
      onSearchQueryChange(term);
      requestAnimationFrame(() => {
        searchRef.current?.focus();
        if (nextQuery) {
          searchRef.current?.select();
        }
      });
    }
    if (!open && dialog.open) {
      dialog.close();
      onSearchQueryChange("");
      const target = returnFocusRef.current;
      returnFocusRef.current = null;
      if (target?.isConnected) target.focus({ preventScroll: true });
    }
  }, [initialQuery, onSearchQueryChange, open]);

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
    } else if (option.kind === "in-note-search" && option.searchTerm) {
      onSearchInCurrentNote?.(option.searchTerm);
    } else if (option.noteId) {
      onOpenSearchResult(option.noteId, option.searchTerm || query.trim());
    } else if (option.id === "find-in-note") {
      setQuery("搜索 ");
      setSelected(0);
      onSearchQueryChange("");
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
          placeholder={hasSelectedNote ? "输入命令、关键词或在当前笔记中查找……" : "输入命令或搜索笔记……"}
          aria-label="搜索命令或笔记"
        />
      </div>
      <div className="command-list-wrap">
        <div
          id="command-list-scroll-region"
          ref={listRef}
          className="command-list floating-scrollbar-target"
          role="listbox"
          aria-label="命令和笔记搜索结果"
        >
          {createNoteError ? <div className="command-feedback" role="status">{createNoteError}</div> : options.length ? options.map((command, index) => {
            const Icon = command.icon;
            const section = command.kind === "note" ? "笔记" : command.kind === "create-note" ? "操作" : command.kind === "in-note-search" ? "搜索" : "命令";
            const heading = section !== previousSection ? <div className="command-section-label" key={`${command.key}-section`}>{section}</div> : null;
            const note = command.noteId ? noteResults.find((item) => item.id === command.noteId) : undefined;
            const noteDetail = note ? [note.preview, note.notebookName].filter(Boolean).join(" · ") : command.detail || "";
            previousSection = section;
            return (
              <Fragment key={command.key}>
                {heading}
                <button
                  type="button"
                  className={`command-row ${command.kind === "note" ? "command-row--note" : ""} ${command.kind === "in-note-search" ? "command-row--search" : ""} ${selected === index ? "is-selected" : ""}`}
                  role="option"
                  aria-selected={selected === index}
                  onMouseEnter={() => setSelected(index)}
                  onClick={() => execute(command)}
                >
                  <Icon size={18} />
                  <span className="command-row-content">
                    <span className="command-row-label">{command.label}</span>
                    {noteDetail && <span className="command-row-detail">{noteDetail}</span>}
                  </span>
                  <kbd>{command.shortcut}</kbd>
                </button>
              </Fragment>
            );
          }) : query.trim() && noteSearchLoading ? <div className="command-search-status" role="status">正在搜索笔记……</div> : <div className="command-empty">{query.trim() ? "没有匹配的命令或笔记" : "没有可用的命令"}</div>}
          {query.trim() && noteSearchLoading && options.length > 0 && <div className="command-search-status" role="status">正在搜索笔记……</div>}
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
