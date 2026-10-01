import type { Share, SharedNote } from "../../shared/types";
import {
  all,
  createOpaqueToken,
  digestHex,
  first,
  getNote,
  type ImageAssetRow,
  json,
  jsonError,
  noteAssetIds,
  now,
  publicOriginForShare,
  rewriteAssetUrlsForShare,
  type RouteContext,
  SHARE_TTL,
  type ShareRow,
  type SqliteDatabase,
  toShare,
  type UserRow,
} from "../core";
import { assetFilePath } from "./assets";
import { publishWorkspaceChange } from "../realtime";

type ShareRouteContext = Pick<RouteContext, "request" | "options">;

type ShareCursor = { createdAt: number; id: string };

function encodeShareCursor(cursor: ShareCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeShareCursor(value: string | null): ShareCursor | null | false {
  if (value === null) return null;
  if (!value) return false;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<ShareCursor>;
    if (!Number.isSafeInteger(parsed.createdAt) || typeof parsed.id !== "string" || !parsed.id) return false;
    return parsed as ShareCursor;
  } catch {
    return false;
  }
}

export async function handlePublicShare(request: Request, database: SqliteDatabase) {
  const token = new URL(request.url).pathname.split("/").filter(Boolean)[2] ?? "";
  const row = first<ShareRow>(database, "SELECT id, note_id, user_id, created_at, expires_at, revoked_at FROM shares WHERE token_hash = ?", await digestHex(token));
  if (!row) return jsonError(404, "SHARE_NOT_FOUND", "分享链接不存在");
  if (row.revoked_at) return jsonError(410, "SHARE_REVOKED", "分享链接已撤销");
  if (row.expires_at <= now()) return jsonError(410, "SHARE_EXPIRED", "分享链接已过期");
  const note = first<{ title: string; content_markdown: string }>(database, "SELECT title, content_markdown FROM notes WHERE id = ? AND user_id = ? AND deleted_at IS NULL", row.note_id, row.user_id);
  if (!note) return jsonError(404, "NOTE_NOT_FOUND", "笔记不存在或已移入回收站");
  const sharedNote: SharedNote = {
    title: note.title,
    contentMarkdown: rewriteAssetUrlsForShare(note.content_markdown, token),
    sharedAt: row.created_at,
    expiresAt: row.expires_at,
  };
  return json({ note: sharedNote });
}

export async function servePublicShareAsset(request: Request, database: SqliteDatabase, assetRoot: string) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  const segments = new URL(request.url).pathname.split("/").filter(Boolean);
  const token = segments[2] ?? "";
  const assetId = (segments[3] ?? "").toLowerCase();
  const share = first<{ note_id: string; user_id: string; expires_at: number; revoked_at: number | null }>(database, "SELECT note_id, user_id, expires_at, revoked_at FROM shares WHERE token_hash = ?", await digestHex(token));
  if (!share) return jsonError(404, "SHARE_NOT_FOUND", "分享链接不存在");
  if (share.revoked_at) return jsonError(410, "SHARE_REVOKED", "分享链接已撤销");
  if (share.expires_at <= now()) return jsonError(410, "SHARE_EXPIRED", "分享链接已过期");
  const note = first<{ content_markdown: string }>(database, "SELECT content_markdown FROM notes WHERE id = ? AND user_id = ? AND deleted_at IS NULL", share.note_id, share.user_id);
  if (!note) return jsonError(404, "NOTE_NOT_FOUND", "笔记不存在或已移入回收站");
  if (!noteAssetIds(note.content_markdown).includes(assetId)) return jsonError(404, "ASSET_NOT_FOUND", "图片不存在");
  const asset = first<ImageAssetRow>(database, "SELECT id, user_id, note_id, storage_path, original_name, mime_type, byte_size, width, height, document_order, created_at FROM image_assets WHERE id = ? AND note_id = ?", assetId, share.note_id);
  if (!asset) return jsonError(404, "ASSET_NOT_FOUND", "图片不存在");
  const filePath = assetFilePath(assetRoot, asset.storage_path);
  if (!filePath) return jsonError(404, "ASSET_NOT_FOUND", "图片不存在");
  const file = Bun.file(filePath);
  if (!(await file.exists())) return jsonError(404, "ASSET_NOT_FOUND", "图片不存在");
  return new Response(request.method === "HEAD" ? null : file, {
    headers: {
      "Content-Type": asset.mime_type,
      "Content-Length": String(asset.byte_size),
      "Content-Disposition": "inline",
      "Cache-Control": "no-store",
    },
  });
}

export async function handleNoteShares(
  database: SqliteDatabase,
  user: UserRow,
  noteId: string,
  method: string,
  url: URL,
  environment: Record<string, string | undefined> = {},
  context?: ShareRouteContext,
): Promise<Response> {
  const note = getNote(database, user.id, noteId);
  if (!note) return jsonError(404, "NOTE_NOT_FOUND", "笔记不存在");

  if (method === "GET") {
    // Keep the existing application API contract for callers that do not ask
    // for pagination; MCP passes an explicit limit and uses cursor pages.
    if (!url.searchParams.has("limit") && !url.searchParams.has("cursor")) {
      const rows = all<{ id: string; note_id: string; created_at: number; expires_at: number; revoked_at: number | null }>(
        database,
        "SELECT id, note_id, created_at, expires_at, revoked_at FROM shares WHERE note_id = ? AND user_id = ? ORDER BY created_at DESC, id DESC",
        note.id,
        user.id,
      );
      return json({ shares: rows.map(toShare) });
    }
    const parsedLimit = Number(url.searchParams.get("limit") ?? "20");
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
      return jsonError(400, "INVALID_LIMIT", "limit 必须是 1 到 100 之间的整数");
    }
    const cursor = decodeShareCursor(url.searchParams.get("cursor"));
    if (cursor === false) return jsonError(400, "INVALID_CURSOR", "cursor 无效，请使用上一页返回的 nextCursor");
    const rows = cursor
      ? all<{ id: string; note_id: string; created_at: number; expires_at: number; revoked_at: number | null }>(
        database,
        "SELECT id, note_id, created_at, expires_at, revoked_at FROM shares WHERE note_id = ? AND user_id = ? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?",
        note.id,
        user.id,
        cursor.createdAt,
        cursor.createdAt,
        cursor.id,
        parsedLimit + 1,
      )
      : all<{ id: string; note_id: string; created_at: number; expires_at: number; revoked_at: number | null }>(
        database,
        "SELECT id, note_id, created_at, expires_at, revoked_at FROM shares WHERE note_id = ? AND user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
        note.id,
        user.id,
        parsedLimit + 1,
      );
    const hasMore = rows.length > parsedLimit;
    const page = rows.slice(0, parsedLimit);
    const last = page.at(-1);
    return json({
      shares: page.map(toShare),
      hasMore,
      nextCursor: hasMore && last ? encodeShareCursor({ createdAt: last.created_at, id: last.id }) : null,
    });
  }

  if (method === "POST") {
    if (note.deleted_at !== null) {
      return jsonError(409, "NOTE_IN_TRASH", "回收站中的笔记不能创建分享，请先恢复笔记");
    }
    const publicOrigin = publicOriginForShare(url, environment);
    const createdAt = now();
    const expiresAt = createdAt + SHARE_TTL;
    const shareId = crypto.randomUUID();
    const token = createOpaqueToken();
    const tokenHash = await digestHex(token);
    const createShare = database.transaction(() => {
      const current = getNote(database, user.id, noteId);
      if (!current) return "NOTE_NOT_FOUND" as const;
      if (current.deleted_at !== null) return "NOTE_IN_TRASH" as const;
      database.query("INSERT INTO shares (id, note_id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)").run(shareId, current.id, user.id, tokenHash, createdAt, expiresAt);
      return current.id;
    });
    const createdForNote = createShare.immediate();
    if (createdForNote === "NOTE_NOT_FOUND") return jsonError(404, "NOTE_NOT_FOUND", "笔记不存在");
    if (createdForNote === "NOTE_IN_TRASH") return jsonError(409, "NOTE_IN_TRASH", "回收站中的笔记不能创建分享，请先恢复笔记");
    if (context) publishWorkspaceChange(context.options, user.id, { resource: "shares", noteId: note.id }, context.request);
    const share: Share = {
      id: shareId,
      noteId: note.id,
      expiresAt,
      revokedAt: null,
      createdAt,
      url: `${publicOrigin}/share/${token}`,
    };
    return json({ share }, 201);
  }

  return jsonError(405, "METHOD_NOT_ALLOWED", "方法不支持");
}

export async function handleSharesRoute(ctx: RouteContext, user?: UserRow | null): Promise<Response | null> {
  const { request, url, method, segments, options } = ctx;
  const { database } = options;
  const resource = segments[0] ?? "";
  const id = segments[1] ?? "";
  const subresource = segments[2] ?? "";

  if (resource !== "shares") return null;

  if (id && !subresource && method === "DELETE") {
    if (!user) return null;
    const findOwnedShare = () => first<{ id: string; note_id: string; created_at: number; expires_at: number; revoked_at: number | null }>(
      database,
      "SELECT id, note_id, created_at, expires_at, revoked_at FROM shares WHERE id = ? AND user_id = ?",
      id,
      user.id,
    );
    const result = database.query("UPDATE shares SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL").run(now(), id, user.id);
    if (result.changes) {
      publishWorkspaceChange(options, user.id, { resource: "shares" }, request);
      const share = findOwnedShare();
      return share ? json({ ok: true, share: toShare(share), noop: false }) : jsonError(404, "SHARE_NOT_FOUND", "分享链接不存在");
    }
    const share = findOwnedShare();
    if (share && share.revoked_at !== null) return json({ ok: true, share: toShare(share), noop: true });
    return jsonError(404, "SHARE_NOT_FOUND", "分享链接不存在");
  }

  return null;
}

export const EXPIRED_SHARE_PURGE_SECONDS = 30 * 24 * 60 * 60;
let nextExpiredSharesCleanupAt = 0;

export function cleanupExpiredShares(database: SqliteDatabase, force = false) {
  const timestamp = now();
  if (!force && timestamp < nextExpiredSharesCleanupAt) return;
  nextExpiredSharesCleanupAt = timestamp + 3600;

  const purgeBefore = timestamp - EXPIRED_SHARE_PURGE_SECONDS;
  database.query("DELETE FROM shares WHERE expires_at <= ? OR (revoked_at IS NOT NULL AND revoked_at <= ?)").run(purgeBefore, purgeBefore);
}
