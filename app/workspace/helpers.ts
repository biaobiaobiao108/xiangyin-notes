import { FileText, Inbox, Star, Trash2, UsersRound } from "lucide-react";
import { ApiError } from "../api";
import type { Note, NoteSummary, NoteView, Notebook } from "../../shared/types";

export const navItems: Array<{ id: NoteView; label: string; icon: typeof Inbox }> = [
  { id: "inbox", label: "收件箱", icon: Inbox },
  { id: "all", label: "全部笔记", icon: FileText },
  { id: "favorites", label: "收藏", icon: Star },
  { id: "shared", label: "已分享", icon: UsersRound },
  { id: "trash", label: "回收站", icon: Trash2 },
];

export const notebookColorOptions = ["#d96245", "#718077", "#5b7899", "#9c765f", "#aa6f8e", "#8b7c54", "#6b72a8", "#6f7d83"];

export type NoteDraft = Pick<Note, "id" | "version" | "title" | "contentMarkdown" | "notebookId" | "isFavorite" | "deletedAt">;

export function toNoteDraft(note: Note | NoteDraft): NoteDraft {
  return {
    id: note.id,
    version: note.version,
    title: note.title,
    contentMarkdown: note.contentMarkdown,
    notebookId: note.notebookId,
    isFavorite: note.isFavorite,
    deletedAt: note.deletedAt,
  };
}

export function errorMessage(reason: unknown, fallback: string) {
  return reason instanceof ApiError && reason.message ? reason.message : fallback;
}

export type NoteSort = "updated" | "created" | "title";

export function sortNotes(notes: NoteSummary[], sort: NoteSort) {
  return [...notes].sort((a, b) => sort === "created" ? b.createdAt - a.createdAt : sort === "title" ? (a.title || "未命名笔记").localeCompare(b.title || "未命名笔记", "zh-CN") : b.updatedAt - a.updatedAt);
}

export function filterOfflineNotes(notes: Note[], notebooks: Notebook[], view: NoteView, query: string, notebookId?: string) {
  if (view === "shared") return [];
  const notebookMap = new Map(notebooks.map((notebook) => [notebook.id, notebook]));
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  return notes.filter((note) => {
    if (view === "trash" ? note.deletedAt === null : note.deletedAt !== null) return false;
    if (view === "favorites" && !note.isFavorite) return false;
    if (view === "inbox" && !notebookMap.get(note.notebookId)?.isSystem) return false;
    if (notebookId && note.notebookId !== notebookId) return false;
    if (normalizedQuery && !`${note.title}\n${note.contentMarkdown}`.toLocaleLowerCase("zh-CN").includes(normalizedQuery)) return false;
    return true;
  });
}

export function viewLabel(view: NoteView) {
  return ({ all: "全部笔记", inbox: "收件箱", favorites: "收藏", shared: "已分享", trash: "回收站" })[view];
}

export function relativeDate(timestamp: number) {
  const delta = Math.floor(Date.now() / 1000) - timestamp;
  if (delta < 60) return "刚刚";
  if (delta < 3600) return `${Math.floor(delta / 60)} 分钟前`;
  if (delta < 86400) return `${Math.floor(delta / 3600)} 小时前`;
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(timestamp * 1000));
}

export function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(timestamp * 1000));
}
