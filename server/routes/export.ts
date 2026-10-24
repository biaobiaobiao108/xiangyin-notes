import { first, jsonError, type RouteContext, type UserRow } from "../core";

type ExportNoteRow = {
  title: string;
  content_markdown: string;
};

function safeMarkdownFilename(title: string) {
  const safeTitle = Array.from(
    title
      .trim()
      .replace(/[\\/:*?"<>|\0\r\n]/g, "_")
      .replace(/\.md$/iu, ""),
  )
    .slice(0, 100)
    .join("");
  const baseName = safeTitle && !/^\.+$/u.test(safeTitle) ? safeTitle : "未命名笔记";
  const windowsReservedName = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(baseName);
  return `${windowsReservedName ? `_${baseName}` : baseName}.md`;
}

function encodeFilename(value: string) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function handleExportRoute(ctx: RouteContext, user: UserRow): Response | null {
  const { url, method, segments, options } = ctx;
  if (
    method !== "GET" ||
    url.pathname !== `/api/notes/${segments[1]}/export` ||
    segments.length !== 3 ||
    segments[0] !== "notes" ||
    segments[2] !== "export"
  )
    return null;

  const note = first<ExportNoteRow>(
    options.database,
    "SELECT title, content_markdown FROM notes WHERE id = ? AND user_id = ?",
    segments[1],
    user.id,
  );
  if (!note) return jsonError(404, "NOTE_NOT_FOUND", "笔记不存在");

  const filename = safeMarkdownFilename(note.title);
  const headers = new Headers({
    "Content-Type": "text/markdown; charset=utf-8",
    "Content-Disposition": `attachment; filename="note.md"; filename*=UTF-8''${encodeFilename(filename)}`,
    "Cache-Control": "no-store",
  });
  return new Response(note.content_markdown, { headers });
}
