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
import type { Note, NoteSort, NoteSummary, NoteView, Notebook } from "../../shared/types";
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

export type { NoteSort } from "../../shared/types";

export function sortNotes(notes: NoteSummary[], sort: NoteSort) {
  return [...notes].sort((a, b) =>
    sort === "created"
      ? b.createdAt - a.createdAt
      : sort === "title"
        ? (a.title || "未命名笔记").localeCompare(b.title || "未命名笔记", "zh-CN")
        : b.updatedAt - a.updatedAt,
  );
}

/**
 * 把单篇远端摘要合并进当前列表。返回 null 表示该笔记不在当前列表里。
 * `updated` 排序下服务端会把刚更新的笔记排在前面，这里同步置顶以保持顺序可信。
 */
export function mergeRemoteSummary(notes: NoteSummary[], summary: NoteSummary, sort: NoteSort) {
  const index = notes.findIndex((note) => note.id === summary.id);
  if (index === -1) return null;
  const next = [...notes];
  next[index] = { ...next[index]!, ...summary };
  if (sort === "updated" && index > 0) {
    const [patched] = next.splice(index, 1);
    next.unshift(patched!);
  }
  return next;
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

const PINYIN_COLLATOR = new Intl.Collator("zh-Hans-u-co-pinyin");
const PINYIN_STARTS: Array<[string, string]> = [
  ["A", "啊"],
  ["B", "八"],
  ["C", "嚓"],
  ["D", "哒"],
  ["E", "妸"],
  ["F", "发"],
  ["G", "旮"],
  ["H", "哈"],
  ["J", "讥"],
  ["K", "咔"],
  ["L", "垃"],
  ["M", "妈"],
  ["N", "拿"],
  ["O", "噢"],
  ["P", "趴"],
  ["Q", "七"],
  ["R", "然"],
  ["S", "仨"],
  ["T", "他"],
  ["W", "哇"],
  ["X", "夕"],
  ["Y", "丫"],
  ["Z", "匝"],
];

export function getInitialLetter(char: string): string {
  if (!char) return "#";
  const upper = char.toUpperCase();
  if (upper >= "A" && upper <= "Z") return upper;
  if (/[\u4e00-\u9fa5]/.test(char)) {
    for (let i = PINYIN_STARTS.length - 1; i >= 0; i--) {
      if (PINYIN_COLLATOR.compare(char, PINYIN_STARTS[i]![1]) >= 0) {
        return PINYIN_STARTS[i]![0];
      }
    }
  }
  return "#";
}

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

export function groupNotes(notes: NoteSummary[], sort: NoteSort, nowMs = Date.now()): NoteGroup[] {
  if (notes.length === 0) return [];
  const groups: NoteGroup[] = [];
  const groupMap = new Map<string, NoteGroup>();

  for (const note of notes) {
    let title: string;
    if (sort === "title") {
      const firstChar = (note.title || "未命名笔记").trim()[0] || "";
      title = getInitialLetter(firstChar);
    } else {
      const timestamp = sort === "created" ? note.createdAt : note.updatedAt;
      title = getTimelineGroupTitle(timestamp, nowMs);
    }

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
