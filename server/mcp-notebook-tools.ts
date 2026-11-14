import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { VALID_NOTEBOOK_ICONS } from "./routes/notebooks";
import { routeError, notebooksRoute, resolveNotebook, type McpToolContext } from "./mcp-helpers";

export function registerMcpNotebookTools(
  server: McpServer,
  { options, user, responseValue }: McpToolContext,
) {
  server.registerTool(
    "list_notebooks",
    {
      title: "列出笔记本",
      description: "列出笔记本；count 不含回收站，totalCount 包含回收站，可用于删除确认。",
      inputSchema: z.object({}).strict(),
    },
    async () => {
      if (!user)
        return responseValue(
          { error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } },
          true,
        );
      const result = await notebooksRoute(options, user);
      return result.status === 200 ? responseValue(result.body) : routeError(result);
    },
  );

  server.registerTool(
    "create_notebook",
    {
      title: "创建笔记本",
      description: "创建笔记本；重名报错。需要幂等创建时用 ensure_notebook。",
      inputSchema: z
        .object({
          name: z.string().trim().min(1).max(40).describe("笔记本名称，最多 40 个字符"),
          color: z
            .string()
            .optional()
            .describe(
              "六位十六进制颜色；格式无效时返回 INVALID_ARGUMENT，field=color。预设示例：#718077 松柏绿、#d96245 朱砂、#5b7899 蓝灰、#9c765f 木棕",
            ),
          icon: z
            .enum(VALID_NOTEBOOK_ICONS)
            .optional()
            .describe("笔记本图标标识，例如 folder、book 或 bookmark"),
        })
        .strict(),
    },
    async ({ name, color, icon }) => {
      if (!user)
        return responseValue(
          { error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } },
          true,
        );
      const payload = {
        name,
        ...(color === undefined ? {} : { color }),
        ...(icon === undefined ? {} : { icon }),
      };
      const result = await notebooksRoute(options, user, "POST", payload);
      return result.status === 201 ? responseValue(result.body) : routeError(result);
    },
  );

  server.registerTool(
    "update_notebook",
    {
      title: "更新笔记本",
      description: "按 ID 或名称修改笔记本名称、颜色或图标。",
      inputSchema: z
        .object({
          notebookId: z.string().min(1).max(200).optional(),
          notebookName: z.string().trim().min(1).max(40).optional(),
          name: z
            .string()
            .trim()
            .min(1)
            .max(40)
            .optional()
            .describe("新名称，最多 40 个字符；用于重命名"),
          color: z
            .string()
            .optional()
            .describe(
              "六位十六进制颜色；格式无效时返回 INVALID_ARGUMENT，field=color。预设示例：#718077 松柏绿、#d96245 朱砂、#5b7899 蓝灰、#9c765f 木棕",
            ),
          icon: z
            .enum(VALID_NOTEBOOK_ICONS)
            .optional()
            .describe("笔记本图标标识，例如 folder、book 或 bookmark"),
          expectedUpdatedAt: z
            .number()
            .int()
            .min(0)
            .describe("读取笔记本时的 updatedAt；不一致时返回 NOTEBOOK_CHANGED"),
        })
        .strict(),
    },
    async ({ notebookId, notebookName, name, color, icon, expectedUpdatedAt }) => {
      if (!user)
        return responseValue(
          { error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } },
          true,
        );
      const resolved = await resolveNotebook(options, user, { notebookId, notebookName });
      if (resolved.error) return responseValue({ error: resolved.error }, true);
      notebookId = resolved.notebook?.id;
      if (!notebookId)
        return responseValue(
          {
            error: {
              code: "INVALID_NOTEBOOK_SELECTOR",
              message: "请提供 notebookId 或 notebookName",
            },
          },
          true,
        );

      if (name === undefined && color === undefined && icon === undefined) {
        return responseValue(
          { error: { code: "EMPTY_UPDATE", message: "请至少提供一个要更新的字段" } },
          true,
        );
      }
      const payload = {
        ...(name === undefined ? {} : { name }),
        ...(color === undefined ? {} : { color }),
        ...(icon === undefined ? {} : { icon }),
        expectedUpdatedAt,
      };
      const result = await notebooksRoute(options, user, "PATCH", payload, notebookId);
      return result.status === 200 ? responseValue(result.body) : routeError(result);
    },
  );

  server.registerTool(
    "delete_notebook",
    {
      title: "删除笔记本（笔记转入收件箱）",
      description:
        "删除笔记本，将所有笔记移入收件箱并使旧版本失效；dryRun 预览，正式执行需 confirm=true。",
      inputSchema: z
        .object({
          notebookId: z.string().min(1).max(200).optional(),
          notebookName: z.string().trim().min(1).max(40).optional(),
          dryRun: z.boolean().optional(),
          confirm: z.literal(true).optional().describe("确认删除该笔记本；操作不可逆"),
          expectedNoteCount: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe(
              "可选的预期笔记总数，来自 list_notebooks 的 totalCount（包括回收站）；不一致时拒绝删除",
            ),
        })
        .strict(),
    },
    async ({ notebookId, notebookName, expectedNoteCount, confirm, dryRun = false }) => {
      if (!user)
        return responseValue(
          { error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } },
          true,
        );
      const resolved = await resolveNotebook(options, user, { notebookId, notebookName });
      if (resolved.error) return responseValue({ error: resolved.error }, true);
      notebookId = resolved.notebook?.id;
      if (!notebookId)
        return responseValue(
          {
            error: {
              code: "INVALID_NOTEBOOK_SELECTOR",
              message: "请提供 notebookId 或 notebookName",
            },
          },
          true,
        );

      if (resolved.notebook?.isSystem)
        return responseValue(
          { error: { code: "SYSTEM_NOTEBOOK", message: "收件箱不能删除" } },
          true,
        );
      if (dryRun)
        return responseValue({
          wouldDeleteNotebook: resolved.notebook!.name,
          wouldMoveNotes: resolved.notebook!.totalCount,
        });
      if (!confirm)
        return responseValue(
          { error: { code: "CONFIRMATION_REQUIRED", message: "正式删除必须传 confirm=true" } },
          true,
        );
      const result = await notebooksRoute(
        options,
        user,
        "DELETE",
        expectedNoteCount === undefined ? undefined : { expectedNoteCount },
        notebookId,
      );
      return result.status === 200 ? responseValue(result.body) : routeError(result);
    },
  );
}
