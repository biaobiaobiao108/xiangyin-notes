import { parseTagQuery } from "../../shared/tags";
import type { NoteBacklinksResponse, NoteLinkSummary, NoteSummary, NoteView, UnlinkedMention } from "../../shared/types";
import {
  extractContextSnippet,
  extractWikiLinks,
  findUnlinkedMentionsInMarkdown,
  linkMentionInMarkdown,
  normalizeLinkTitle,
  replaceWikiLinkTarget,
} from "../../shared/wiki-links";
import {
  all,
  BACKLINK_CANDIDATE_LIMIT,
  BACKLINK_MENTION_LIMIT,
  BACKLINK_REFERENCE_LIMIT,
  BACKLINK_SCAN_CHAR_LIMIT,
  escapeLikePattern,
  first,
  getNote,
  InvalidNoteAssetsError,
  json,
  jsonError,
  NOTE_BODY_MAX_BYTES,
  NOTE_FROM,
  NOTE_LIST_SELECT,
  NOTE_PAGE_SIZE,
  NOTE_VIEWS,
  type NoteRow,
  normalizeNoteTitle,
  now,
  parseSearchTerms,
  readJson,
  type RouteContext,
  type SqliteDatabase,
  type SqlValue,
  syncNoteAssetReferences,
  syncNoteTags,
  parseIndexedTags,
  toFullNote,
  toNote,
  type UserRow,
  validNoteAssetReferences,
  validText,
} from "../core";
import {
  findActiveNoteIdByTitle,
  resolveNoteLinksForTarget,
  resolveNoteLinksForTitles,
  sourceNoteIdsReferencingTarget,
  syncNoteLinks,
} from "../note-links";
import { assetPathsForNotes, removeAssetFiles } from "./assets";
import { canIndexShortSearchTerm, syncNoteShortSearchTerms } from "../note-search";
import { handleNoteShares } from "./shares";
import { publishWorkspaceChange } from "../realtime";

export function createNote(
  database: SqliteDatabase,
  userId: string,
  notebookId: string,
  title: string,
  contentMarkdown: string,
  requestedId?: string,
) {
  const id = requestedId ?? crypto.randomUUID();
  const createdAt = now();
  const transaction = database.transaction(() => {
    database.query("INSERT INTO notes (id, user_id, notebook_id, title, content_markdown, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)").run(id, userId, notebookId, title, contentMarkdown, createdAt, createdAt);
    if (!syncNoteAssetReferences(database, userId, id, contentMarkdown)) throw new Error("invalid-note-assets");
    syncNoteTags(database, userId, id, contentMarkdown);
    syncNoteShortSearchTerms(database, userId, id, title, contentMarkdown);
    syncNoteLinks(database, userId, id, contentMarkdown, createdAt);
    resolveNoteLinksForTarget(database, userId, title, id);
  });
  transaction();
  return id;
}

export function updateNoteInTransaction(
  database: SqliteDatabase,
  current: NoteRow,
  userId: string,
  title: string,
  contentMarkdown: string,
  notebookId: string,
  isFavorite: number,
  deletedAt: number | null,
) {
  const updatedAt = now();
  const titleChanged = current.title !== title;
  const oldTitle = current.title;

  const updated = database.query("UPDATE notes SET title = ?, content_markdown = ?, notebook_id = ?, is_favorite = ?, deleted_at = ?, version = version + 1, updated_at = ? WHERE id = ? AND user_id = ? AND version = ? RETURNING id").get(title, contentMarkdown, notebookId, isFavorite, deletedAt, updatedAt, current.id, userId, current.version) as { id: string } | null;
  if (!updated) return false;
  if (!syncNoteAssetReferences(database, userId, current.id, contentMarkdown)) throw new InvalidNoteAssetsError();
  syncNoteTags(database, userId, current.id, contentMarkdown);
  syncNoteShortSearchTerms(database, userId, current.id, title, contentMarkdown);
  syncNoteLinks(database, userId, current.id, contentMarkdown, updatedAt);

  if (titleChanged && oldTitle.trim() && title.trim()) {
    const referencingSourceNoteIds = sourceNoteIdsReferencingTarget(database, userId, current.id);
    for (const sourceNoteId of referencingSourceNoteIds) {
      const refNote = getNote(database, userId, sourceNoteId);
      if (!refNote) continue;
      const { content: replacedContent, count } = replaceWikiLinkTarget(refNote.content_markdown, oldTitle, title);
      if (count > 0) {
        database.query("UPDATE notes SET content_markdown = ?, version = version + 1, updated_at = ? WHERE id = ? AND user_id = ?").run(replacedContent, updatedAt, refNote.id, userId);
        syncNoteTags(database, userId, refNote.id, replacedContent);
        syncNoteShortSearchTerms(database, userId, refNote.id, refNote.title, replacedContent);
        syncNoteLinks(database, userId, refNote.id, replacedContent, updatedAt);
      }
    }
  }
  if (titleChanged || deletedAt !== current.deleted_at) {
    resolveNoteLinksForTitles(database, userId, [oldTitle, title]);
  }

  return true;
}

export function updateNote(
  database: SqliteDatabase,
  current: NoteRow,
  userId: string,
  title: string,
  contentMarkdown: string,
  notebookId: string,
  isFavorite: number,
  deletedAt: number | null,
) {
  return database.transaction(() => updateNoteInTransaction(database, current, userId, title, contentMarkdown, notebookId, isFavorite, deletedAt))();
}

export async function handleNotesRoute(ctx: RouteContext, user: UserRow, assetRoot: string): Promise<Response | null> {
  const { request, url, method, segments, options } = ctx;
  const { database, environment } = options;
  const resource = segments[0] ?? "";
  const id = segments[1] ?? "";
  const subresource = segments[2] ?? "";

  // Empty trash
  if (method === "DELETE" && (url.pathname === "/api/trash" || (resource === "notes" && id === "trash"))) {
    const emptyTrash = database.transaction(() => {
      const deletedIds = all<{ id: string }>(database, "SELECT id FROM notes WHERE user_id = ? AND deleted_at IS NOT NULL", user.id).map((note) => note.id);
      const assetPaths = assetPathsForNotes(database, user.id, deletedIds);
      database.query("DELETE FROM notes WHERE user_id = ? AND deleted_at IS NOT NULL").run(user.id);
      return { ok: true, deletedCount: deletedIds.length, deletedIds, assetPaths };
    });
    const emptiedTrash = emptyTrash();
    publishWorkspaceChange(options, user.id, { resource: "notes" }, request);
    await removeAssetFiles(assetRoot, emptiedTrash.assetPaths);
    database.exec("PRAGMA incremental_vacuum;");
    return json({ ok: emptiedTrash.ok, deletedCount: emptiedTrash.deletedCount, deletedIds: emptiedTrash.deletedIds });
  }

  // Ensure wiki-notes target
  if (resource === "wiki-notes" && id === "ensure" && method === "POST") {
    const payload = await readJson<{ title?: unknown; notebookId?: unknown }>(request, 64 * 1024);
    if (!payload || !validText(payload.title, 200) || !(payload.title as string).trim() || typeof payload.notebookId !== "string") {
      return jsonError(400, "INVALID_WIKI_TARGET", "双向链接目标无效");
    }
    const title = (payload.title as string).trim();
    const existingId = findActiveNoteIdByTitle(database, user.id, title);
    if (existingId) {
      const existing = getNote(database, user.id, existingId);
      if (existing) return json({ note: toFullNote(existing), created: false });
    }
    if (!first(database, "SELECT id FROM notebooks WHERE id = ? AND user_id = ?", payload.notebookId, user.id)) {
      return jsonError(400, "INVALID_NOTEBOOK", "笔记本不存在");
    }
    const noteId = createNote(database, user.id, payload.notebookId as string, title, "");
    const note = getNote(database, user.id, noteId);
    publishWorkspaceChange(options, user.id, { resource: "notes", noteId }, request);
    return note ? json({ note: toFullNote(note), created: true }, 201) : jsonError(500, "NOTE_CREATE_FAILED", "笔记创建失败");
  }

  if (resource !== "notes") return null;

  // List notes
  if (!id && method === "GET") {
    const view = url.searchParams.get("view") ?? "all";
    if (!NOTE_VIEWS.includes(view as NoteView)) return jsonError(400, "INVALID_VIEW", "不支持的笔记视图");
    const query = url.searchParams.get("query")?.slice(0, 80) ?? "";
    const notebookId = url.searchParams.get("notebookId");
    const conditions = ["n.user_id = ?"];
    const params: SqlValue[] = [user.id];
    let from = NOTE_FROM;

    if (view === "trash") conditions.push("n.deleted_at IS NOT NULL");
    else conditions.push("n.deleted_at IS NULL");
    if (view === "inbox") conditions.push("b.is_system = 1");
    if (view === "favorites") conditions.push("n.is_favorite = 1");
    if (view === "shared") {
      conditions.push("EXISTS (SELECT 1 FROM shares s WHERE s.note_id = n.id AND s.revoked_at IS NULL AND s.expires_at > ?)");
      params.push(now());
    }
    if (notebookId) {
      conditions.push("n.notebook_id = ?");
      params.push(notebookId);
    }
    const tagQuery = parseTagQuery(query);
    if (query && !tagQuery) {
      const { tokens, ftsTokens, shortTokens } = parseSearchTerms(query);
      if (tokens.length === 0) return json({ notes: [], total: 0 });

      if (ftsTokens.length > 0) {
        const ftsQuery = ftsTokens.map((part) => `"${part.replaceAll('"', '""')}"`).join(" AND ");
        from += " JOIN notes_fts ON notes_fts.rowid = n.rowid";
        conditions.push("notes_fts MATCH ?");
        params.push(ftsQuery);
      }

      for (const short of shortTokens.filter(canIndexShortSearchTerm)) {
        conditions.push("EXISTS (SELECT 1 FROM note_short_terms st WHERE st.note_id = n.id AND st.user_id = n.user_id AND st.term = ?)");
        params.push(short);
      }

      for (const short of shortTokens.filter((term) => !canIndexShortSearchTerm(term))) {
        const escapedQuery = escapeLikePattern(short);
        conditions.push("(n.title LIKE ? ESCAPE '!' OR n.content_markdown LIKE ? ESCAPE '!')");
        params.push(`%${escapedQuery}%`, `%${escapedQuery}%`);
      }
    }
    const offset = Math.max(0, Number.parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);
    if (tagQuery) {
      conditions.push("EXISTS (SELECT 1 FROM note_tags t WHERE t.note_id = n.id AND t.user_id = n.user_id AND t.tag_normalized = ?)");
      params.push(tagQuery);
    }
    const where = conditions.join(" AND ");
    const totalRow = first<{ count: number }>(database, `SELECT COUNT(*) AS count FROM ${from} WHERE ${where}`, ...params);
    const listStatement = database.query(`
      SELECT ${NOTE_LIST_SELECT}
      FROM ${from} WHERE ${where} ORDER BY n.updated_at DESC LIMIT ${NOTE_PAGE_SIZE} OFFSET ${offset}
    `);
    const notes: NoteSummary[] = [];
    for (const row of listStatement.iterate(...params) as Iterable<NoteRow & { tags_json: string }>) notes.push(toNote(row, parseIndexedTags(row.tags_json)));
    return json({ notes, total: Number(totalRow?.count ?? 0) });
  }

  // Create note
  if (!id && method === "POST") {
    const payload = await readJson<{ id?: unknown; title?: unknown; contentMarkdown?: unknown; notebookId?: unknown }>(request, NOTE_BODY_MAX_BYTES);
    if (!payload) return jsonError(400, "INVALID_JSON", "请求体无效或超出大小限制");
    const rawTitle = payload?.title === undefined ? "未命名笔记" : payload.title;
    const contentMarkdown = payload?.contentMarkdown === undefined ? "" : payload.contentMarkdown;
    if (!validText(rawTitle, 200) || !validText(contentMarkdown, 1_000_000)) return jsonError(413, "NOTE_TOO_LARGE", "笔记标题或正文超出长度限制");
    const title = normalizeNoteTitle(rawTitle as string);
    const notebookId = typeof payload?.notebookId === "string" ? payload.notebookId : first<{ id: string }>(database, "SELECT id FROM notebooks WHERE user_id = ? AND is_system = 1 LIMIT 1", user.id)?.id;
    if (!notebookId) return jsonError(400, "NO_NOTEBOOK", "没有可用的收件箱");
    if (!first(database, "SELECT id FROM notebooks WHERE id = ? AND user_id = ?", notebookId, user.id)) return jsonError(400, "INVALID_NOTEBOOK", "笔记本不存在");
    if (!validNoteAssetReferences(database, user.id, null, contentMarkdown as string)) return jsonError(400, "INVALID_ASSET", "笔记引用了无权访问的图片");
    const noteId = createNote(database, user.id, notebookId, title, contentMarkdown as string, typeof payload?.id === "string" ? payload.id : undefined);
    const note = getNote(database, user.id, noteId);
    publishWorkspaceChange(options, user.id, { resource: "notes", noteId }, request);
    return json({ note: note ? toFullNote(note) : null }, 201);
  }

  // Note shares
  if (id && subresource === "shares" && (method === "GET" || method === "POST")) {
    return await handleNoteShares(database, user, id, method, url, environment, { request, options });
  }

  // Backlinks
  if (id && subresource === "backlinks" && method === "GET") {
    const note = getNote(database, user.id, id);
    if (!note) return jsonError(404, "NOTE_NOT_FOUND", "笔记不存在");

    const linkedRows = database.query(`
      SELECT nl.id AS link_id, nl.source_note_id, n.title AS source_title, n.content_markdown AS source_content, n.updated_at AS source_updated_at, nb.name AS notebook_name, nl.target_title, nl.target_note_id
      FROM note_links nl
      JOIN notes n ON nl.source_note_id = n.id AND n.user_id = nl.user_id
      JOIN notebooks nb ON n.notebook_id = nb.id
      WHERE nl.user_id = ? AND nl.target_note_id = ? AND nl.source_note_id != ? AND n.deleted_at IS NULL
      ORDER BY n.updated_at DESC
      LIMIT ?
    `);
    const linkedReferences: NoteLinkSummary[] = [];
    let truncated = false;
    let scannedChars = 0;
    for (const row of linkedRows.iterate(
      user.id,
      note.id,
      note.id,
      BACKLINK_REFERENCE_LIMIT + 1,
    ) as Iterable<{
      link_id: string;
      source_note_id: string;
      source_title: string;
      source_content: string;
      source_updated_at: number;
      notebook_name: string;
      target_title: string;
      target_note_id: string | null;
    }>) {
      if (linkedReferences.length >= BACKLINK_REFERENCE_LIMIT) {
        truncated = true;
        break;
      }
      scannedChars += row.source_content.length;
      if (scannedChars > BACKLINK_SCAN_CHAR_LIMIT) {
        truncated = true;
        break;
      }
      const links = extractWikiLinks(row.source_content);
      const matched = links.find((l) => normalizeLinkTitle(l.target) === normalizeLinkTitle(row.target_title) || normalizeLinkTitle(l.target) === normalizeLinkTitle(note.title));
      const snippet = matched ? extractContextSnippet(row.source_content, matched.start, matched.end) : row.source_content.slice(0, 100);
      linkedReferences.push({
        id: row.link_id,
        sourceNoteId: row.source_note_id,
        sourceNoteTitle: row.source_title,
        sourceNotebookName: row.notebook_name,
        targetTitle: row.target_title,
        targetNoteId: row.target_note_id,
        snippet,
        updatedAt: row.source_updated_at,
      });
    }

    const unlinkedMentions: UnlinkedMention[] = [];
    const trimmedTitle = note.title.trim();
    if (trimmedTitle.length >= 2) {
      const { ftsTokens } = parseSearchTerms(trimmedTitle);
      const useFts = trimmedTitle.length >= 3 && ftsTokens.length > 0;
      let candidateFrom = "notes n JOIN notebooks nb ON n.notebook_id = nb.id";
      const candidateConditions = ["n.user_id = ?", "n.deleted_at IS NULL", "n.id != ?"];
      const candidateParams: SqlValue[] = [user.id, note.id];

      if (useFts) {
        candidateFrom += " JOIN notes_fts ON notes_fts.rowid = n.rowid";
        candidateConditions.push("notes_fts MATCH ?");
        candidateParams.push(ftsTokens.map((p) => `"${p.replaceAll('"', '""')}"`).join(" AND "));
      } else {
        candidateConditions.push("n.content_markdown LIKE ? ESCAPE '!'");
        candidateParams.push(`%${escapeLikePattern(trimmedTitle)}%`);
      }

      const candidateSql = `
        SELECT n.id, n.title, n.content_markdown, nb.name AS notebook_name, n.version, n.updated_at
        FROM ${candidateFrom}
        WHERE ${candidateConditions.join(" AND ")}
        ORDER BY n.updated_at DESC
        LIMIT ?
      `;
      candidateParams.push(BACKLINK_CANDIDATE_LIMIT + 1);
      const candidates = database.query(candidateSql);
      let candidateCount = 0;
      mentionLoop: for (const candidate of candidates.iterate(...candidateParams) as Iterable<{
        id: string;
        title: string;
        content_markdown: string;
        notebook_name: string;
        version: number;
        updated_at: number;
      }>) {
        candidateCount += 1;
        if (candidateCount > BACKLINK_CANDIDATE_LIMIT) {
          truncated = true;
          break;
        }
        scannedChars += candidate.content_markdown.length;
        if (scannedChars > BACKLINK_SCAN_CHAR_LIMIT) {
          truncated = true;
          break;
        }
        const mentions = findUnlinkedMentionsInMarkdown(candidate.content_markdown, note.title);
        for (const m of mentions) {
          if (unlinkedMentions.length >= BACKLINK_MENTION_LIMIT) {
            truncated = true;
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
      }
    }

    const payload: NoteBacklinksResponse = { linkedReferences, unlinkedMentions, truncated };
    return json(payload);
  }

  // Link mention
  if (id && subresource === "link-mention" && method === "POST") {
    const targetNote = getNote(database, user.id, id);
    if (!targetNote) return jsonError(404, "NOTE_NOT_FOUND", "目标笔记不存在");

    const payload = await readJson<{ sourceNoteId?: unknown; sourceVersion?: unknown; matchStart?: unknown; matchEnd?: unknown; matchText?: unknown }>(request, 10_000);
    if (!payload || typeof payload.sourceNoteId !== "string" || !Number.isInteger(payload.sourceVersion) || !Number.isInteger(payload.matchStart) || !Number.isInteger(payload.matchEnd) || !validText(payload.matchText, 200) || !payload.matchText) {
      return jsonError(400, "INVALID_MENTION_PAYLOAD", "提及参数无效");
    }

    const sourceNote = getNote(database, user.id, payload.sourceNoteId);
    if (!sourceNote) return jsonError(404, "SOURCE_NOTE_NOT_FOUND", "来源笔记不存在");
    if (sourceNote.version !== payload.sourceVersion) return jsonError(409, "MENTION_STALE", "来源笔记已更新，请重新选择提及");

    const matchStart = payload.matchStart as number;
    const matchEnd = payload.matchEnd as number;
    if (matchStart < 0 || matchEnd > sourceNote.content_markdown.length || matchStart >= matchEnd) {
      return jsonError(400, "INVALID_MENTION_RANGE", "提及范围无效");
    }
    const currentMatch = sourceNote.content_markdown.slice(matchStart, matchEnd);
    const isCurrentMention = currentMatch === payload.matchText
      && normalizeLinkTitle(currentMatch) === normalizeLinkTitle(targetNote.title)
      && findUnlinkedMentionsInMarkdown(sourceNote.content_markdown, targetNote.title).some((mention) => mention.start === matchStart && mention.end === matchEnd);
    if (!isCurrentMention) return jsonError(409, "MENTION_STALE", "提及位置已变化，请重新选择");

    const newContent = linkMentionInMarkdown(sourceNote.content_markdown, matchStart, matchEnd, targetNote.title);
    if (!updateNote(database, sourceNote, user.id, sourceNote.title, newContent, sourceNote.notebook_id, sourceNote.is_favorite, sourceNote.deleted_at)) {
      return jsonError(409, "VERSION_CONFLICT", "来源笔记已被更新，请重试");
    }
    publishWorkspaceChange(options, user.id, { resource: "notes", noteId: sourceNote.id }, request);

    return json({ ok: true });
  }

  // Get single note
  if (id && method === "GET") {
    const note = getNote(database, user.id, id);
    return note ? json({ note: toFullNote(note) }) : jsonError(404, "NOTE_NOT_FOUND", "笔记不存在");
  }

  // Patch note
  if (id && method === "PATCH") {
    const current = getNote(database, user.id, id);
    if (!current) return jsonError(404, "NOTE_NOT_FOUND", "笔记不存在");
    const payload = await readJson<{ version?: unknown; title?: unknown; contentMarkdown?: unknown; notebookId?: unknown; isFavorite?: unknown; deleted?: unknown }>(request, NOTE_BODY_MAX_BYTES);
    if (!payload || !Number.isInteger(payload.version)) return jsonError(400, "VERSION_REQUIRED", "保存笔记必须携带版本号");
    if (payload.version !== current.version) return json({ error: { code: "VERSION_CONFLICT", message: "这篇笔记已在别处更新", current: toFullNote(current) } }, 409);
    const rawTitle = payload.title === undefined ? current.title : payload.title;
    const contentMarkdown = payload.contentMarkdown === undefined ? current.content_markdown : payload.contentMarkdown;
    const notebookId = payload.notebookId === undefined ? current.notebook_id : payload.notebookId;
    if (payload.isFavorite !== undefined && typeof payload.isFavorite !== "boolean") return jsonError(400, "INVALID_NOTE", "收藏状态无效");
    if (payload.deleted !== undefined && typeof payload.deleted !== "boolean") return jsonError(400, "INVALID_NOTE", "回收站状态无效");
    const isFavorite = payload.isFavorite === undefined ? current.is_favorite : payload.isFavorite ? 1 : 0;
    const deletedAt = payload.deleted === undefined ? current.deleted_at : payload.deleted ? now() : null;
    if (!validText(rawTitle, 200) || !validText(contentMarkdown, 1_000_000) || typeof notebookId !== "string") return jsonError(413, "NOTE_TOO_LARGE", "笔记标题或正文超出长度限制");
    const title = normalizeNoteTitle(rawTitle as string);
    if (!first(database, "SELECT id FROM notebooks WHERE id = ? AND user_id = ?", notebookId, user.id)) return jsonError(400, "INVALID_NOTEBOOK", "笔记本不存在");
    if (!validNoteAssetReferences(database, user.id, current.id, contentMarkdown as string)) return jsonError(400, "INVALID_ASSET", "笔记引用了无权访问的图片");
    let updated: boolean;
    try {
      updated = updateNote(database, current, user.id, title, contentMarkdown as string, notebookId, isFavorite, deletedAt);
    } catch (error) {
      if (error instanceof InvalidNoteAssetsError) return jsonError(400, "INVALID_ASSET", "笔记引用了无权访问的图片");
      throw error;
    }
    if (!updated) {
      const latest = getNote(database, user.id, current.id);
      return json({ error: { code: "VERSION_CONFLICT", message: "这篇笔记已在别处更新", current: latest ? toFullNote(latest) : null } }, 409);
    }
    const note = getNote(database, user.id, current.id);
    publishWorkspaceChange(options, user.id, { resource: "notes", noteId: current.id }, request);
    return json({ note: note ? toFullNote(note) : null });
  }

  // Delete note permanently
  if (id && method === "DELETE") {
    const note = getNote(database, user.id, id);
    if (!note) return jsonError(404, "NOTE_NOT_FOUND", "笔记不存在");
    if (!note.deleted_at) return jsonError(400, "NOTE_NOT_TRASHED", "只能永久删除回收站中的笔记");
    const assetPaths = assetPathsForNotes(database, user.id, [note.id]);
    const transaction = database.transaction(() => {
      database.query("DELETE FROM note_links WHERE user_id = ? AND source_note_id = ?").run(user.id, note.id);
      database.query("DELETE FROM notes WHERE id = ? AND user_id = ?").run(note.id, user.id);
    });
    transaction();
    publishWorkspaceChange(options, user.id, { resource: "notes", noteId: note.id }, request);
    await removeAssetFiles(assetRoot, assetPaths);
    database.exec("PRAGMA incremental_vacuum;");
    return json({ ok: true });
  }

  return null;
}
