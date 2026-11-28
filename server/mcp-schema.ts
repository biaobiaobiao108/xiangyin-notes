import { z } from "zod";
import { NOTE_TAG_MAX_LENGTH } from "../shared/tags";

export const MCP_SERVER_INSTRUCTIONS = [
  "象映笔记管理 Markdown 笔记、笔记本和看板。",
  "查找和读取笔记。search_notes 搜索（view=trash 查回收站），get_note 读单篇正文，get_notes_batch 按 ID 批读。get_note_outline 定位章节，get_note_section 读指定章节。",
  "保存和编辑。save_note 是新建与覆盖保存入口，默认在目标笔记本内防重名；传 allowDuplicateTitle=true 允许同名，传 kanbanStatus 可在新建时直接入板。update_note 改标题或完整正文，append_to_note 在文末追加，replace_in_note 替换片段，replace_note_section 替换整节。",
  "笔记图表由 Pele 渲染，支持 Mermaid 全部内置图表类型（流程、时序、状态、架构、甘特、桑基、XY、思维导图等）；适合用图时优先使用 `mermaid` 围栏代码块。",
  "整理笔记。manage_notes 对 1~50 篇笔记移动、收藏、改标签、移入或恢复回收站。",
  "笔记本。list_notebooks 列出笔记本，ensure_notebook 按名称获取或创建，update_notebook 改名称、颜色或图标，delete_notebook 删除笔记本并把笔记移入收件箱。",
  "看板。list_kanban_cards 查卡片，manage_kanban_card 加入、移动、排序或移出。",
  "统计口径：wordCount 与 textCharacterCount 均基于渲染后正文（不含 Markdown 语法、链接地址、图片说明与空白，非源码长度）。wordCount 为阅读词数（每个汉字或 emoji 算 1 词，连续字母/数字算 1 词，不含标点）；textCharacterCount 为非空白字素数（含标点，组合 emoji 算 1 个）。",
  "从 structuredContent 读取结果，检查 ok 和 error.code，整理操作查看逐项 results。更新笔记用 note.version 作为 expectedVersion。更新笔记本、移动或移出卡片时，用该资源的 updatedAt 作为 expectedUpdatedAt。遇到版本或位置冲突，先重读对应资源再决定是否重试。",
].join("\n\n");

// Keep published JSON Schemas within the broadly supported regular-expression
// subset. Tag syntax is still validated in the MCP handler below.
export const noteTagsSchema = z.array(z.string().trim().min(1).max(NOTE_TAG_MAX_LENGTH)).max(50);
export const validMcpTagName = /^[\p{L}\p{N}_-]+$/u;

export function validMcpTags(tags: readonly string[]) {
  return tags.every((tag) => validMcpTagName.test(tag.trim()));
}
