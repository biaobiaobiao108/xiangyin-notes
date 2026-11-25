import { z } from "zod";
import { NOTE_TAG_MAX_LENGTH } from "../shared/tags";

export const MCP_SERVER_INSTRUCTIONS = [
  "象映笔记管理 Markdown 笔记、笔记本和看板。",
  "查找和读取笔记。search_notes 搜索（view=trash 查回收站），get_note 读单篇正文，get_notes_batch 按 ID 批读。get_note_outline 定位章节，get_note_section 读指定章节。",
  "保存和编辑。save_note 是普通保存入口，默认在目标笔记本内防重名。允许同名时用 create_note，传 kanbanStatus 可直接入板。update_note 改标题或完整正文，append_to_note 在文末追加，insert_into_note 按锚点插入，replace_in_note 替换片段，replace_note_section 替换整节。",
  "笔记正文支持 Mermaid 图表，流程、时序或架构用图更清楚时，优先使用语言标记为 `mermaid` 的 Markdown 围栏代码块。",
  "整理笔记。manage_note 移动、收藏、改标签、移入或恢复回收站，batch_update_notes 批量管理多篇。",
  "笔记本。list_notebooks 列出笔记本，ensure_notebook 按名称获取或创建，create_notebook 创建且重名时报错，update_notebook 改名称、颜色或图标，delete_notebook 删除笔记本并把笔记移入收件箱。",
  "看板。list_kanban_cards 查卡片，manage_kanban_card 加入、移动、排序或移出。",
  "从 structuredContent 读取结果，检查 ok 和 error.code，批量操作查看逐项 results。更新笔记用 note.version 作为 expectedVersion。更新笔记本、移动或移出卡片时，用该资源的 updatedAt 作为 expectedUpdatedAt。遇到版本或位置冲突，先重读对应资源再决定是否重试。",
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
