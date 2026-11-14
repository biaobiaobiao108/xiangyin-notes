export const RICH_MARKDOWN_MAX_CHARACTERS = 200_000;

export type MarkdownSourceReason = "large" | "frontmatter" | "footnote" | "reference-link" | "html";

const AUTOLINK_PATTERN = /<(?:https?:\/\/|mailto:)[^>\s]+>/giu;
const APP_GENERATED_MARK_PATTERN = /<mark\b[^>]*\bdata-color="[^"]*"[^>]*>/giu;
const APP_GENERATED_ANNOTATION_PATTERN = /<span\b[^>]*\bdata-annotation-id="[^"]*"[^>]*>/giu;
const RAW_HTML_PATTERN = /<\/?[A-Za-z][^>]*>/u;

function withoutAppGeneratedMarkup(markdown: string) {
  return markdown
    .replace(AUTOLINK_PATTERN, "")
    .replace(APP_GENERATED_MARK_PATTERN, "")
    .replace(/<\/mark>/giu, "")
    .replace(APP_GENERATED_ANNOTATION_PATTERN, "")
    .replace(/<\/span>/giu, "");
}

/**
 * The rich editor intentionally supports a controlled Markdown subset. Notes that
 * contain syntax it cannot round-trip open in source mode so an autosave cannot
 * silently rewrite the user's file.
 */
export function markdownSourceModeReason(markdown: string): MarkdownSourceReason | null {
  if (markdown.length > RICH_MARKDOWN_MAX_CHARACTERS) return "large";
  if (/^(?:\uFEFF)?---[ \t]*\r?\n(?:[^\n]*\r?\n)*?---[ \t]*(?:\r?\n|$)/u.test(markdown))
    return "frontmatter";
  if (/(?:^|\n)\[\^[^\]\n]+\]/u.test(markdown)) return "footnote";
  if (/^ {0,3}\[[^\]\n]+\]:[ \t]*\S+/mu.test(markdown)) return "reference-link";
  if (RAW_HTML_PATTERN.test(withoutAppGeneratedMarkup(markdown))) return "html";
  return null;
}

export function markdownSourceModeNotice(reason: MarkdownSourceReason | null) {
  switch (reason) {
    case "large":
      return "正文较长，已使用源码模式打开，避免富文本编辑器解析时卡顿。";
    case "frontmatter":
      return "此笔记包含 frontmatter，富文本编辑器无法原样保留，已使用源码模式。";
    case "footnote":
      return "此笔记包含脚注语法，富文本编辑器无法原样保留，已使用源码模式。";
    case "reference-link":
      return "此笔记包含引用式链接定义，富文本编辑器无法原样保留，已使用源码模式。";
    case "html":
      return "此笔记包含富文本编辑器不支持的 HTML，已使用源码模式，避免保存时改写内容。";
    default:
      return "";
  }
}
