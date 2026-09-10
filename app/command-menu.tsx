import { useEffect, useMemo, useRef, useState } from "react";
import { Archive, Bookmark, FilePlus2, Link2, PanelLeft, Search, Trash2, type LucideIcon } from "lucide-react";
import type { Notebook } from "../shared/types";
import { parseCreateNoteCommand, type CreateNoteCommand } from "./command-parser";
import { modKey } from "./platform";

export type CommandId = "new-note" | "search" | "toggle-sidebar" | "share" | "favorite" | "trash" | "restore";

const COMMANDS: Array<{ id: CommandId; label: string; shortcut: string; icon: LucideIcon }> = [
  { id: "new-note", label: "新建笔记", shortcut: "↵", icon: FilePlus2 },
  { id: "search", label: "搜索笔记", shortcut: "↵", icon: Search },
  { id: "toggle-sidebar", label: "切换侧栏", shortcut: `${modKey} \\`, icon: PanelLeft },
  { id: "share", label: "分享笔记", shortcut: "↵", icon: Link2 },
  { id: "favorite", label: "切换收藏", shortcut: "↵", icon: Bookmark },
  { id: "trash", label: "移入回收站", shortcut: "↵", icon: Trash2 },
  { id: "restore", label: "恢复笔记", shortcut: "↵", icon: Archive },
];

type CommandOption = {
  key: string;
  label: string;
  shortcut: string;
  icon: LucideIcon;
  id?: CommandId;
  createNote?: CreateNoteCommand;
};

type CommandMenuProps = {
  open: boolean;
  onClose: () => void;
  onCommand: (id: CommandId) => void;
  onCreateNoteInNotebook: (command: CreateNoteCommand) => void;
  canRestore: boolean;
  notebooks: Notebook[];
};

export function CommandMenu({ open, onClose, onCommand, onCreateNoteInNotebook, canRestore, notebooks }: CommandMenuProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const createNoteResult = useMemo(() => parseCreateNoteCommand(query, notebooks), [notebooks, query]);
  const filtered = useMemo(() => COMMANDS
    .filter((command) => (command.id !== "restore" || canRestore) && (command.label.includes(query.trim()) || command.id.includes(query.trim().toLowerCase())))
    .map((command) => ({ ...command, key: command.id })), [canRestore, query]);
  const options = useMemo<CommandOption[]>(() => createNoteResult?.kind === "match"
    ? [{ key: "create-note-in-notebook", label: `在“${createNoteResult.command.notebookName}”中新建“${createNoteResult.command.title}”`, shortcut: "Enter", icon: FilePlus2, createNote: createNoteResult.command }]
    : filtered, [createNoteResult, filtered]);
  const createNoteError = createNoteResult?.kind === "error" ? createNoteResult.message : "";

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      setQuery("");
      setSelected(0);
      requestAnimationFrame(() => searchRef.current?.focus());
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

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
        else if (option.id) onCommand(option.id);
        onClose();
      }
    };
    dialog.addEventListener("keydown", onKeyDown);
    return () => dialog.removeEventListener("keydown", onKeyDown);
  }, [onClose, onCommand, onCreateNoteInNotebook, options, selected]);

  const execute = (option: CommandOption) => {
    if (option.createNote) onCreateNoteInNotebook(option.createNote);
    else if (option.id) onCommand(option.id);
    onClose();
  };

  return (
    <dialog ref={dialogRef} className="command-dialog" aria-labelledby="command-menu-title" onCancel={(event) => { event.preventDefault(); onClose(); }}>
      <div className="command-dialog-header"><h2 id="command-menu-title">命令菜单</h2><kbd>Esc</kbd></div>
      <div className="command-search-wrap"><Search size={18} aria-hidden="true" /><input ref={searchRef} value={query} onChange={(event) => { setQuery(event.target.value); setSelected(0); }} placeholder="输入命令或搜索……" aria-label="搜索命令" /></div>
      <div className="command-list" role="listbox" aria-label="可用命令">
        {createNoteError ? <div className="command-feedback" role="status">{createNoteError}</div> : options.length ? options.map((command, index) => {
          const Icon = command.icon;
          return <button key={command.key} type="button" className={`command-row ${selected === index ? "is-selected" : ""}`} role="option" aria-selected={selected === index} onMouseEnter={() => setSelected(index)} onClick={() => execute(command)}><Icon size={18} /><span className="command-row-label">{command.label}</span><kbd>{command.shortcut}</kbd></button>;
        }) : <div className="command-empty">没有匹配的命令</div>}
      </div>
      <div className="command-footer"><span><Archive size={14} />使用 ↑ ↓ 选择</span><span>{modKey} / 打开</span></div>
    </dialog>
  );
}
