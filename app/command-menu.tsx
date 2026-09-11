import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Archive, Bookmark, Download, FilePlus2, FileText, Link2, Maximize2, PanelLeft, Search, Trash2, type LucideIcon } from "lucide-react";
import type { NoteSummary, Notebook } from "../shared/types";
import { parseCreateNoteCommand, type CreateNoteCommand } from "./command-parser";
import { modKey } from "./platform";

export type CommandId = "new-note" | "search" | "toggle-sidebar" | "toggle-focus-mode" | "share" | "favorite" | "trash" | "restore" | "install-app";

type CommandOption = {
  key: string;
  label: string;
  shortcut: string;
  icon: LucideIcon;
  kind: "command" | "create-note" | "note";
  id?: CommandId;
  createNote?: CreateNoteCommand;
  noteId?: string;
};

type CommandMenuProps = {
  open: boolean;
  onClose: () => void;
  onCommand: (id: CommandId) => void;
  onCreateNoteInNotebook: (command: CreateNoteCommand) => void;
  canRestore: boolean;
  notebooks: Notebook[];
  focusMode?: boolean;
  canInstallApp: boolean;
  showIosInstallHint: boolean;
  standalone: boolean;
  noteResults: NoteSummary[];
  noteSearchLoading: boolean;
  onSearchQueryChange: (query: string) => void;
  onOpenSearchResult: (noteId: string, query: string) => void;
};

export function CommandMenu({ open, onClose, onCommand, onCreateNoteInNotebook, canRestore, notebooks, focusMode = false, canInstallApp, showIosInstallHint, standalone, noteResults, noteSearchLoading, onSearchQueryChange, onOpenSearchResult }: CommandMenuProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const commands = useMemo<Array<{ id: CommandId; label: string; shortcut: string; icon: LucideIcon }>>(() => [
    { id: "new-note", label: "新建笔记", shortcut: "↵", icon: FilePlus2 },
    { id: "search", label: "搜索笔记", shortcut: "↵", icon: Search },
    { id: "toggle-sidebar", label: "切换侧栏", shortcut: `${modKey} \\`, icon: PanelLeft },
    { id: "toggle-focus-mode", label: focusMode ? "退出沉浸模式" : "进入沉浸模式", shortcut: `${modKey} ⇧ F`, icon: Maximize2 },
    { id: "share", label: "分享笔记", shortcut: "↵", icon: Link2 },
    { id: "favorite", label: "切换收藏", shortcut: "↵", icon: Bookmark },
    { id: "trash", label: "移入回收站", shortcut: "↵", icon: Trash2 },
    { id: "restore", label: "恢复笔记", shortcut: "↵", icon: Archive },
    ...(!standalone && (canInstallApp || showIosInstallHint) ? [{ id: "install-app" as const, label: "安装象映笔记", shortcut: "↵", icon: Download }] : []),
  ], [canInstallApp, focusMode, showIosInstallHint, standalone]);
  const createNoteResult = useMemo(() => parseCreateNoteCommand(query, notebooks), [notebooks, query]);
  const filtered = useMemo(() => commands
    .filter((command) => (command.id !== "restore" || canRestore) && (command.label.includes(query.trim()) || command.id.includes(query.trim().toLowerCase())))
    .map((command) => ({ ...command, key: command.id, kind: "command" as const })), [canRestore, commands, query]);
  const noteOptions = useMemo<CommandOption[]>(() => query.trim() ? noteResults.map((note) => ({
    key: `note:${note.id}`,
    label: note.title || "未命名笔记",
    shortcut: "↵",
    icon: FileText,
    kind: "note",
    noteId: note.id,
  })) : [], [noteResults, query]);
  const options = useMemo<CommandOption[]>(() => createNoteResult?.kind === "match"
    ? [{ key: "create-note-in-notebook", label: `在“${createNoteResult.command.notebookName}”中新建“${createNoteResult.command.title}”`, shortcut: "Enter", icon: FilePlus2, kind: "create-note", createNote: createNoteResult.command }]
    : [...filtered, ...noteOptions], [createNoteResult, filtered, noteOptions]);
  const createNoteError = createNoteResult?.kind === "error" ? createNoteResult.message : "";

  const updateQuery = (next: string) => {
    setQuery(next);
    setSelected(0);
    onSearchQueryChange(next);
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      setQuery("");
      setSelected(0);
      onSearchQueryChange("");
      requestAnimationFrame(() => searchRef.current?.focus());
    }
    if (!open && dialog.open) {
      dialog.close();
      onSearchQueryChange("");
    }
  }, [onSearchQueryChange, open]);

  useEffect(() => {
    setSelected((current) => Math.min(current, Math.max(options.length - 1, 0)));
  }, [options.length]);

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
        const option = options[selected];
        if (option.createNote) onCreateNoteInNotebook(option.createNote);
        else if (option.noteId) onOpenSearchResult(option.noteId, query.trim());
        else if (option.id) onCommand(option.id);
        onClose();
      }
    };
    dialog.addEventListener("keydown", onKeyDown);
    return () => dialog.removeEventListener("keydown", onKeyDown);
  }, [onClose, onCommand, onCreateNoteInNotebook, onOpenSearchResult, options, query, selected]);

  const execute = (option: CommandOption) => {
    if (option.createNote) onCreateNoteInNotebook(option.createNote);
    else if (option.noteId) onOpenSearchResult(option.noteId, query.trim());
    else if (option.id) onCommand(option.id);
    onClose();
  };

  let previousSection = "";

  return (
    <dialog ref={dialogRef} className="command-dialog" aria-labelledby="command-menu-title" onCancel={(event) => { event.preventDefault(); onClose(); }}>
      <div className="command-dialog-header"><h2 id="command-menu-title">命令菜单</h2><kbd>Esc</kbd></div>
      <div className="command-search-wrap"><Search size={18} aria-hidden="true" /><input ref={searchRef} value={query} onChange={(event) => updateQuery(event.target.value)} placeholder="输入命令或搜索笔记……" aria-label="搜索命令或笔记" /></div>
      <div className="command-list" role="listbox" aria-label="命令和笔记搜索结果">
        {createNoteError ? <div className="command-feedback" role="status">{createNoteError}</div> : options.length ? options.map((command, index) => {
          const Icon = command.icon;
          const section = command.kind === "note" ? "笔记" : command.kind === "create-note" ? "操作" : "命令";
          const heading = section !== previousSection ? <div className="command-section-label" key={`${command.key}-section`}>{section}</div> : null;
          const note = command.noteId ? noteResults.find((item) => item.id === command.noteId) : undefined;
          const noteDetail = note ? [note.preview, note.notebookName].filter(Boolean).join(" · ") : "";
          previousSection = section;
          return <Fragment key={command.key}>{heading}<button type="button" className={`command-row ${command.kind === "note" ? "command-row--note" : ""} ${selected === index ? "is-selected" : ""}`} role="option" aria-selected={selected === index} onMouseEnter={() => setSelected(index)} onClick={() => execute(command)}><Icon size={18} /><span className="command-row-content"><span className="command-row-label">{command.label}</span>{note && <span className="command-row-detail">{noteDetail}</span>}</span><kbd>{command.shortcut}</kbd></button></Fragment>;
        }) : query.trim() && noteSearchLoading ? <div className="command-search-status" role="status">正在搜索笔记……</div> : <div className="command-empty">{query.trim() ? "没有匹配的命令或笔记" : "没有可用的命令"}</div>}
        {query.trim() && noteSearchLoading && options.length > 0 && <div className="command-search-status" role="status">正在搜索笔记……</div>}
      </div>
      <div className="command-footer"><span><Archive size={14} />使用 ↑ ↓ 选择</span><span>Enter 打开 · F3 查找下一处</span></div>
    </dialog>
  );
}
