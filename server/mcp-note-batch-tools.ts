import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  noteTagsSchema,
  validMcpTags,
  invalidMcpTagsError,
  compactConflictNote,
  conciseWriteNote,
  normalizeMcpError,
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
    "manage_notes",
    {
      title: "整理笔记",
      description:
        "对 1~50 篇笔记执行移动笔记本、设置收藏、增删/替换标签、移入或恢复回收站；逐条报告成功、失败与 noop。每篇可传 expectedVersion，省略时由服务端读取当前版本（仍使用乐观锁）。回收站仅支持单独 deleted=false 恢复；此工具不提供永久删除。partial 固定返回布尔值，仅成功（含 noop）与失败混合时为 true。",
      inputSchema: z
        .object({
          notes: z
            .array(
              z
                .object({
                  noteId: z.string().min(1).max(200),
                  expectedVersion: z
                    .number()
                    .int()
                    .positive()
                    .optional()
                    .describe("可选预期版本；省略时服务端读取当前版本"),
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
        let version = note.expectedVersion;
        let currentNote: Record<string, unknown> | undefined;
        if (version === undefined) {
          const current = await notesRoute(
            options,
            user,
            "GET",
            ["notes", note.noteId],
            `/api/notes/${encodeURIComponent(note.noteId)}`,
          );
          if (current.status !== 200) {
            const rawError =
              current.body.error && typeof current.body.error === "object"
                ? (current.body.error as Record<string, unknown>)
                : { code: "MCP_OPERATION_FAILED", message: "读取笔记版本失败" };
            const error = normalizeMcpError(rawError);
            results.push({
              noteId: note.noteId,
              ok: false,
              error: {
                code: error.code,
                message: error.message,
                ...(error.target === undefined ? {} : { target: error.target }),
              },
            });
            continue;
          }
          const fetched = current.body.note as Record<string, unknown> | undefined;
          if (
            !fetched ||
            typeof fetched !== "object" ||
            Array.isArray(fetched) ||
            typeof fetched.version !== "number"
          ) {
            results.push({
              noteId: note.noteId,
              ok: false,
              error: { code: "NOTE_READ_FAILED", message: "读取笔记版本失败" },
            });
            continue;
          }
          currentNote = fetched;
          version = fetched.version;
        }
        const result = await updateNoteRoute(options, user, {
          noteId: note.noteId,
          version,
          currentNote,
          notebookId,
          isFavorite,
          deleted,
          tags,
          removeTags,
          replaceTags,
        });
        if (result.status === 200) {
          const updatedNote = result.body.note as Record<string, unknown> | undefined;
          const noop = updatedNote !== undefined && updatedNote.version === version;
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
