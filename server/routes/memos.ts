import { constants } from "node:fs";
import { copyFile } from "node:fs/promises";
import { extname } from "node:path";
import {
  first,
  getNote,
  InvalidNoteAssetsError,
  json,
  jsonError,
  NOTE_BODY_MAX_BYTES,
  noteAssetIds,
  now,
  readJson,
  rewriteMarkdownAssetDestinations,
  type RouteContext,
  toFullNote,
  type UserRow,
  validNoteAssetReferences,
} from "../core";
import { createNote } from "./note-mutations";
import { assetFilePath, assetRootFromEnv, removeAssetFiles } from "./assets";
import { publishWorkspaceChange } from "../realtime";
import { searchableTextFromMarkdown } from "../search-text";
import { syncMemoShortSearchTerms } from "../memo-search";
import { listMemos, memoFacets } from "./memo-list";
import {
  createMemo,
  getMemo,
  invalidMemoAsset,
  MEMO_ID_PATTERN,
  memoContentError,
  memoFromRow,
  memoHasMissingNewAssets,
  syncMemoTags,
  validateMemoCreatedAtPayload,
} from "./memo-shared";

export { MEMO_PAGE_MAX_SIZE, MEMO_PAGE_SIZE } from "./memo-list";
export {
  handleMemoImportRoute,
  MEMO_IMPORT_RATE_LIMIT_MAX_REQUESTS,
  MEMO_IMPORT_RATE_LIMIT_WINDOW_SECONDS,
} from "./memo-import";
export { validateMemoCreatedAtPayload } from "./memo-shared";

function parseMemoId(value: unknown) {
  return value === undefined
    ? crypto.randomUUID()
    : typeof value === "string" && MEMO_ID_PATTERN.test(value)
      ? value
      : null;
}

function memoMutation(ctx: RouteContext, user: UserRow, memoId: string) {
  const { request, method, options } = ctx;
  if (method === "PATCH") {
    return (async () => {
      const payload = await readJson<{ version?: unknown; contentMarkdown?: unknown }>(
        request,
        NOTE_BODY_MAX_BYTES,
      );
      if (!payload) return jsonError(400, "INVALID_JSON", "请求体无效或超出大小限制");
      if (!Number.isSafeInteger(payload.version) || (payload.version as number) < 1)
        return jsonError(400, "VERSION_REQUIRED", "更新随记必须携带版本号");
      const contentError = memoContentError(payload.contentMarkdown);
      if (contentError) return contentError;

      const result = options.database
        .transaction(() => {
          const current = getMemo(options.database, user.id, memoId);
          if (!current) return { kind: "missing" as const };
          if (current.version !== payload.version) return { kind: "conflict" as const, current };
          if (current.content_markdown === payload.contentMarkdown)
            return { kind: "unchanged" as const, current };
          if (
            memoHasMissingNewAssets(
              options.database,
              user.id,
              payload.contentMarkdown as string,
              current.content_markdown,
            )
          )
            return { kind: "invalid-asset" as const };
          const updatedAt = Math.max(current.created_at, Date.now());
          const searchText = searchableTextFromMarkdown(payload.contentMarkdown as string);
          const updated = options.database
            .query(
              "UPDATE memos SET content_markdown = ?, search_text = ?, version = version + 1, updated_at = ? WHERE id = ? AND user_id = ? AND version = ?",
            )
            .run(
              payload.contentMarkdown as string,
              searchText,
              updatedAt,
              memoId,
              user.id,
              payload.version as number,
            );
          if (!updated.changes)
            return {
              kind: "conflict" as const,
              current: getMemo(options.database, user.id, memoId),
            };
          syncMemoTags(options.database, user.id, memoId, payload.contentMarkdown as string);
          syncMemoShortSearchTerms(options.database, user.id, memoId, searchText);
          return { kind: "updated" as const };
        })
        .immediate();
      if (result.kind === "missing") return jsonError(404, "MEMO_NOT_FOUND", "随记不存在");
      if (result.kind === "invalid-asset") return invalidMemoAsset();
      if (result.kind === "conflict") {
        return json(
          {
            error: {
              code: "VERSION_CONFLICT",
              message: "这条随记已在别处更新",
              current: result.current ? memoFromRow(result.current) : null,
            },
          },
          409,
        );
      }
      if (result.kind === "updated")
        publishWorkspaceChange(options, user.id, { resource: "memos" }, request);
      const memo = getMemo(options.database, user.id, memoId);
      return json({ memo: memo ? memoFromRow(memo) : null });
    })();
  }

  if (method === "DELETE") {
    return (async () => {
      const payload = await readJson<{ version?: unknown }>(request, 1024);
      if (!payload || !Number.isSafeInteger(payload.version) || (payload.version as number) < 1)
        return jsonError(400, "VERSION_REQUIRED", "删除随记必须携带版本号");
      const result = options.database
        .transaction(() => {
          const current = getMemo(options.database, user.id, memoId);
          if (!current) return { kind: "missing" as const };
          if (current.version !== payload.version) return { kind: "conflict" as const, current };
          const deleted = options.database
            .query("DELETE FROM memos WHERE id = ? AND user_id = ? AND version = ?")
            .run(memoId, user.id, payload.version as number);
          return deleted.changes
            ? { kind: "deleted" as const }
            : { kind: "conflict" as const, current: getMemo(options.database, user.id, memoId) };
        })
        .immediate();
      if (result.kind === "missing") return jsonError(404, "MEMO_NOT_FOUND", "随记不存在");
      if (result.kind === "conflict")
        return json(
          {
            error: {
              code: "VERSION_CONFLICT",
              message: "这条随记已在别处更新，请刷新后重试",
              current: result.current ? memoFromRow(result.current) : null,
            },
          },
          409,
        );
      publishWorkspaceChange(options, user.id, { resource: "memos" }, request);
      return json({ ok: true });
    })();
  }
  return null;
}

export function handleMemosRoute(
  ctx: RouteContext,
  user: UserRow,
): Response | Promise<Response> | null {
  const { segments, method } = ctx;
  if (segments[0] !== "memos") return null;

  if (segments.length === 2 && segments[1] === "facets") {
    if (method !== "GET")
      return jsonError(405, "METHOD_NOT_ALLOWED", "随记统计只支持 GET", { Allow: "GET" });
    return memoFacets(ctx, user);
  }

  if (segments.length === 1) {
    if (method === "GET") return listMemos(ctx, user);
    if (method === "POST") {
      return (async () => {
        const payload = await readJson<{
          id?: unknown;
          contentMarkdown?: unknown;
          createdAt?: unknown;
        }>(ctx.request, NOTE_BODY_MAX_BYTES);
        if (!payload) return jsonError(400, "INVALID_JSON", "请求体无效或超出大小限制");
        const memoId = parseMemoId(payload.id);
        if (!memoId) return jsonError(400, "INVALID_MEMO_ID", "随记 ID 无效");
        const contentError = memoContentError(payload.contentMarkdown);
        if (contentError) return contentError;
        const createdAt = validateMemoCreatedAtPayload(payload.createdAt);
        if (createdAt === null) return jsonError(400, "INVALID_CREATED_AT", "创建时间无效");
        const database = ctx.options.database;
        const result = database
          .transaction(() => {
            const existing = getMemo(database, user.id, memoId);
            if (
              existing &&
              existing.version === 1 &&
              existing.content_markdown === payload.contentMarkdown &&
              (payload.createdAt === undefined || existing.created_at === createdAt)
            )
              return { kind: "replayed" as const, memo: existing };
            if (existing) return { kind: "conflict" as const };
            if (memoHasMissingNewAssets(database, user.id, payload.contentMarkdown as string))
              return { kind: "invalid-asset" as const };
            createMemo(database, user.id, payload.contentMarkdown as string, memoId, createdAt);
            return { kind: "created" as const };
          })
          .immediate();
        if (result.kind === "replayed") return json({ memo: memoFromRow(result.memo) }, 200);
        if (result.kind === "conflict")
          return jsonError(409, "MEMO_EXISTS", "指定 ID 的随记已存在");
        if (result.kind === "invalid-asset") return invalidMemoAsset();
        publishWorkspaceChange(ctx.options, user.id, { resource: "memos" }, ctx.request);
        const memo = getMemo(database, user.id, memoId);
        return json({ memo: memo ? memoFromRow(memo) : null }, 201);
      })();
    }
    return jsonError(405, "METHOD_NOT_ALLOWED", "随记列表只支持 GET 或 POST", {
      Allow: "GET, POST",
    });
  }

  if (segments.length === 3 && segments[2] === "convert" && method === "POST") {
    const memoId = segments[1];
    if (!MEMO_ID_PATTERN.test(memoId)) return jsonError(400, "INVALID_MEMO_ID", "随记 ID 无效");
    return (async () => {
      const payload = await readJson<{ version?: unknown }>(ctx.request, 1024);
      if (!payload || !Number.isSafeInteger(payload.version) || (payload.version as number) < 1)
        return jsonError(400, "VERSION_REQUIRED", "转换随记必须携带版本号");
      const database = ctx.options.database;
      const root = ctx.options.assetRoot ?? assetRootFromEnv(ctx.options.environment);
      const initialMemo = getMemo(database, user.id, memoId);
      const copiedPaths: string[] = [];
      const preparedAssets: Array<{ sourceId: string; copyId: string; copyPath: string }> = [];
      const replacements = new Map<string, string>();
      if (initialMemo && initialMemo.version === payload.version) {
        const findOwnedAsset = database.query<{ storage_path: string }, [string, string]>(
          "SELECT storage_path FROM image_assets WHERE id = ? AND user_id = ? AND note_id IS NOT NULL",
        );
        try {
          for (const id of noteAssetIds(initialMemo.content_markdown)) {
            const asset = findOwnedAsset.get(id, user.id);
            if (!asset) continue;
            const copyId = crypto.randomUUID();
            const copyPath = `${user.id}/${copyId}${extname(asset.storage_path)}`;
            const from = assetFilePath(root, asset.storage_path);
            const to = assetFilePath(root, copyPath);
            if (!from || !to) throw new InvalidNoteAssetsError();
            try {
              await copyFile(from, to, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT")
                throw new InvalidNoteAssetsError();
              throw error;
            }
            copiedPaths.push(copyPath);
            preparedAssets.push({ sourceId: id, copyId, copyPath });
            replacements.set(id, `/api/assets/${copyId}`);
          }
        } catch (error) {
          if (copiedPaths.length) await removeAssetFiles(root, copiedPaths);
          if (error instanceof InvalidNoteAssetsError)
            return jsonError(400, "INVALID_ASSET", "图片引用无效或附件当前不可用，随记未被删除");
          throw error;
        }
      }

      const convert = database.transaction(() => {
        const current = getMemo(database, user.id, memoId);
        if (!current) {
          const previous = first<{ note_id: string }>(
            database,
            "SELECT note_id FROM memo_conversions WHERE user_id = ? AND memo_id = ? AND memo_version = ?",
            user.id,
            memoId,
            payload.version as number,
          );
          return previous
            ? { kind: "replayed" as const, noteId: previous.note_id }
            : { kind: "missing" as const };
        }
        if (current.version !== payload.version) return { kind: "conflict" as const, current };
        const inbox = first<{ id: string }>(
          database,
          "SELECT id FROM notebooks WHERE user_id = ? AND is_system = 1 LIMIT 1",
          user.id,
        );
        if (!inbox) return { kind: "no_inbox" as const };
        const duplicateAsset = database.query(
          `INSERT INTO image_assets (id, user_id, storage_path, original_name, mime_type, byte_size, width, height, created_at)
             SELECT ?, user_id, ?, original_name, mime_type, byte_size, width, height, ?
             FROM image_assets WHERE id = ? AND user_id = ?`,
        );
        const copiedAt = now();
        for (const item of preparedAssets) {
          duplicateAsset.run(item.copyId, item.copyPath, copiedAt, item.sourceId, user.id);
        }
        const contentMarkdown = replacements.size
          ? rewriteMarkdownAssetDestinations(current.content_markdown, (id) => replacements.get(id))
          : current.content_markdown;
        if (!validNoteAssetReferences(database, user.id, null, contentMarkdown))
          throw new InvalidNoteAssetsError();
        const noteId = createNote(database, user.id, inbox.id, "", contentMarkdown);
        const deleted = database
          .query("DELETE FROM memos WHERE id = ? AND user_id = ? AND version = ?")
          .run(memoId, user.id, current.version);
        if (!deleted.changes) throw new Error("memo-conversion-delete-failed");
        database
          .query(
            "INSERT INTO memo_conversions (user_id, memo_id, memo_version, note_id) VALUES (?, ?, ?, ?)",
          )
          .run(user.id, memoId, current.version, noteId);
        return { kind: "converted" as const, noteId };
      });
      let result: ReturnType<typeof convert.immediate>;
      try {
        result = convert.immediate();
      } catch (error) {
        if (copiedPaths.length) await removeAssetFiles(root, copiedPaths);
        if (error instanceof InvalidNoteAssetsError)
          return jsonError(400, "INVALID_ASSET", "图片引用无效或附件当前不可用，随记未被删除");
        throw error;
      }
      if (result.kind !== "converted" && copiedPaths.length) {
        await removeAssetFiles(root, copiedPaths);
      }
      if (result.kind === "missing") return jsonError(404, "MEMO_NOT_FOUND", "随记不存在");
      if (result.kind === "conflict")
        return json(
          {
            error: {
              code: "VERSION_CONFLICT",
              message: "这条随记已更新，请刷新后重试",
              current: memoFromRow(result.current),
            },
          },
          409,
        );
      if (result.kind === "no_inbox") return jsonError(400, "NO_NOTEBOOK", "没有可用的收件箱");
      const note = getNote(database, user.id, result.noteId);
      if (!note) throw new Error("memo-conversion-note-missing");
      if (result.kind === "replayed") return json({ note: toFullNote(note) });
      publishWorkspaceChange(ctx.options, user.id, { resource: "memos" }, ctx.request);
      publishWorkspaceChange(ctx.options, user.id, { resource: "notebooks" }, ctx.request);
      return json({ note: toFullNote(note) }, 201);
    })();
  }

  if (segments.length === 2) {
    const memoId = segments[1];
    if (!MEMO_ID_PATTERN.test(memoId)) return jsonError(400, "INVALID_MEMO_ID", "随记 ID 无效");
    return memoMutation(ctx, user, memoId);
  }
  return null;
}
