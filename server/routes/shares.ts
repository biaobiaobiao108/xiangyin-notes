import type { Share, ShareSnapshot } from "../../shared/types";
import {
  all,
  createOpaqueToken,
  digestHex,
  first,
  getNote,
  getPublicOrigin,
  type ImageAssetRow,
  json,
  jsonError,
  now,
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

export async function handlePublicShare(request: Request, database: SqliteDatabase) {
  const token = new URL(request.url).pathname.split("/").filter(Boolean)[2] ?? "";
  const row = first<ShareRow>(database, "SELECT id, note_id, created_at, expires_at, revoked_at, snapshot_title, snapshot_content_markdown FROM shares WHERE token_hash = ?", await digestHex(token));
  if (!row) return jsonError(404, "SHARE_NOT_FOUND", "分享链接不存在");
  if (row.revoked_at) return jsonError(410, "SHARE_REVOKED", "分享链接已撤销");
  if (row.expires_at <= now()) return jsonError(410, "SHARE_EXPIRED", "分享链接已过期");
  const snapshot: ShareSnapshot = {
    schemaVersion: 1,
    title: row.snapshot_title,
    contentMarkdown: row.snapshot_content_markdown,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
  return json({ snapshot });
}

export async function servePublicShareAsset(request: Request, database: SqliteDatabase, assetRoot: string) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  const segments = new URL(request.url).pathname.split("/").filter(Boolean);
  const token = segments[2] ?? "";
  const assetId = segments[3] ?? "";
  const share = first<{ note_id: string; expires_at: number; revoked_at: number | null }>(database, "SELECT note_id, expires_at, revoked_at FROM shares WHERE token_hash = ?", await digestHex(token));
  if (!share) return jsonError(404, "SHARE_NOT_FOUND", "分享链接不存在");
  if (share.revoked_at) return jsonError(410, "SHARE_REVOKED", "分享链接已撤销");
  if (share.expires_at <= now()) return jsonError(410, "SHARE_EXPIRED", "分享链接已过期");
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
    const rows = all<{ id: string; note_id: string; created_at: number; expires_at: number; revoked_at: number | null }>(
      database,
      "SELECT id, note_id, created_at, expires_at, revoked_at FROM shares WHERE note_id = ? AND user_id = ? ORDER BY created_at DESC",
      note.id,
      user.id,
    );
    return json({ shares: rows.map(toShare) });
  }

  if (method === "POST") {
    const publicOrigin = getPublicOrigin(url, environment);
    const createdAt = now();
    const expiresAt = createdAt + SHARE_TTL;
    const shareId = crypto.randomUUID();
    const token = createOpaqueToken();
    const tokenHash = await digestHex(token);
    const transaction = database.transaction(() => {
      database.query("INSERT INTO shares (id, note_id, user_id, token_hash, created_at, expires_at, snapshot_title, snapshot_content_markdown) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
        shareId,
        note.id,
        user.id,
        tokenHash,
        createdAt,
        expiresAt,
        note.title,
        rewriteAssetUrlsForShare(note.content_markdown, token),
      );
    });
    transaction();
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
    const result = database.query("UPDATE shares SET revoked_at = ?, snapshot_content_markdown = '' WHERE id = ? AND user_id = ? AND revoked_at IS NULL").run(now(), id, user.id);
    if (result.changes) publishWorkspaceChange(options, user.id, { resource: "shares" }, request);
    return result.changes ? json({ ok: true }) : jsonError(404, "SHARE_NOT_FOUND", "分享链接不存在");
  }

  return null;
}

export const EXPIRED_SHARE_PURGE_SECONDS = 30 * 24 * 60 * 60;
let nextExpiredSharesCleanupAt = 0;

export function cleanupExpiredShares(database: SqliteDatabase, force = false) {
  const timestamp = now();
  if (!force && timestamp < nextExpiredSharesCleanupAt) return;
  nextExpiredSharesCleanupAt = timestamp + 3600;

  database.query("UPDATE shares SET snapshot_content_markdown = '' WHERE (expires_at <= ? OR revoked_at IS NOT NULL) AND snapshot_content_markdown != ''").run(timestamp);
  const purgeBefore = timestamp - EXPIRED_SHARE_PURGE_SECONDS;
  database.query("DELETE FROM shares WHERE expires_at <= ? OR (revoked_at IS NOT NULL AND revoked_at <= ?)").run(purgeBefore, purgeBefore);
}
