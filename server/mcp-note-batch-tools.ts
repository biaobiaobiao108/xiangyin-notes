import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { NOTE_CONTENT_MAX_LENGTH } from "./core";
import {
  noteTagsSchema,
  validMcpTags,
  invalidMcpTagsError,
  countUnicodeCharacters,
  findTextMatches,
  compactConflictNote,
  conciseWriteNote,
  routeError,
  normalizeMcpError,
  isDeletedNote,
  noteInTrashError,
  noteWriteError,
  notesRoute,
  updateNoteRoute,
  resolveNotebook,
  type McpToolContext,
} from "./mcp-helpers";

export function registerMcpNoteBatchTools(
  server: McpServer,
  { options, user, responseValue }: McpToolContext,
) {
  server.registerTool(
    "insert_into_note",
    {
      title: "按锚点插入正文",
      description:
        "在精确锚点前后插入；歧义需 occurrence 或 insertAll，行边界自动补换行。 图片仅接受 HTTPS 地址或当前用户可用于该笔记的已上传附件，MCP 不上传图片。",
      inputSchema: z
        .object({
          noteId: z.string().min(1).max(200),
          expectedVersion: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("可选的预期版本；省略时服务端读取当前版本"),
          anchor: z.string().min(1).max(2000).describe("正文中精确的原文片段"),
          contentMarkdown: z
            .string()
            .min(1)
            .max(NOTE_CONTENT_MAX_LENGTH)
            .describe("要在锚点前或后插入的 Markdown 内容"),
          insertAll: z
            .boolean()
            .optional()
            .describe("设为 true 时在所有非重叠 anchor 匹配处插入，不能与 occurrence 同时使用"),
          occurrence: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe("可选的匹配序号，从 1 开始；不传时要求 anchor 只出现一次"),
          position: z.enum(["before", "after"]).optional().describe("插入位置，默认 after"),
          includeContent: z
            .boolean()
            .optional()
            .describe("是否在成功结果中回传完整正文，默认 false"),
        })
        .strict(),
    },
    async ({
      noteId,
      expectedVersion: version,
      anchor,
      contentMarkdown,
      insertAll = false,
      occurrence,
      position = "after",
      includeContent = false,
    }) => {
      if (!user)
        return responseValue(
          { error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } },
          true,
        );
      if (insertAll && occurrence !== undefined) {
        return responseValue(
          {
            error: {
              code: "INVALID_INSERTION_SELECTOR",
              message: "insertAll=true 与 occurrence 不能同时使用，请只选择一种插入方式",
            },
          },
          true,
        );
      }
      const current = await notesRoute(
        options,
        user,
        "GET",
        ["notes", noteId],
        `/api/notes/${encodeURIComponent(noteId)}`,
      );
      if (current.status !== 200) return routeError(current);
      const note = current.body.note as Record<string, unknown> | undefined;
      if (typeof note?.contentMarkdown !== "string" || typeof note.version !== "number")
        return responseValue(
          { error: { code: "NOTE_READ_FAILED", message: "读取笔记正文或版本失败" } },
          true,
        );
      if (version !== undefined && note.version !== version) {
        return responseValue(
          {
            error: {
              code: "VERSION_CONFLICT",
              message: "这篇笔记已在别处更新",
              current: note,
            },
          },
          true,
        );
      }
      if (isDeletedNote(note)) return noteInTrashError();
      const body = note.contentMarkdown;
      // Matches are counted non-overlapping, exactly like replace_in_note, so both tools
      // report the same matchCount for the same text.
      const search = findTextMatches(body, anchor, {
        occurrence: insertAll ? undefined : occurrence,
      });
      if (search.matchCount === 0)
        return responseValue(
          { error: { code: "NOT_FOUND", target: "anchor", message: "正文中找不到指定 anchor" } },
          true,
        );
      if (occurrence !== undefined && search.selectedOffset === null) {
        return responseValue(
          {
            error: {
              code: "NOT_FOUND",
              target: "occurrence",
              message: `occurrence=${occurrence} 超出匹配数量 ${search.matchCount}，笔记未修改`,
              matchCount: search.matchCount,
              matches: search.matches,
              truncated: search.truncated,
            },
          },
          true,
        );
      }
      if (!insertAll && occurrence === undefined && search.matchCount > 1) {
        return responseValue(
          {
            error: {
              code: "AMBIGUOUS_MATCH",
              target: "anchor",
              message: `anchor 在正文中出现 ${search.matchCount} 次；请提供更长的片段、设置 occurrence 指定目标，或设 insertAll=true 在全部匹配处插入。`,
              matchCount: search.matchCount,
              matches: search.matches,
              truncated: search.truncated,
            },
          },
          true,
        );
      }
      const firstMatch =
        occurrence === undefined ? search.matches[0].offset : search.selectedOffset!;
      const insertionPoint = position === "before" ? firstMatch : firstMatch + anchor.length;
      const lineEnding = body.includes("\r\n") ? "\r\n" : body.includes("\r") ? "\r" : "\n";
      const insertionAt = (point: number) => {
        let insertion = contentMarkdown;
        if (
          position === "before" &&
          (point === 0 || body[point - 1] === "\n" || body[point - 1] === "\r") &&
          !/(?:\r\n|\r|\n)$/u.test(insertion)
        ) {
          insertion += lineEnding;
        }
        if (
          position === "after" &&
          (point === body.length || body[point] === "\n" || body[point] === "\r") &&
          !/^(?:\r\n|\r|\n)/u.test(insertion)
        ) {
          insertion = `${lineEnding}${insertion}`;
        }
        return insertion;
      };
      let insertedCharacters = insertAll
        ? search.matchCount * countUnicodeCharacters(contentMarkdown)
        : 0;
      if (insertAll) {
        let searchFrom = 0;
        while (searchFrom <= body.length) {
          const offset = body.indexOf(anchor, searchFrom);
          if (offset === -1) break;
          const point = position === "before" ? offset : offset + anchor.length;
          insertedCharacters +=
            countUnicodeCharacters(insertionAt(point)) - countUnicodeCharacters(contentMarkdown);
          searchFrom = offset + anchor.length;
        }
      } else {
        insertedCharacters = countUnicodeCharacters(insertionAt(insertionPoint));
      }
      const resultingCharacters = countUnicodeCharacters(body) + insertedCharacters;
      if (resultingCharacters > NOTE_CONTENT_MAX_LENGTH) {
        return responseValue(
          {
            error: {
              code: "NOTE_TOO_LARGE",
              message: `插入后正文将超过 ${NOTE_CONTENT_MAX_LENGTH.toLocaleString("en-US")} 个 Unicode 字符，笔记未修改`,
            },
          },
          true,
        );
      }
      const updatedBody = insertAll
        ? body.replaceAll(anchor, (_match, offset: number) => {
            const insertion = insertionAt(position === "before" ? offset : offset + anchor.length);
            return position === "before" ? `${insertion}${anchor}` : `${anchor}${insertion}`;
          })
        : `${body.slice(0, insertionPoint)}${insertionAt(insertionPoint)}${body.slice(insertionPoint)}`;
      const result = await updateNoteRoute(options, user, {
        noteId,
        version: version ?? note.version,
        contentMarkdown: updatedBody,
        includeContent,
      });
      return result.status === 200
        ? responseValue(
            { ...result.body, insertedCount: insertAll ? search.matchCount : 1 },
            false,
            { writeResult: true, includeContent },
          )
        : noteWriteError(result);
    },
  );

  server.registerTool(
    "batch_update_notes",
    {
      title: "批量更新笔记",
      description:
        "按每篇 expectedVersion 批量管理，逐条报告成功、失败与 noop。partial 固定返回布尔值，仅成功（含 noop）与失败混合时为 true，其他为 false。回收站仅支持单独 deleted=false 恢复。",
      inputSchema: z
        .object({
          notes: z
            .array(
              z
                .object({
                  noteId: z.string().min(1).max(200),
                  expectedVersion: z.number().int().positive(),
                })
                .strict(),
            )
            .min(1)
            .max(50),
          notebookId: z.string().min(1).max(200).optional(),
          notebookName: z.string().trim().min(1).max(40).optional(),
          isFavorite: z
            .boolean()
            .optional()
            .describe("设定收藏目标状态；true 收藏，false 取消收藏，重复传入不反转"),
          deleted: z
            .boolean()
            .optional()
            .describe("目标回收站状态；仅当 deleted=false 且没有其他修改时可恢复回收站笔记"),
          tags: noteTagsSchema
            .optional()
            .describe(
              "追加到每篇笔记正文的标签名，仅可含中文、字母、数字、下划线或连字符，不带 #；仅追加，不会覆盖已有标签",
            ),
          removeTags: noteTagsSchema
            .optional()
            .describe("从每篇笔记正文移除的标签名，仅可含中文、字母、数字、下划线或连字符，不带 #"),
          replaceTags: noteTagsSchema
            .optional()
            .describe(
              "整体替换每篇笔记的标签集合，仅可含中文、字母、数字、下划线或连字符，不带 #；空数组清空所有标签，不能与 tags/removeTags 同时使用",
            ),
        })
        .strict(),
    },
    async ({
      notes,
      notebookId,
      notebookName,
      isFavorite,
      deleted,
      tags,
      removeTags,
      replaceTags,
    }) => {
      if (!user)
        return responseValue(
          { error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } },
          true,
        );
      if (notebookId === undefined && notebookName !== undefined) {
        const resolved = await resolveNotebook(options, user, { notebookName });
        if (resolved.error) return responseValue({ error: resolved.error }, true);
        notebookId = resolved.notebook!.id;
      }
      if (
        [tags, removeTags, replaceTags].some(
          (values) => values !== undefined && !validMcpTags(values),
        )
      ) {
        return invalidMcpTagsError([
          ...(tags ?? []),
          ...(removeTags ?? []),
          ...(replaceTags ?? []),
        ]);
      }
      if (replaceTags !== undefined && (tags !== undefined || removeTags !== undefined)) {
        return responseValue(
          {
            error: {
              code: "INCOMPATIBLE_TAG_OPERATIONS",
              message: "replaceTags 是整体替换操作，不能与追加 tags 或移除 removeTags 同次使用",
            },
          },
          true,
        );
      }
      if (
        notebookId === undefined &&
        isFavorite === undefined &&
        deleted === undefined &&
        !tags?.length &&
        !removeTags?.length &&
        replaceTags === undefined
      ) {
        return responseValue(
          {
            error: {
              code: "EMPTY_UPDATE",
              message:
                "请至少提供 notebookId、isFavorite、deleted、tags、removeTags 或 replaceTags 中的一项",
            },
          },
          true,
        );
      }
      if (new Set(notes.map((note) => note.noteId)).size !== notes.length) {
        return responseValue(
          { error: { code: "DUPLICATE_NOTE_ID", message: "批量更新中不能重复出现同一篇笔记" } },
          true,
        );
      }
      const results: Record<string, unknown>[] = [];
      for (const note of notes) {
        const result = await updateNoteRoute(options, user, {
          noteId: note.noteId,
          version: note.expectedVersion,
          notebookId,
          isFavorite,
          deleted,
          tags,
          removeTags,
          replaceTags,
        });
        if (result.status === 200) {
          const updatedNote = result.body.note as Record<string, unknown> | undefined;
          const noop = updatedNote !== undefined && updatedNote.version === note.expectedVersion;
          results.push({
            noteId: note.noteId,
            ok: true,
            note: conciseWriteNote(updatedNote),
            ...(noop ? { noop: true } : {}),
          });
        } else {
          const rawError =
            result.body.error && typeof result.body.error === "object"
              ? (result.body.error as Record<string, unknown>)
              : { code: "MCP_OPERATION_FAILED", message: "笔记更新失败" };
          const error = normalizeMcpError(rawError);
          results.push({
            noteId: note.noteId,
            ok: false,
            error: {
              code: error.code,
              message: error.message,
              ...(error.target === undefined ? {} : { target: error.target }),
              ...(Object.prototype.hasOwnProperty.call(error, "current")
                ? { current: compactConflictNote(error.current) }
                : {}),
            },
          });
        }
      }
      const failedCount = results.filter((result) => result.ok === false).length;
      const noopCount = results.filter((result) => result.noop === true).length;
      const successfulCount = results.length - failedCount;
      const updatedCount = successfulCount - noopCount;
      // Keep successful no-ops distinct from mutations: a no-op still makes a
      // mixed-success batch recoverable without reporting the whole call as failed.
      const isError = failedCount > 0 && successfulCount === 0;
      return responseValue(
        {
          results,
          updatedCount,
          noopCount,
          failedCount,
          partial: failedCount > 0 && successfulCount > 0,
        },
        isError,
      );
    },
  );
}
