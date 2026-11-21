import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { KanbanCard } from "../shared/types";
import { kanbanRoute, routeError, type McpToolContext } from "./mcp-helpers";
import { KANBAN_STATUSES } from "./routes/kanban";

const idSchema = z.string().trim().min(1).max(200);
const statusSchema = z.enum(KANBAN_STATUSES);
const expectedUpdatedAtSchema = z.number().int().nonnegative();
const actionSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("add"), noteId: idSchema, status: statusSchema.optional() }),
  z.strictObject({
    action: z.literal("move"),
    noteId: idSchema,
    status: statusSchema,
    beforeNoteId: idSchema.optional(),
    expectedUpdatedAt: expectedUpdatedAtSchema,
  }),
  z.strictObject({
    action: z.literal("remove"),
    noteId: idSchema,
    expectedUpdatedAt: expectedUpdatedAtSchema,
  }),
]);

function cardSummary({ noteId, status, updatedAt, note }: KanbanCard) {
  return { noteId, status, updatedAt, title: note.title, notebookId: note.notebookId };
}

export function registerMcpKanbanTools(
  server: McpServer,
  { options, user, responseValue }: McpToolContext,
) {
  const unauthenticated = () =>
    responseValue({ error: { code: "UNAUTHENTICATED", message: "MCP 请求未通过认证" } }, true);

  server.registerTool(
    "list_kanban_cards",
    {
      title: "列出看板卡片",
      description:
        "按看板排序分页读取卡片，可按列、笔记本或笔记 ID 筛选。updatedAt 用于移动或移出卡片；读取正文用 get_note。",
      annotations: { readOnlyHint: true },
      inputSchema: z.strictObject({
        status: statusSchema.optional().describe("inbox 收集箱、doing 进行中、done 已完成"),
        notebookId: idSchema.optional(),
        noteId: idSchema.optional().describe("查找指定笔记关联的卡片"),
        limit: z.number().int().min(1).max(100).optional().describe("每页张数，默认 20"),
        cursor: z
          .string()
          .min(1)
          .max(1024)
          .optional()
          .describe("沿用筛选条件并传入上一页 nextCursor"),
      }),
    },
    async ({ status, notebookId, noteId, limit = 20, cursor }) => {
      if (!user) return unauthenticated();
      const query = new URLSearchParams({ limit: String(limit) });
      if (status !== undefined) query.set("status", status);
      if (notebookId !== undefined) query.set("notebookId", notebookId);
      if (noteId !== undefined) query.set("noteId", noteId);
      if (cursor !== undefined) query.set("cursor", cursor);
      const result = await kanbanRoute(options, user, "GET", { query });
      if (result.status !== 200) return routeError(result);
      const { cards, total, hasMore, nextCursor } = result.body;
      return responseValue({
        cards: (cards as KanbanCard[]).map(cardSummary),
        total,
        hasMore,
        nextCursor,
      });
    },
  );

  server.registerTool(
    "manage_kanban_card",
    {
      title: "管理看板卡片",
      description:
        "加入笔记、跨列移动或列内排序、移出看板。重复加入返回现有卡片和 created=false；移出只解除看板关联。",
      // Publish a plain object for the same client compatibility as manage_note.
      inputSchema: z.strictObject({
        action: z.enum(["add", "move", "remove"]),
        noteId: idSchema,
        status: statusSchema.optional().describe("目标列；add 默认 inbox，move 必填"),
        beforeNoteId: idSchema
          .optional()
          .describe("仅 move 使用；插到目标列的指定卡片前，省略时放在列尾"),
        expectedUpdatedAt: expectedUpdatedAtSchema
          .optional()
          .describe("move 和 remove 必填，使用卡片的 updatedAt"),
      }),
    },
    async (input) => {
      if (!user) return unauthenticated();
      const parsed = actionSchema.safeParse(input);
      if (!parsed.success) {
        return responseValue(
          {
            error: {
              code: "INVALID_ARGUMENT",
              message:
                "add 可传 status；move 必须传 status、expectedUpdatedAt，可传 beforeNoteId；remove 只需 noteId 和 expectedUpdatedAt。",
            },
          },
          true,
        );
      }

      const { action, noteId } = parsed.data;
      if (action === "add") {
        const result = await kanbanRoute(options, user, "POST", {
          payload: { noteId, status: parsed.data.status },
        });
        if (
          result.status === 201 ||
          (result.body.error as { code?: string })?.code === "KANBAN_CARD_EXISTS"
        ) {
          return responseValue({
            card: cardSummary(result.body.card as KanbanCard),
            created: result.status === 201,
          });
        }
        return routeError(result);
      }

      const { expectedUpdatedAt } = parsed.data;
      if (action === "remove") {
        const result = await kanbanRoute(options, user, "DELETE", {
          noteId,
          payload: { expectedUpdatedAt },
        });
        return result.status === 200
          ? responseValue({ noteId, removed: true })
          : routeError(result);
      }

      const { status, beforeNoteId } = parsed.data;
      const result = await kanbanRoute(options, user, "PATCH", {
        noteId,
        payload: { status, beforeNoteId: beforeNoteId ?? null, expectedUpdatedAt },
      });
      return result.status === 200
        ? responseValue({ card: cardSummary(result.body.card as KanbanCard) })
        : routeError(result);
    },
  );
}
