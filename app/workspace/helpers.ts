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
} from "lucide-react";
import { ApiError } from "../api";
import type { Note, NoteSummary, NoteView, Notebook } from "../../shared/types";
import { extractTags } from "../../shared/tags";

export const navItems: Array<{ id: NoteView; label: string; icon: typeof Inbox }> = [
  { id: "inbox", label: "收件箱", icon: Inbox },
  { id: "all", label: "全部笔记", icon: FileText },
  { id: "favorites", label: "收藏", icon: Star },
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

export type NoteDraft = Pick<
  Note,
  "id" | "version" | "title" | "contentMarkdown" | "notebookId" | "isFavorite" | "deletedAt"
>;

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

export function noteMetadataSnapshot(note: Note): Note {
  return { ...note, contentMarkdown: "" };
}

export function errorMessage(reason: unknown, fallback: string) {
  return reason instanceof ApiError && reason.message ? reason.message : fallback;
}

export function getNoteTags(note: { tags?: string[]; contentMarkdown?: string }) {
  return Array.isArray(note.tags)
    ? note.tags
    : note.contentMarkdown
      ? extractTags(note.contentMarkdown)
      : [];
}

export function searchResultLabel(query: string, total: number) {
  return `包含“${query}”的笔记 · 共 ${total} 篇`;
}

export function sortNotes(notes: NoteSummary[]) {
  return [...notes].sort(compareUpdatedPosition);
}

export type NoteUpdatedPosition = Pick<NoteSummary, "id" | "updatedAt">;

function compareUpdatedPosition(a: NoteUpdatedPosition, b: NoteUpdatedPosition) {
  return b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

export function mergeRemoteSummary(
  notes: NoteSummary[],
  summary: NoteSummary,
  pageBoundary?: NoteUpdatedPosition | null,
) {
  const index = notes.findIndex((note) => note.id === summary.id);
  if (index === -1) {
    // Keep the original page cursor. The promoted row now sorts before it.
    return pageBoundary && compareUpdatedPosition(summary, pageBoundary) < 0
      ? [...notes, summary].sort(compareUpdatedPosition)
      : null;
  }
  if (notes[index]!.version > summary.version) return notes;
  const previous = notes[index]!;
  const next = [...notes];
  next[index] = { ...previous, ...summary };
  if (summary.updatedAt !== previous.updatedAt) next.sort(compareUpdatedPosition);
  return next;
}

/** 列表请求期间完成的保存不能被较早读取的服务端快照覆盖。 */
export function preserveNewerNoteSummaries(incoming: NoteSummary[], current: NoteSummary[]) {
  const currentById = new Map(current.map((note) => [note.id, note]));
  return incoming.map((summary) => {
    const local = currentById.get(summary.id);
    return local && local.version > summary.version ? local : summary;
  });
}

export function shouldKeepActiveNoteInList(
  note: Pick<Note, "deletedAt" | "notebookId" | "isFavorite">,
  notebooks: Notebook[],
  view: NoteView,
  query: string,
  notebookId?: string,
) {
  // Search membership is server-derived; never inject unrelated active notes.
  if (query.trim()) return false;
  if (view === "trash") return note.deletedAt !== null;
  if (note.deletedAt !== null) return false;
  if (notebookId) return note.notebookId === notebookId;
  if (view === "favorites") return note.isFavorite;
  if (view === "inbox")
    return Boolean(notebooks.find((notebook) => notebook.id === note.notebookId)?.isSystem);
  return view === "all";
}

/** 双链返回的目标可能属于其他笔记本；搜索归属仍由服务端判断。 */
export function mergeWikiNoteSummary(
  notes: NoteSummary[],
  summary: NoteSummary,
  notebooks: Notebook[],
  view: NoteView,
  query: string,
  notebookId?: string,
) {
  if (!shouldKeepActiveNoteInList(summary, notebooks, view, query, notebookId)) return null;
  return [summary, ...notes.filter((note) => note.id !== summary.id)];
}

export function viewLabel(view: NoteView) {
  return { all: "全部笔记", inbox: "收件箱", favorites: "收藏", trash: "回收站" }[view];
}

export { relativeDate } from "../format";
// 列表与卡片统一的最多展示标签数。
export const NOTE_TAG_DISPLAY_LIMIT = 3;

export type NoteGroup = {
  id: string;
  title: string;
  count: number;
  notes: NoteSummary[];
};

export function getTimelineGroupTitle(timestampSeconds: number, nowMs = Date.now()): string {
  const timestampMs = timestampSeconds * 1000;
  const nowDate = new Date(nowMs);
  const year = nowDate.getFullYear();
  const month = nowDate.getMonth();
  const date = nowDate.getDate();
  const daysSinceMonday = (nowDate.getDay() + 6) % 7;
  const startOfToday = new Date(year, month, date).getTime();
  const startOfYesterday = new Date(year, month, date - 1).getTime();
  const startOfWeek = new Date(year, month, date - daysSinceMonday).getTime();
  const startOfLastWeek = new Date(year, month, date - daysSinceMonday - 7).getTime();
  const startOfMonth = new Date(nowDate.getFullYear(), nowDate.getMonth(), 1).getTime();
  const startOfLastMonth = new Date(year, month - 1, 1).getTime();
  const startOfYear = new Date(year, 0, 1).getTime();

  if (timestampMs >= startOfToday) {
    return "今天";
  }
  if (timestampMs >= startOfYesterday) {
    return "昨天";
  }
  if (timestampMs >= startOfWeek) {
    return "本周内";
  }
  if (timestampMs >= startOfLastWeek) {
    return "上周";
  }
  if (timestampMs >= startOfMonth) {
    return "本月内";
  }
  if (timestampMs >= startOfLastMonth) {
    return "上月";
  }
  if (timestampMs >= startOfYear) {
    return "今年内";
  }
  return "更早";
}

export function groupNotes(notes: NoteSummary[], nowMs = Date.now()): NoteGroup[] {
  if (notes.length === 0) return [];
  const groups: NoteGroup[] = [];
  const groupMap = new Map<string, NoteGroup>();

  for (const note of notes) {
    const title = getTimelineGroupTitle(note.updatedAt, nowMs);

    let group = groupMap.get(title);
    if (!group) {
      group = {
        id: `group-${title}`,
        title,
        count: 0,
        notes: [],
      };
      groupMap.set(title, group);
      groups.push(group);
    }
    group.notes.push(note);
    group.count += 1;
  }

  return groups;
}

export function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(
    new Date(timestamp * 1000),
  );
}
