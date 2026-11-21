import { z } from "zod";
import { NOTE_TAG_MAX_LENGTH } from "../shared/tags";

export const MCP_SERVER_INSTRUCTIONS = [
  "象映笔记管理 Markdown 笔记、笔记本和看板。用 search_notes 查找笔记，再用 get_note 按 noteId 读正文。只需一个章节时，可先读 get_note_outline，再用 get_note_section。",
  "普通保存用 save_note，默认在目标笔记本内防止重复标题。允许同名或新建时直接入板用 create_note，入板时传 kanbanStatus。分类可按 notebookName 指定，用 ensure_notebook 获取或创建笔记本。用 manage_note 管理收藏、标签和回收站，通过 search_notes 的 view=trash 查找已删除笔记。",
  "用 list_kanban_cards 查看卡片，再用 manage_kanban_card 加入、移动或移出。移动和移出需要将卡片的 updatedAt 传为 expectedUpdatedAt。更新笔记本也用 expectedUpdatedAt，取笔记本自己的 updatedAt。",
  "从 structuredContent 读取结果，检查 ok 和 error.code。批量操作查看 results，按失败项处理。更新已有笔记时，从 note.version 取得 expectedVersion。遇到版本或位置冲突，先重读相应资源，核对改动后再决定是否重试。",
].join("\n\n");

// Keep published JSON Schemas within the broadly supported regular-expression
// subset. Tag syntax is still validated in the MCP handler below.
export const noteTagsSchema = z.array(z.string().trim().min(1).max(NOTE_TAG_MAX_LENGTH)).max(50);
export const validMcpTagName = /^[\p{L}\p{N}_-]+$/u;

export function validMcpTags(tags: readonly string[]) {
  return tags.every((tag) => validMcpTagName.test(tag.trim()));
}

export const noteOperationActionSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("move"),
      noteId: z.string().min(1).max(200),
      expectedVersion: z.number().int().positive().optional(),
      notebookId: z.string().min(1).max(200).optional(),
      notebookName: z.string().trim().min(1).max(40).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("set_favorite"),
      noteId: z.string().min(1).max(200),
      expectedVersion: z.number().int().positive().optional(),
      isFavorite: z
        .boolean()
        .describe("目标收藏状态；true 收藏，false 取消收藏，重复传入结果不反转"),
    })
    .strict(),
  z
    .object({
      action: z.literal("set_tags"),
      noteId: z.string().min(1).max(200),
      expectedVersion: z.number().int().positive().optional(),
      tags: noteTagsSchema.describe(
        "标签名，仅可含中文、字母、数字、下划线或连字符，不带 #；mode=replace 时传空数组以清空",
      ),
      mode: z
        .enum(["replace", "add", "remove"])
        .describe("必填的标签操作方式；replace 整体替换，add 追加，remove 移除"),
    })
    .strict(),
  z
    .object({
      action: z.literal("trash"),
      noteId: z.string().min(1).max(200),
      expectedVersion: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("restore"),
      noteId: z.string().min(1).max(200),
      expectedVersion: z.number().int().positive().optional(),
    })
    .strict(),
]);
// Keep the published MCP schema as a plain object. Some clients incorrectly
// combine a root-level additionalProperties:false with oneOf and reject every
// action field before sending the request. The stricter discriminated union
// below still validates the action-specific field combinations server-side.
export const noteOperationInputSchema = z
  .object({
    action: z.enum(["move", "set_favorite", "set_tags", "trash", "restore"]),
    noteId: z.string().min(1).max(200),
    expectedVersion: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("可选预期版本；省略时服务端读取当前版本，仍使用乐观锁"),
    notebookId: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("仅 action=move 时使用，与 notebookName 至少提供一个"),
    notebookName: z.string().trim().min(1).max(40).optional(),
    isFavorite: z
      .boolean()
      .optional()
      .describe("仅 action=set_favorite 时必填；true 收藏，false 取消收藏"),
    tags: noteTagsSchema
      .optional()
      .describe("仅 action=set_tags 时必填；标签名仅可含中文、字母、数字、下划线或连字符，不带 #"),
    mode: z
      .enum(["replace", "add", "remove"])
      .optional()
      .describe("action=set_tags 时必填；其他 action 不适用"),
  })
  .strict();

export function noteOperationValidationMessage(input: unknown, issues: z.ZodIssue[]) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return "参数必须是包含 action 和 noteId 的对象；expectedVersion 可选。";
  }
  const value = input as Record<string, unknown>;
  const action = value.action;
  if (action === "set_tags") {
    if (!Object.hasOwn(value, "mode"))
      return "action=set_tags 时必须显式传 mode=replace、add 或 remove。";
    if (!Object.hasOwn(value, "tags"))
      return "action=set_tags 时必须传 tags 数组；mode 必须为 replace、add 或 remove。";
    if (issues.some((issue) => issue.path[0] === "mode"))
      return "action=set_tags 的 mode 只能是 replace、add 或 remove。";
    return "action=set_tags 参数无效；请检查 tags 数组、标签格式和必填的 mode。";
  }
  if (
    action === "move" &&
    !Object.hasOwn(value, "notebookId") &&
    !Object.hasOwn(value, "notebookName")
  )
    return "action=move 时必须传 notebookId 或 notebookName。";
  if (action === "set_favorite" && !Object.hasOwn(value, "isFavorite"))
    return "action=set_favorite 时必须传 isFavorite（true 收藏，false 取消收藏）。";
  if (
    (action === "trash" || action === "restore") &&
    issues.some((issue) => issue.code === "unrecognized_keys")
  ) {
    return `action=${action} 只接受 action、noteId 和可选的 expectedVersion。`;
  }
  return "action 与参数不匹配；请只传该 action 需要的字段，并提供有效的 noteId。expectedVersion 可省略，由服务端读取当前版本。";
}
