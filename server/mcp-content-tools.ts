import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { first, NOTE_CONTENT_MAX_LENGTH } from "./core";
import { VALID_NOTEBOOK_ICONS } from "./routes/notebooks";
import { getMarkdownOutline, locateMarkdownSection } from "./mcp-sections";
import {
  noteTagsSchema,
  validMcpTags,
  invalidMcpTagsError,
  withSaveLock,
  appendMarkdownTags,
  conciseWriteNote,
  routeError,
  isDeletedNote,
  noteInTrashError,
  noteWriteError,
  notesRoute,
  notebooksRoute,
  updateNoteRoute,
  noteByTitle,
  resolveNotebook,
  type McpToolContext,
} from "./mcp-helpers";

export function registerMcpContentTools(
  server: McpServer,
  { options, user, responseValue }: McpToolContext,
) {
  server.registerTool(
    "ensure_notebook",
    {
      title: "确保笔记本存在",
      description: "按名称幂等获取或创建笔记本；已有笔记本不修改颜色和图标，返回 created 标记。",
      inputSchema: z
        .object({
          name: z.string().trim().min(1).max(40),
          color: z.string().optional(),
          icon: z.enum(VALID_NOTEBOOK_ICONS).optional(),
        })
        .strict(),
    },
    async ({ name, color, icon }) => {
      if (!user)
        return responseValue(
          { error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } },
          true,
        );
      const existing = await resolveNotebook(options, user, { notebookName: name });
      if (existing.notebook) return responseValue({ notebook: existing.notebook, created: false });
      const created = await notebooksRoute(options, user, "POST", { name, color, icon });
      if (created.status === 201) return responseValue({ ...created.body, created: true });
      if ((created.body.error as Record<string, unknown>)?.code === "NOTEBOOK_EXISTS") {
        const existing = await resolveNotebook(options, user, { notebookName: name });
        if (existing.notebook)
          return responseValue({ notebook: existing.notebook, created: false });
      }
      return routeError(created);
    },
  );

  server.registerTool(
    "save_note",
    {
      title: "保存笔记",
      description:
        "一次定位或创建笔记本并保存。mode 默认 create，同笔记本已有同标题报 NOTE_EXISTS；create 模式省略笔记本放入收件箱；upsert 必须指定笔记本，按标题匹配，更新需 expectedVersion，多篇拒绝。标题匹配忽略 ASCII 大小写，裁剪查询参数首尾空白。 图片仅接受 HTTPS 地址或当前用户可用于该笔记的已上传附件，MCP 不上传图片。",
      inputSchema: z
        .object({
          title: z.string().trim().min(1).max(200),
          contentMarkdown: z.string().max(NOTE_CONTENT_MAX_LENGTH),
          notebook: z
            .object({
              notebookId: z.string().min(1).max(200).optional(),
              notebookName: z.string().trim().min(1).max(40).optional(),
              createIfMissing: z.boolean().optional(),
            })
            .strict()
            .optional(),
          tags: noteTagsSchema.optional(),
          mode: z
            .enum(["create", "upsert"])
            .default("create")
            .describe(
              "默认 create，同笔记本同标题报 NOTE_EXISTS；upsert 更新已有笔记必须 expectedVersion",
            ),
          expectedVersion: z.number().int().positive().optional(),
          includeContent: z.boolean().optional(),
        })
        .strict(),
    },
    async ({
      title,
      contentMarkdown,
      notebook,
      tags = [],
      mode = "create",
      expectedVersion,
      includeContent = false,
    }) => {
      if (!user)
        return responseValue(
          { error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } },
          true,
        );
      if (!validMcpTags(tags)) return invalidMcpTagsError(tags);
      const markdown = appendMarkdownTags(contentMarkdown, tags);
      if (markdown.length > NOTE_CONTENT_MAX_LENGTH)
        return responseValue(
          { error: { code: "NOTE_TOO_LARGE", message: "包含标签的正文超出长度限制" } },
          true,
        );
      if (mode === "upsert" && !notebook?.notebookId && !notebook?.notebookName)
        return responseValue(
          { error: { code: "INVALID_NOTEBOOK_SELECTOR", message: "upsert 必须指定笔记本" } },
          true,
        );
      return withSaveLock(options.database, async () => {
        const resolved = await resolveNotebook(options, user, notebook ?? {});
        if (resolved.error) return responseValue({ error: resolved.error }, true);
        const notebookId =
          resolved.notebook?.id ??
          first<{ id: string }>(
            options.database,
            "SELECT id FROM notebooks WHERE user_id = ? AND is_system = 1 LIMIT 1",
            user.id,
          )?.id;
        if (!notebookId)
          return responseValue(
            { error: { code: "NO_NOTEBOOK", message: "没有可用的收件箱" } },
            true,
          );
        const match = await noteByTitle(options, user, title, false, notebookId);
        if (mode === "create" && ("noteId" in match || match.error.code !== "NOT_FOUND")) {
          const candidates = "noteId" in match ? match.matches : match.error.matches;
          return responseValue(
            {
              error: {
                code: "NOTE_EXISTS",
                target: "title",
                notebookId,
                message:
                  "目标笔记本内已有同标题笔记（忽略 ASCII 大小写）；请指定笔记本并使用 upsert 和候选 version 作为 expectedVersion，或换标题；多篇候选请按 noteId 操作",
                matchCount: "noteId" in match ? 1 : match.error.matchCount,
                matches: candidates,
                truncated: "noteId" in match ? false : match.error.truncated,
              },
            },
            true,
          );
        }
        if (mode === "upsert") {
          if ("noteId" in match) {
            if (expectedVersion === undefined)
              return responseValue(
                {
                  error: {
                    code: "VERSION_REQUIRED",
                    message: "覆盖已有笔记必须提供读取时的 expectedVersion",
                  },
                },
                true,
              );
            const result = await updateNoteRoute(options, user, {
              noteId: match.noteId!,
              version: expectedVersion,
              title,
              contentMarkdown: markdown,
              includeContent,
            });
            return result.status === 200
              ? responseValue({ ...result.body, created: false }, false, {
                  writeResult: true,
                  includeContent,
                })
              : noteWriteError(result);
          }
          if (match.error.code !== "NOT_FOUND")
            return responseValue({ error: { ...match.error, code: "AMBIGUOUS_NOTE" } }, true);
        }
        const result = await notesRoute(
          options,
          user,
          "POST",
          ["notes"],
          `/api/notes${includeContent ? "" : "?response=summary"}`,
          { title, contentMarkdown: markdown, notebookId },
        );
        return result.status === 201
          ? responseValue({ ...result.body, created: true }, false, {
              writeResult: true,
              includeContent,
            })
          : noteWriteError(result);
      });
    },
  );

  const sectionSelector = {
    noteId: z.string().min(1).max(200),
    sectionId: z.string().min(1).max(200).optional(),
    heading: z.string().min(1).max(2000).optional(),
    occurrence: z.number().int().positive().optional(),
  };
  server.registerTool(
    "get_note_outline",
    {
      title: "读取笔记大纲",
      description:
        "读取 Markdown 文档级标题结构和 version；sectionId 在正文修改后失效，不返回正文。",
      inputSchema: z.object({ noteId: sectionSelector.noteId }).strict(),
    },
    async ({ noteId }) => {
      if (!user)
        return responseValue(
          { error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } },
          true,
        );
      const result = await notesRoute(
        options,
        user,
        "GET",
        ["notes", noteId],
        `/api/notes/${encodeURIComponent(noteId)}`,
      );
      if (result.status !== 200) return routeError(result);
      const note = result.body.note as Record<string, unknown>;
      return responseValue({
        note: conciseWriteNote(note),
        version: note.version,
        headings: getMarkdownOutline(note.contentMarkdown as string).map(
          ({ sectionId, level, text }) => ({ sectionId, level, text }),
        ),
      });
    },
  );
  server.registerTool(
    "get_note_section",
    {
      title: "读取笔记章节",
      description:
        "按 sectionId 或精确 heading 读取章节，包含标题和子章节；重复标题用 occurrence 指定。",
      inputSchema: z.object(sectionSelector).strict(),
    },
    async ({ noteId, ...selector }) => {
      if (!user)
        return responseValue(
          { error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } },
          true,
        );
      const result = await notesRoute(
        options,
        user,
        "GET",
        ["notes", noteId],
        `/api/notes/${encodeURIComponent(noteId)}`,
      );
      if (result.status !== 200) return routeError(result);
      const note = result.body.note as Record<string, unknown>;
      const body = note.contentMarkdown as string;
      const located = locateMarkdownSection(body, selector);
      if ("error" in located) return responseValue({ error: located.error }, true);
      const { start, end, ...section } = located.section;
      return responseValue({
        note: conciseWriteNote(note),
        version: note.version,
        section: { ...section, contentMarkdown: body.slice(start, end) },
      });
    },
  );
  server.registerTool(
    "replace_note_section",
    {
      title: "替换笔记章节",
      description:
        "替换整个章节（包括标题及子章节），保留其他正文；重复标题需 occurrence，建议将读取的 version 作为 expectedVersion。 图片仅接受 HTTPS 地址或当前用户可用于该笔记的已上传附件，MCP 不上传图片。",
      inputSchema: z
        .object({
          ...sectionSelector,
          contentMarkdown: z.string().max(NOTE_CONTENT_MAX_LENGTH),
          expectedVersion: z.number().int().positive().optional(),
          includeContent: z.boolean().optional(),
        })
        .strict(),
    },
    async ({
      noteId,
      contentMarkdown,
      expectedVersion: version,
      includeContent = false,
      ...selector
    }) => {
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
      const note = current.body.note as Record<string, unknown>;
      if (version !== undefined && version !== note.version)
        return responseValue(
          {
            error: {
              code: "VERSION_CONFLICT",
              message: "笔记已更新，请重新读取章节",
              current: note,
            },
          },
          true,
        );
      if (isDeletedNote(note)) return noteInTrashError();
      const body = note.contentMarkdown as string;
      const located = locateMarkdownSection(body, selector);
      if ("error" in located) return responseValue({ error: located.error }, true);
      const { start, end } = located.section;
      const lineBreak = body.match(/\r\n|\n|\r/u)?.[0] ?? "\n";
      // Keep a block boundary: a following setext heading must not absorb the
      // replacement's trailing paragraph into its heading text.
      const trailingBreaks =
        contentMarkdown.match(/(?:\r\n|\r|\n)+$/u)?.[0].match(/\r\n|\r|\n/gu)?.length ?? 0;
      const addition =
        end < body.length && contentMarkdown
          ? `${contentMarkdown}${lineBreak.repeat(Math.max(0, 2 - trailingBreaks))}`
          : contentMarkdown;
      const markdown = `${body.slice(0, start)}${addition}${body.slice(end)}`;
      const result = await updateNoteRoute(options, user, {
        noteId,
        version: note.version as number,
        contentMarkdown: markdown,
        includeContent,
      });
      return result.status === 200
        ? responseValue(result.body, false, { writeResult: true, includeContent })
        : noteWriteError(result);
    },
  );
}
