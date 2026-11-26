import type { NoteBacklinksResponse, NoteLinkSummary, UnlinkedMention } from "../../shared/types";
import {
  findUnlinkedMentionsInMarkdown,
  linkMentionInMarkdown,
  WIKI_NOTE_ID_PATTERN,
} from "../../shared/wiki-links";
import {
  all,
  BACKLINK_CANDIDATE_LIMIT,
  BACKLINK_MENTION_LIMIT,
  BACKLINK_REFERENCE_LIMIT,
  BACKLINK_SCAN_CHAR_LIMIT,
  getNote,
  json,
  jsonError,
  NOTE_CONTENT_MAX_LENGTH,
  parseSearchTerms,
  readJson,
  type RouteContext,
  type SqlValue,
  type UserRow,
  validText,
} from "../core";
import { shortSearchToken } from "../note-search";
import { publishWorkspaceChange } from "../realtime";
import {
  buildFtsMatchQuery,
  normalizeSearchTitle,
  normalizeSearchWhitespace,
  searchTermNeedsCaseFolding,
} from "../search-text";
import { updateNoteInTransaction } from "./note-mutations";

function searchContainsPredicate(
  column: "n.title" | "n.content_markdown" | "COALESCE(n.search_text, n.content_markdown)",
  term: string,
) {
  return searchTermNeedsCaseFolding(term)
    ? `search_contains(${column}, ?)`
    : `instr(${column}, ?) > 0`;
}

export async function handleNoteBacklinksRoute(
  ctx: RouteContext,
  user: UserRow,
): Promise<Response | null> {
  const { request, url, method, segments, options } = ctx;
  const { database } = options;
  const resource = segments[0] ?? "";
  const id = segments[1] ?? "";
  const subresource = segments[2] ?? "";

  if (resource === "wiki-notes" && id === "suggestions" && method === "GET") {
    const query = normalizeSearchTitle(url.searchParams.get("query")?.slice(0, 200) ?? "");
    if (!query) return json({ matches: [], exactMatch: false });
    const matches = all<{ id: string; title: string; notebookName: string }>(
      database,
      `
        SELECT n.id, n.title, b.name AS notebookName
        FROM notes n
        JOIN notebooks b ON b.id = n.notebook_id AND b.user_id = n.user_id
        WHERE n.user_id = ? AND n.deleted_at IS NULL AND instr(n.title_normalized, ?) > 0
        ORDER BY CASE WHEN n.title_normalized = ? THEN 0 WHEN instr(n.title_normalized, ?) = 1 THEN 1 ELSE 2 END,
          length(n.title), n.updated_at DESC, n.id
        LIMIT 7
      `,
      user.id,
      query,
      query,
      query,
    );
    return json({
      matches,
      exactMatch: matches.some((note) => normalizeSearchTitle(note.title) === query),
    });
  }

  if (resource === "wiki-notes" && id === "titles" && method === "GET") {
    const ids = [...new Set(url.searchParams.getAll("id"))];
    if (ids.length === 0 || ids.length > 100 || ids.some((id) => !WIKI_NOTE_ID_PATTERN.test(id)))
      return jsonError(400, "INVALID_WIKI_TARGET", "双向链接目标无效");
    const notes = all<{ id: string; title: string }>(
      database,
      `SELECT id, title FROM notes WHERE user_id = ? AND deleted_at IS NULL AND id IN (${ids.map(() => "?").join(", ")})`,
      user.id,
      ...ids,
    );
    return json({ notes });
  }

  if (resource === "notes" && id && subresource === "backlinks" && method === "GET") {
    const note = getNote(database, user.id, id);
    if (!note) return jsonError(404, "NOTE_NOT_FOUND", "笔记不存在");
    let linkedOffset = 0;
    let candidateOffset = 0;
    let mentionOffset = 0;
    const cursorValue = url.searchParams.get("cursor");
    if (cursorValue) {
      try {
        const cursor = JSON.parse(Buffer.from(cursorValue, "base64url").toString("utf8"));
        if (
          cursor.id !== id ||
          cursor.title !== note.title ||
          ![cursor.linked, cursor.candidate, cursor.mention].every(Number.isSafeInteger) ||
          cursor.linked < -1 ||
          cursor.candidate < -1 ||
          cursor.mention < 0 ||
          cursorValue.length > 2048
        )
          throw new Error("invalid cursor");
        linkedOffset = cursor.linked;
        candidateOffset = cursor.candidate;
        mentionOffset = cursor.mention;
      } catch {
        return jsonError(400, "INVALID_CURSOR", "反向链接分页游标无效");
      }
    }

    // 只物化最多 101 条元数据，正文仍按扫描预算逐篇读取。Bun 的缓存语句
    // 在 iterate() 提前 break 后可能无法再次执行，不能把截断游标留给后续请求。
    const linkedRows = database
      .query(
        `
      SELECT nl.id AS link_id, nl.source_note_id, n.title AS source_title,
        nl.snippet AS link_snippet,
        n.updated_at AS source_updated_at, nb.name AS notebook_name, nl.target_note_id
      FROM note_links nl
      JOIN notes n ON nl.source_note_id = n.id AND n.user_id = nl.user_id
      JOIN notebooks nb ON n.notebook_id = nb.id AND nb.user_id = n.user_id
      WHERE nl.user_id = ? AND nl.target_note_id = ? AND nl.source_note_id != ? AND n.deleted_at IS NULL
      ORDER BY n.updated_at DESC, nl.id DESC
      LIMIT ? OFFSET ?
    `,
      )
      .all(
        user.id,
        note.id,
        note.id,
        linkedOffset < 0 ? 0 : BACKLINK_REFERENCE_LIMIT + 1,
        Math.max(0, linkedOffset),
      ) as Array<{
      link_id: string;
      source_note_id: string;
      source_title: string;
      link_snippet: string;
      source_updated_at: number;
      notebook_name: string;
      target_note_id: string;
    }>;
    const linkedReferences: NoteLinkSummary[] = [];
    let truncated = false;
    let scannedChars = 0;
    let linkedProcessed = 0;
    for (const row of linkedRows) {
      if (linkedReferences.length >= BACKLINK_REFERENCE_LIMIT) {
        truncated = true;
        break;
      }
      linkedReferences.push({
        id: row.link_id,
        sourceNoteId: row.source_note_id,
        sourceNoteTitle: row.source_title,
        sourceNotebookName: row.notebook_name,
        targetTitle: note.title,
        targetNoteId: row.target_note_id,
        snippet: row.link_snippet,
        updatedAt: row.source_updated_at,
      });
      linkedProcessed++;
    }
    if (linkedOffset >= 0)
      linkedOffset = linkedProcessed < linkedRows.length ? linkedOffset + linkedProcessed : -1;

    const unlinkedMentions: UnlinkedMention[] = [];
    const searchTitle = normalizeSearchWhitespace(note.title);
    if (candidateOffset >= 0 && searchTitle.length >= 2) {
      const { ftsTokens } = parseSearchTerms(searchTitle);
      const useFts = searchTitle.length >= 3 && ftsTokens.length > 0;
      const useShortIndex = !useFts && Array.from(searchTitle).length <= 2;
      let candidateFrom =
        "notes n JOIN notebooks nb ON n.notebook_id = nb.id AND nb.user_id = n.user_id";
      const candidateConditions = ["n.user_id = ?", "n.deleted_at IS NULL", "n.id != ?"];
      const candidateParams: SqlValue[] = [user.id, note.id];

      if (useFts) {
        candidateFrom += " JOIN notes_fts ON notes_fts.rowid = n.rowid";
        candidateConditions.push("notes_fts MATCH ?");
        candidateParams.push(buildFtsMatchQuery(ftsTokens));
      } else if (useShortIndex) {
        candidateFrom = `(
          SELECT rowid FROM notes_short_fts WHERE notes_short_fts MATCH ?
          UNION
          SELECT overflow_note.rowid FROM notes_short_overflow overflow
          JOIN notes overflow_note ON overflow_note.id = overflow.note_id
          WHERE overflow.user_id = ? AND search_contains(COALESCE(overflow_note.search_text, overflow_note.content_markdown), ?)
        ) short_match
        JOIN notes n ON n.rowid = short_match.rowid
        JOIN notebooks nb ON n.notebook_id = nb.id AND nb.user_id = n.user_id`;
        candidateConditions.push(
          searchContainsPredicate("COALESCE(n.search_text, n.content_markdown)", searchTitle),
        );
        candidateParams.unshift(shortSearchToken(searchTitle), user.id, searchTitle);
        candidateParams.push(searchTitle);
      } else {
        candidateConditions.push(
          searchContainsPredicate("COALESCE(n.search_text, n.content_markdown)", searchTitle),
        );
        candidateParams.push(searchTitle);
      }

      const candidateSql = `
        SELECT n.id, n.title, length(n.content_markdown) AS content_char_count,
          nb.name AS notebook_name, n.version, n.updated_at
        FROM ${candidateFrom}
        WHERE ${candidateConditions.join(" AND ")}
        ORDER BY n.updated_at DESC, n.id DESC
        LIMIT ? OFFSET ?
      `;
      candidateParams.push(BACKLINK_CANDIDATE_LIMIT + 1, candidateOffset);
      const candidateRows = database.query(candidateSql).all(...candidateParams) as Array<{
        id: string;
        title: string;
        content_char_count: number;
        notebook_name: string;
        version: number;
        updated_at: number;
      }>;
      const candidateContentStatement = database.query(
        "SELECT content_markdown FROM notes WHERE id = ? AND user_id = ?",
      );
      let candidateCount = 0;
      let candidateHasMore = false;
      let stoppedWithinCandidate = false;
      mentionLoop: for (const candidate of candidateRows) {
        candidateCount += 1;
        if (candidateCount > BACKLINK_CANDIDATE_LIMIT) {
          truncated = true;
          candidateHasMore = true;
          break;
        }
        if (candidate.content_char_count > BACKLINK_SCAN_CHAR_LIMIT - scannedChars) {
          truncated = true;
          candidateCount--;
          candidateHasMore = true;
          break;
        }
        const source = candidateContentStatement.get(candidate.id, user.id) as {
          content_markdown: string;
        } | null;
        if (!source) continue;
        scannedChars += source.content_markdown.length;
        if (scannedChars > BACKLINK_SCAN_CHAR_LIMIT) {
          truncated = true;
          candidateCount--;
          candidateHasMore = true;
          break;
        }
        const mentions = findUnlinkedMentionsInMarkdown(source.content_markdown, note.title);
        for (
          let mentionIndex = candidateCount === 1 ? mentionOffset : 0;
          mentionIndex < mentions.length;
          mentionIndex++
        ) {
          const m = mentions[mentionIndex]!;
          if (unlinkedMentions.length >= BACKLINK_MENTION_LIMIT) {
            truncated = true;
            candidateOffset += candidateCount - 1;
            mentionOffset = mentionIndex;
            candidateHasMore = true;
            stoppedWithinCandidate = true;
            break mentionLoop;
          }
          unlinkedMentions.push({
            sourceNoteId: candidate.id,
            sourceNoteTitle: candidate.title,
            sourceNotebookName: candidate.notebook_name,
            snippet: m.snippet,
            matchIndex: m.start,
            matchText: m.matchText,
            sourceVersion: candidate.version,
            updatedAt: candidate.updated_at,
          });
        }
        mentionOffset = 0;
      }
      if (candidateHasMore && !stoppedWithinCandidate)
        candidateOffset += Math.min(candidateCount, BACKLINK_CANDIDATE_LIMIT);
      else if (!candidateHasMore) candidateOffset = -1;
    } else if (searchTitle.length < 2) {
      candidateOffset = -1;
    }

    const nextCursor =
      linkedOffset >= 0 || candidateOffset >= 0
        ? Buffer.from(
            JSON.stringify({
              id,
              title: note.title,
              linked: linkedOffset,
              candidate: candidateOffset,
              mention: mentionOffset,
            }),
          ).toString("base64url")
        : null;
    const payload: NoteBacklinksResponse = {
      linkedReferences,
      unlinkedMentions,
      truncated: truncated || Boolean(nextCursor),
      nextCursor,
    };
    return json(payload);
  }

  if (resource === "notes" && id && subresource === "link-mention" && method === "POST") {
    const payload = await readJson<{
      sourceNoteId?: unknown;
      sourceVersion?: unknown;
      matchStart?: unknown;
      matchEnd?: unknown;
      matchText?: unknown;
    }>(request, 10_000);
    if (
      !payload ||
      typeof payload.sourceNoteId !== "string" ||
      !Number.isInteger(payload.sourceVersion) ||
      !Number.isInteger(payload.matchStart) ||
      !Number.isInteger(payload.matchEnd) ||
      !validText(payload.matchText, 200) ||
      !payload.matchText
    ) {
      return jsonError(400, "INVALID_MENTION_PAYLOAD", "提及参数无效");
    }

    const sourceNoteId = payload.sourceNoteId;
    const matchText = payload.matchText;
    const matchStart = payload.matchStart as number;
    const matchEnd = payload.matchEnd as number;

    const failure = database
      .transaction(() => {
        const targetNote = getNote(database, user.id, id);
        if (!targetNote) return jsonError(404, "NOTE_NOT_FOUND", "目标笔记不存在");
        const sourceNote = getNote(database, user.id, sourceNoteId);
        if (!sourceNote) return jsonError(404, "SOURCE_NOTE_NOT_FOUND", "来源笔记不存在");
        if (targetNote.deleted_at !== null || sourceNote.deleted_at !== null)
          return jsonError(409, "NOTE_IN_TRASH", "回收站中的笔记只读，请先恢复笔记后再修改");
        if (sourceNote.version !== payload.sourceVersion)
          return jsonError(409, "MENTION_STALE", "来源笔记已更新，请重新选择提及");

        const content = sourceNote.content_markdown;
        if (matchStart < 0 || matchEnd > content.length || matchStart >= matchEnd)
          return jsonError(400, "INVALID_MENTION_RANGE", "提及范围无效");
        const currentMatch = content.slice(matchStart, matchEnd);
        if (
          currentMatch !== matchText ||
          !findUnlinkedMentionsInMarkdown(content, targetNote.title).some(
            (mention) => mention.start === matchStart && mention.end === matchEnd,
          )
        )
          return jsonError(409, "MENTION_STALE", "提及或目标标题已变化，请重新选择");

        const newContent = linkMentionInMarkdown(
          content,
          matchStart,
          matchEnd,
          targetNote.id,
          targetNote.title,
        );
        if (!validText(newContent, NOTE_CONTENT_MAX_LENGTH))
          return jsonError(413, "NOTE_TOO_LARGE", "笔记标题或正文超出长度限制");
        if (
          !updateNoteInTransaction(
            database,
            sourceNote,
            user.id,
            sourceNote.title,
            newContent,
            sourceNote.notebook_id,
            sourceNote.is_favorite,
            sourceNote.deleted_at,
          )
        )
          return jsonError(409, "VERSION_CONFLICT", "来源笔记已被更新，请重试");
        return null;
      })
      .immediate();
    if (failure) return failure;
    publishWorkspaceChange(options, user.id, { resource: "notes", noteId: sourceNoteId }, request);

    return json({ ok: true });
  }

  return null;
}
