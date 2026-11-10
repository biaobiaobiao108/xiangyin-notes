import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { NOTE_CONTENT_MAX_LENGTH } from "./core";
import {
  noteOperationActionSchema,
  noteOperationInputSchema,
  validMcpTags,
  invalidMcpTagsError,
  countUnicodeCharacters,
  findTextMatches,
  routeError,
  isDeletedNote,
  noteInTrashError,
  noteOperationValidationMessage,
  noteWriteError,
  notesRoute,
  appendToMarkdown,
  updateNoteRoute,
  resolveNotebook,
  type McpToolContext,
} from "./mcp-helpers";

export function registerMcpNoteEditTools(
  server: McpServer,
  { options, user, responseValue }: McpToolContext,
) {
  server.registerTool(
    "replace_in_note",
    {
      title: "替换笔记片段",
      description:
        "替换精确片段；歧义需 occurrence 或 replaceAll。applyToLatest 将替换应用到最新正文，写入仍使用乐观锁。 图片仅接受 HTTPS 地址或当前用户可用于该笔记的已上传附件，MCP 不上传图片。",
      inputSchema: z
        .object({
          noteId: z.string().min(1).max(200),
          oldText: z
            .string()
            .min(1)
            .max(NOTE_CONTENT_MAX_LENGTH)
            .describe("正文中要查找的精确文本"),
          newText: z
            .string()
            .max(NOTE_CONTENT_MAX_LENGTH)
            .describe("替换后的文本；支持多行 Markdown"),
          replaceAll: z
            .boolean()
            .optional()
            .describe("设为 true 时替换所有非重叠匹配，不能与 occurrence 同时使用"),
          occurrence: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe("可选的匹配序号，从 1 开始；不传时要求 oldText 只出现一次"),
          expectedVersion: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("可选的预期版本；传入时默认必须与当前版本一致"),
          applyToLatest: z
            .boolean()
            .optional()
            .describe(
              "显式设为 true 时忽略调用方传入的旧 expectedVersion，并基于服务端刚读取的正文重试替换",
            ),
          includeContent: z
            .boolean()
            .optional()
            .describe("是否在成功结果中回传完整正文，默认 false"),
        })
        .strict(),
    },
    async ({
      noteId,
      oldText,
      newText,
      replaceAll = false,
      occurrence,
      expectedVersion: version,
      applyToLatest = false,
      includeContent = false,
    }) => {
      try {
        if (!user)
          return responseValue(
            { error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } },
            true,
          );
        if (replaceAll && occurrence !== undefined) {
          return responseValue(
            {
              error: {
                code: "INVALID_REPLACEMENT_SELECTOR",
                message: "replaceAll=true 与 occurrence 不能同时使用，请只选择一种替换方式",
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
        if (typeof note?.contentMarkdown !== "string" || typeof note.version !== "number") {
          return responseValue(
            { error: { code: "NOTE_READ_FAILED", message: "读取笔记正文或版本失败" } },
            true,
          );
        }
        if (version !== undefined && version !== note.version && !applyToLatest) {
          return responseValue(
            {
              error: {
                code: "VERSION_CONFLICT",
                message:
                  "这篇笔记已在别处更新；请读取最新正文后重试，或显式设置 applyToLatest=true 将替换应用到最新正文",
                current: note,
              },
            },
            true,
          );
        }
        if (isDeletedNote(note)) return noteInTrashError();
        const body = note.contentMarkdown;
        const search = findTextMatches(body, oldText, {
          occurrence: replaceAll ? undefined : occurrence,
        });
        if (search.matchCount === 0)
          return responseValue(
            {
              error: {
                code: "NOT_FOUND",
                target: "text",
                message: "正文中找不到 oldText，笔记未修改",
              },
            },
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
        if (!replaceAll && occurrence === undefined && search.matchCount > 1) {
          return responseValue(
            {
              error: {
                code: "AMBIGUOUS_MATCH",
                target: "text",
                message: `oldText 在正文中出现 ${search.matchCount} 次；请提供更长的片段、设置 occurrence 指定目标，或设 replaceAll=true 替换全部。`,
                matchCount: search.matchCount,
                matches: search.matches,
                truncated: search.truncated,
              },
            },
            true,
          );
        }
        const replacedCount = replaceAll ? search.matchCount : 1;
        const resultingCharacters =
          countUnicodeCharacters(body) +
          replacedCount * (countUnicodeCharacters(newText) - countUnicodeCharacters(oldText));
        if (resultingCharacters > NOTE_CONTENT_MAX_LENGTH) {
          return responseValue(
            {
              error: {
                code: "NOTE_TOO_LARGE",
                message: `替换后正文将超过 ${NOTE_CONTENT_MAX_LENGTH.toLocaleString("en-US")} 个 Unicode 字符，笔记未修改`,
              },
            },
            true,
          );
        }
        const firstMatch =
          occurrence === undefined ? search.matches[0].offset : search.selectedOffset!;
        const updatedBody = replaceAll
          ? body.replaceAll(oldText, () => newText)
          : `${body.slice(0, firstMatch)}${newText}${body.slice(firstMatch + oldText.length)}`;
        const result = await updateNoteRoute(options, user, {
          noteId,
          version: note.version,
          contentMarkdown: updatedBody,
          includeContent,
        });
        return result.status === 200
          ? responseValue({ ...result.body, replacedCount }, false, {
              writeResult: true,
              includeContent,
            })
          : noteWriteError(result);
      } catch (error) {
        console.error("[MCP] replace_in_note failed", error);
        return responseValue(
          {
            error: {
              code: "MCP_INTERNAL_ERROR",
              message: "片段替换遇到内部错误；请读取笔记确认当前内容后再决定是否重试。",
            },
          },
          true,
        );
      }
    },
  );

  server.registerTool(
    "manage_note",
    {
      title: "笔记管理操作",
      description:
        "移动、设置收藏或标签、移入或恢复回收站；set_tags 必须指定 mode。此工具不提供永久删除。",
      inputSchema: noteOperationInputSchema,
    },
    async (input) => {
      if (!user)
        return responseValue(
          { error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } },
          true,
        );
      const parsedInput = noteOperationActionSchema.safeParse(input);
      if (!parsedInput.success) {
        return responseValue(
          {
            error: {
              code: "INVALID_NOTE_OPERATION",
              message: noteOperationValidationMessage(input, parsedInput.error.issues),
            },
          },
          true,
        );
      }
      const operation = parsedInput.data;
      if (operation.action === "move") {
        const current = await notesRoute(
          options,
          user,
          "GET",
          ["notes", operation.noteId],
          `/api/notes/${encodeURIComponent(operation.noteId)}`,
        );
        if (current.status !== 200) return routeError(current);
        if (isDeletedNote(current.body.note)) return noteInTrashError();
        if (!operation.notebookId && !operation.notebookName)
          return responseValue(
            {
              error: {
                code: "INVALID_NOTE_OPERATION",
                message: "move 必须提供 notebookId 或 notebookName",
              },
            },
            true,
          );
        const resolved = await resolveNotebook(options, user, operation);
        if (resolved.error) return responseValue({ error: resolved.error }, true);
        operation.notebookId = resolved.notebook!.id;
      }

      let currentNote: Record<string, unknown> | undefined;
      let version = operation.expectedVersion;
      if (version === undefined) {
        const current = await notesRoute(
          options,
          user,
          "GET",
          ["notes", operation.noteId],
          `/api/notes/${encodeURIComponent(operation.noteId)}`,
        );
        if (current.status !== 200) return routeError(current);
        if (
          !current.body.note ||
          typeof current.body.note !== "object" ||
          Array.isArray(current.body.note)
        ) {
          return responseValue(
            { error: { code: "NOTE_READ_FAILED", message: "读取笔记版本失败" } },
            true,
          );
        }
        currentNote = current.body.note as Record<string, unknown>;
        if (typeof currentNote.version !== "number")
          return responseValue(
            { error: { code: "NOTE_READ_FAILED", message: "读取笔记版本失败" } },
            true,
          );
        version = currentNote.version;
      }
      if (operation.action === "move") {
        const result = await updateNoteRoute(options, user, {
          noteId: operation.noteId,
          version,
          currentNote,
          notebookId: operation.notebookId,
        });
        if (result.status !== 200) return routeError(result);
        const note = result.body.note as Record<string, unknown> | undefined;
        return responseValue(
          { ...result.body, ...(note?.version === version ? { noop: true } : {}) },
          false,
          { writeResult: true },
        );
      }
      if (operation.action === "set_favorite") {
        const result = await updateNoteRoute(options, user, {
          noteId: operation.noteId,
          version,
          currentNote,
          isFavorite: operation.isFavorite,
        });
        if (result.status !== 200) return routeError(result);
        const note = result.body.note as Record<string, unknown> | undefined;
        return responseValue(
          { ...result.body, ...(note?.version === version ? { noop: true } : {}) },
          false,
          { writeResult: true },
        );
      }
      if (operation.action === "set_tags") {
        if (!validMcpTags(operation.tags)) return invalidMcpTagsError(operation.tags);
        const tagInput =
          operation.mode === "add"
            ? { tags: operation.tags }
            : operation.mode === "remove"
              ? { removeTags: operation.tags }
              : { replaceTags: operation.tags };
        const result = await updateNoteRoute(options, user, {
          noteId: operation.noteId,
          version,
          currentNote,
          ...tagInput,
        });
        if (result.status !== 200) return routeError(result);
        const note = result.body.note as Record<string, unknown> | undefined;
        return responseValue(
          {
            ...result.body,
            mode: operation.mode,
            ...(note?.version === version ? { noop: true } : {}),
          },
          false,
          { writeResult: true },
        );
      }
      if (operation.action === "trash") {
        const result = await updateNoteRoute(options, user, {
          noteId: operation.noteId,
          version,
          currentNote,
          deleted: true,
        });
        if (result.status !== 200) return routeError(result);
        const note = result.body.note as Record<string, unknown> | undefined;
        const noop = note !== undefined && isDeletedNote(note) && note.version === version;
        return responseValue({ ...result.body, ...(noop ? { noop: true } : {}) }, false, {
          writeResult: true,
        });
      }
      const result = await updateNoteRoute(options, user, {
        noteId: operation.noteId,
        version,
        currentNote,
        deleted: false,
      });
      if (result.status !== 200) return routeError(result);
      const note = result.body.note as Record<string, unknown> | undefined;
      const noop = note?.deletedAt === null && note.version === version;
      return responseValue({ ...result.body, ...(noop ? { noop: true } : {}) }, false, {
        writeResult: true,
      });
    },
  );

  server.registerTool(
    "append_to_note",
    {
      title: "追加到笔记",
      description:
        "追加 Markdown；末尾独立标签行保留在新增内容之后。需要换行时在新增文本中包含换行。 图片仅接受 HTTPS 地址或当前用户可用于该笔记的已上传附件，MCP 不上传图片。",
      inputSchema: z
        .object({
          noteId: z.string().min(1).max(200),
          expectedVersion: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("可选的预期版本；省略时服务端读取当前版本"),
          contentMarkdown: z
            .string()
            .min(1)
            .max(NOTE_CONTENT_MAX_LENGTH)
            .describe(
              "要追加的一段 Markdown；正常情况下可一次追加完整新增内容，仅按客户端参数能力或 MCP 请求体上限分段",
            ),
          includeContent: z
            .boolean()
            .optional()
            .describe("是否在成功结果中回传完整正文，默认 false"),
        })
        .strict(),
    },
    async ({ noteId, expectedVersion: version, contentMarkdown, includeContent = false }) => {
      if (!user)
        return responseValue(
          { error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } },
          true,
        );
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
      if (version !== undefined && version !== note.version) {
        return responseValue(
          { error: { code: "VERSION_CONFLICT", message: "这篇笔记已在别处更新", current: note } },
          true,
        );
      }
      if (isDeletedNote(note)) return noteInTrashError();
      const updatedBody = appendToMarkdown(note.contentMarkdown, contentMarkdown);
      const result = await updateNoteRoute(options, user, {
        noteId,
        version: version ?? note.version,
        contentMarkdown: updatedBody,
        includeContent,
      });
      return result.status === 200
        ? responseValue(result.body, false, { writeResult: true, includeContent })
        : noteWriteError(result);
    },
  );
}
