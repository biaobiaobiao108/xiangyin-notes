import type { Notebook } from "../shared/types";

export type CreateNoteCommand = {
  notebookId: string;
  notebookName: string;
  title: string;
};

export type CreateNoteCommandResult =
  | { kind: "match"; command: CreateNoteCommand }
  | { kind: "error"; message: string }
  | null;

const CREATE_NOTE_PREFIX = "新建";
const MAX_NOTE_TITLE_LENGTH = 200;

export function parseCreateNoteCommand(query: string, notebooks: Notebook[]): CreateNoteCommandResult {
  const input = query.trim();
  const prefixRemainder = input.slice(CREATE_NOTE_PREFIX.length);

  // Keep the existing “新建笔记” command working as a regular static command.
  if (!input.startsWith(CREATE_NOTE_PREFIX) || !/^\s/.test(prefixRemainder)) return null;

  const remainder = prefixRemainder.trimStart();
  if (!remainder) return { kind: "error", message: "请输入笔记本名称和笔记标题" };

  const notebook = [...notebooks]
    .filter((candidate) => remainder.startsWith(candidate.name) && (remainder.length === candidate.name.length || /\s/.test(remainder[candidate.name.length] ?? "")))
    .sort((left, right) => right.name.length - left.name.length)[0];

  if (!notebook) return { kind: "error", message: "找不到这个笔记本，请输入已有笔记本名称" };

  const title = remainder.slice(notebook.name.length).trim();
  if (!title) return { kind: "error", message: "请输入笔记标题" };
  if (title.length > MAX_NOTE_TITLE_LENGTH) return { kind: "error", message: "笔记标题不能超过 200 个字符" };

  return { kind: "match", command: { notebookId: notebook.id, notebookName: notebook.name, title } };
}

export type ParsedSearchCommand = {
  scope: "in-note";
  term: string;
};

const IN_NOTE_SEARCH_PREFIXES = ["搜索", "查找", "find"];

export function parseSearchPrefixCommand(query: string): ParsedSearchCommand | null {
  const trimmed = query.trimStart();
  if (!trimmed) return null;

  for (const prefix of IN_NOTE_SEARCH_PREFIXES) {
    if (trimmed.toLowerCase().startsWith(prefix.toLowerCase())) {
      const rest = trimmed.slice(prefix.length);
      if (/^[\s:：]/.test(rest)) {
        const term = rest.replace(/^[\s:：]+/u, "").trim();
        return { scope: "in-note", term };
      }
    }
  }

  return null;
}

export type MoveNoteCommandResult =
  | { kind: "list"; queryText: string; matches: Notebook[] }
  | { kind: "error"; message: string }
  | null;

const MOVE_NOTE_FULL_PREFIXES = ["移动至", "移动到", "move to"];
const MOVE_NOTE_SPACE_PREFIXES = ["移动", "move"];

function filterMatchingNotebooks(queryText: string, notebooks: Notebook[]): MoveNoteCommandResult {
  if (!queryText) {
    return { kind: "list", queryText: "", matches: notebooks };
  }
  const lower = queryText.toLowerCase();
  const matches = notebooks
    .filter((candidate) => candidate.name.toLowerCase().includes(lower))
    .sort((a, b) => {
      const aExact = a.name.toLowerCase() === lower;
      const bExact = b.name.toLowerCase() === lower;
      if (aExact && !bExact) return -1;
      if (!aExact && bExact) return 1;
      const aStarts = a.name.toLowerCase().startsWith(lower);
      const bStarts = b.name.toLowerCase().startsWith(lower);
      if (aStarts && !bStarts) return -1;
      if (!aStarts && bStarts) return 1;
      return a.name.localeCompare(b.name);
    });
  if (matches.length === 0) {
    return { kind: "error", message: `找不到名称包含“${queryText}”的笔记本` };
  }
  return { kind: "list", queryText, matches };
}

export function parseMoveNoteCommand(query: string, notebooks: Notebook[]): MoveNoteCommandResult {
  const trimmed = query.trimStart();
  if (!trimmed) return null;

  for (const prefix of MOVE_NOTE_FULL_PREFIXES) {
    if (trimmed.toLowerCase().startsWith(prefix.toLowerCase())) {
      const rest = trimmed.slice(prefix.length);
      if (rest.length === 0 || /^[\s:：]/.test(rest)) {
        const queryText = rest.replace(/^[\s:：]+/u, "").trim();
        return filterMatchingNotebooks(queryText, notebooks);
      }
    }
  }

  for (const prefix of MOVE_NOTE_SPACE_PREFIXES) {
    if (trimmed.toLowerCase().startsWith(prefix.toLowerCase())) {
      const rest = trimmed.slice(prefix.length);
      if (/^[\s:：]/.test(rest)) {
        const queryText = rest.replace(/^[\s:：]+/u, "").trim();
        return filterMatchingNotebooks(queryText, notebooks);
      }
    }
  }

  return null;
}
