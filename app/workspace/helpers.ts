import {
  Book,
  Bookmark,
  Briefcase,
  Code,
  Compass,
  FileText,
  Folder,
  GraduationCap,
  Heart,
  Inbox,
  Lightbulb,
  Palette,
  Smile,
  Sparkles,
  Star,
  Tag,
  Terminal,
  Trash2,
  UsersRound,
} from "lucide-react";
import { ApiError } from "../api";
import type { Note, NoteSort, NoteSummary, NoteView, Notebook } from "../../shared/types";
import { extractTags } from "../../shared/tags";

export const navItems: Array<{ id: NoteView; label: string; icon: typeof Inbox }> = [
  { id: "inbox", label: "收件箱", icon: Inbox },
  { id: "all", label: "全部笔记", icon: FileText },
  { id: "favorites", label: "收藏", icon: Star },
  { id: "shared", label: "已分享", icon: UsersRound },
  { id: "trash", label: "回收站", icon: Trash2 },
];

export const notebookColorOptions = [
  "#d96245",
  "#718077",
  "#5b7899",
  "#9c765f",
  "#aa6f8e",
  "#8b7c54",
  "#4f8a78",
  "#c18a3d",
  "#c45b73",
];

export const notebookIconOptions = [
  { id: "folder", label: "文件夹", icon: Folder },
  { id: "book", label: "书本", icon: Book },
  { id: "bookmark", label: "书签", icon: Bookmark },
  { id: "file-text", label: "文档", icon: FileText },
  { id: "tag", label: "标签", icon: Tag },
  { id: "star", label: "星标", icon: Star },
  { id: "heart", label: "红心", icon: Heart },
  { id: "sparkles", label: "火花", icon: Sparkles },
  { id: "lightbulb", label: "灵感", icon: Lightbulb },
  { id: "compass", label: "探索", icon: Compass },
  { id: "code", label: "代码", icon: Code },
  { id: "terminal", label: "终端", icon: Terminal },
  { id: "briefcase", label: "工作", icon: Briefcase },
  { id: "graduation-cap", label: "学业", icon: GraduationCap },
  { id: "palette", label: "艺术", icon: Palette },
  { id: "smile", label: "生活", icon: Smile },
] as const;

export type NotebookIconId = (typeof notebookIconOptions)[number]["id"];

export function getNotebookIconComponent(iconId?: string) {
  const matched = notebookIconOptions.find((opt) => opt.id === iconId);
  return matched ? matched.icon : Folder;
}

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

export function toNoteSummary(note: Note): NoteSummary {
  const { contentMarkdown: _contentMarkdown, ...summary } = note;
  return summary;
}

export function errorMessage(reason: unknown, fallback: string) {
  return reason instanceof ApiError && reason.message ? reason.message : fallback;
}

export function getNoteTags(note: { tags?: string[]; contentMarkdown?: string }) {
  return Array.isArray(note.tags) ? note.tags : note.contentMarkdown ? extractTags(note.contentMarkdown) : [];
}

export type { NoteSort } from "../../shared/types";

export function sortNotes(notes: NoteSummary[], sort: NoteSort) {
  return [...notes].sort((a, b) => sort === "created" ? b.createdAt - a.createdAt : sort === "title" ? (a.title || "未命名笔记").localeCompare(b.title || "未命名笔记", "zh-CN") : b.updatedAt - a.updatedAt);
}

export function shouldKeepActiveNoteInList(note: Note, notebooks: Notebook[], view: NoteView, query: string, notebookId?: string) {
  // Search and shared membership are server-derived. Re-inserting the active note
  // there would make an unrelated note look like a search result or active share.
  if (query.trim() || view === "shared") return false;
  if (view === "trash") return note.deletedAt !== null;
  if (note.deletedAt !== null) return false;
  if (notebookId) return note.notebookId === notebookId;
  if (view === "favorites") return note.isFavorite;
  if (view === "inbox") return Boolean(notebooks.find((notebook) => notebook.id === note.notebookId)?.isSystem);
  return view === "all";
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
