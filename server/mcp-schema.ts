import { z } from "zod";
import { NOTE_TAG_MAX_LENGTH } from "../shared/tags";

export const MCP_SERVER_INSTRUCTIONS = [
  "完整机器数据仅在 structuredContent 中，content 只给简短说明；客户端必须透传 structuredContent。检查 ok 和 error.code，可恢复业务分支不标记为工具异常；批量结果另检查 partial 与逐项 results。",
  "象映笔记是跨会话 Markdown 记忆库，可搜索、读取、新建和增量修改笔记，也可管理笔记本、收藏、标签、回收站。",
  "工具参数必须是 JSON 对象。客户端会先校验参数；手写原始 JSON 时，字符串中的控制字符须按 JSON 规范转义（换行写作 \\n）；结构化参数中的多行 Markdown 会原样保留。",
  "字段值不合法时使用统一错误码 INVALID_ARGUMENT，并通过 field 指明字段；当前 field 取值为 name、color、icon、tags。标签错误还会在 invalidTags 中列出违规值。",
  "普通笔记应优先在 save_note 一次写入完整正文；其默认 create 在目标笔记本内防重名；create_note 仅在有意允许同名时使用；只有客户端明确无法承载单次参数，或服务端返回 MCP 请求体超过 4.5 MB 的错误时，才用 append_to_note 分段追加并将返回的 version 作为 expectedVersion。单篇正文硬上限为 1,000,000 个 UTF-16 code units。markdownCharacterCount 回执与批量读取字符预算按 Unicode code points 计算。写操作默认不回传正文。",
  "单篇读取、批量读取和成功写入的 note 提供整篇正文统计：markdownCharacterCount 是原始 Markdown 的 Unicode code points 数（含语法与空白）；textCharacterCount 是显示正文的非空白字素数（含标点），wordCount 按汉字和 emoji 每个一字、连续英文或数字一词计，不含标点和空白。标题字段、图片与图片说明不计入正文，代码、表格文字及双链显示文字计入；统计不依赖 includeContent，搜索列表不解析全文统计。",
  "分类可直接传 notebookName，notebookId 同时存在时优先；ensure_notebook 幂等创建，save_note 可一次创建笔记本并保存笔记；create_notebook 创建笔记本，update_notebook 修改，delete_notebook 需 confirm=true 并建议用 totalCount 做二次确认。局部编辑和仅改标题可省略 expectedVersion，由服务端读取当前版本并以乐观锁保存；所有写入的版本参数统一 expectedVersion，不接受 version/baseVersion 别名；全文覆盖必须提供 expectedVersion，save_note 的 upsert 更新已有笔记也必须提供 expectedVersion；batch_update_notes 必须提供每篇读取时的 expectedVersion。所有 VERSION_CONFLICT 的 current 只返回有界摘要、长度、版本与元数据，需要时用 get_note/get_note_section 读取正文。",
  "create_note.tags 与 batch_update_notes.tags 是追加；manage_note 的 set_tags 必须显式传 mode=replace、add 或 remove。正文中未转义、代码区外且不超过 40 个 UTF-16 code units 的 #标签会被索引；可在井号前加反斜杠保留字面井号。回收站笔记可恢复，但 MCP 不提供永久删除笔记或清空回收站。",
  "用 search_notes 的 view=trash 检索回收站。get_notes_batch 最多读 50 篇、总正文默认预算 20,000 个 Unicode 字符；各笔记分别读取，不构成同一时刻快照。",
  "MCP 只传输文字和 Markdown，不提供图片数据、缩略图或图片上传；正文可引用 HTTPS 图片地址或当前用户可用于该笔记的已上传附件，无效或不可用的图片引用会被拒绝。",
].join(" ");

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
