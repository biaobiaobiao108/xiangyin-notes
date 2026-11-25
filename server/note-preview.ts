import { Lexer } from "marked";

export const NOTE_PREVIEW_LIMIT = 180;
export const NOTE_PREVIEW_SCAN_LIMIT = NOTE_PREVIEW_LIMIT + 64;

const NON_BREAKING_SPACE_PATTERN = /\u00a0|&nbsp;|&#0*160;|&#[xX]0*[aA]0;/gu;
const SPACE_BEFORE_PUNCTUATION_PATTERN = / ([,.;:!?。！？、，；：])/gu;
const WIKI_LINK_PREVIEW_PATTERN = /\[\[([^\[\]\r\n]*)\]\]|【【([^【】\r\n]*)】】/gu;
const TASK_LIST_ITEM_PATTERN =
  /^(?:[ \t]{0,3}>[ \t]?)*[ \t]*(?:(?:[-+*]|\d+[.)])[ \t]+)?(?:\[[ xX ]?\]|【[ \u3000xX]?】)(?:[ \t]|$)/u;
const CALLOUT_START_PATTERN = /^[ \t]*>[ \t]*\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/iu;
const HORIZONTAL_RULE_PATTERN = /^[ \t]*(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/u;
const TAG_ONLY_LINE_PATTERN = /^[ \t]*#[\p{L}\p{N}_-]+(?:[\t ]+#[\p{L}\p{N}_-]+)*[ \t]*$/u;
const HEADING_PATTERN = /^[ \t]*#{1,6}[ \t\u3000]/u;
const LIST_ITEM_PREFIX_PATTERN = /^[ \t]*(?:[-+*]|\d+[.)])[ \t\u3000]+/u;
const BLOCKQUOTE_PREFIX_PATTERN = /^[ \t]*>[ \t]?/u;
const ANNOTATION_OPEN_TAG_PATTERN = /<span\b[^>]*\bdata-annotation-id="[^"]*"[^>]*>/gu;

function stripAnnotationMarkup(markdown: string) {
  let source = markdown.replace(ANNOTATION_OPEN_TAG_PATTERN, "");
  const partialStart = source.lastIndexOf("<span");
  if (partialStart !== -1 && !source.slice(partialStart).includes(">"))
    source = source.slice(0, partialStart);
  return source;
}

type PreviewInlineToken = {
  type: string;
  raw: string;
  text?: string;
  tokens?: PreviewInlineToken[];
};

/**
 * Flattens a marked inline AST to plain text for note previews.
 * Images contribute nothing (neither alt text nor the asset URL), raw HTML tags
 * are dropped, and markup is reduced to its text content.
 */
function plainTextFromInlineTokens(tokens: PreviewInlineToken[]): string {
  let text = "";
  for (const token of tokens) {
    if (token.type === "image" || token.type === "html") continue;
    const children = token.tokens;
    if (children && children.length > 0) {
      text += plainTextFromInlineTokens(children);
      continue;
    }
    if (token.type === "br") {
      text += " ";
      continue;
    }
    text += token.text ?? token.raw;
  }
  return text;
}

/**
 * Builds the one-line-ish plain text preview shown in note lists.
 *
 * Uses a positive semantic whitelist model: only readable body lines (paragraphs,
 * headings, and bullet/ordered list items) are extracted into previews. All other
 * rich structures (task lists, tables, code blocks, callouts, horizontal rules,
 * tag-only lines) are excluded by default, while scanning line by line so that
 * work stays bounded for long notes.
 */
export function formatPreview(markdown: string) {
  markdown = stripAnnotationMarkup(markdown);
  const output: string[] = [];
  let outputLength = 0;
  const paragraph: string[] = [];
  let paragraphLength = 0;
  let codeFence: { marker: "`" | "~"; length: number } | null = null;
  let stopped = false;

  const appendLine = (text: string) => {
    const content = text.trim();
    if (!content) return true;

    const separatorLength = output.length > 0 ? 1 : 0;
    const availableLength = NOTE_PREVIEW_LIMIT - outputLength - separatorLength;
    if (availableLength <= 0) {
      stopped = true;
      return false;
    }

    const clippedContent = content.slice(0, availableLength);
    if (!clippedContent) return true;

    output.push(clippedContent);
    outputLength += separatorLength + clippedContent.length;
    if (clippedContent.length < content.length) {
      stopped = true;
      return false;
    }
    return true;
  };

  const flushParagraph = () => {
    if (paragraphLength === 0) return true;
    const text = paragraph.join("");
    paragraph.length = 0;
    paragraphLength = 0;
    return appendLine(text);
  };

  const readPlainText = (rawText: string, maximumLength: number) => {
    if (maximumLength <= 0 || !rawText) return "";
    const text = plainTextFromInlineTokens(new Lexer({ gfm: true }).inlineTokens(rawText))
      .replace(/^(?:\[[ xX ]?\]|【[ \u3000xX]?】)[ \t\u3000]*/u, "")
      .replace(
        WIKI_LINK_PREVIEW_PATTERN,
        (_match, wiki: string | undefined, fullWidth: string | undefined) => {
          // 双链只显示可读部分：有别名用别名，否则用目标标题。
          const body = wiki ?? fullWidth ?? "";
          const separator = body.search(/[|｜]/u);
          return separator === -1 ? body : body.slice(separator + 1);
        },
      )
      .replace(NON_BREAKING_SPACE_PATTERN, " ")
      .replace(/[ \t]+/gu, " ")
      .replace(SPACE_BEFORE_PUNCTUATION_PATTERN, "$1");
    return (text.length > maximumLength ? text.slice(0, maximumLength) : text).trim();
  };

  const readLine = (start: number, bounded = true) => {
    const newlineIndex = markdown.indexOf("\n", start);
    const fullEnd = newlineIndex === -1 ? markdown.length : newlineIndex;
    const end = bounded ? Math.min(fullEnd, start + NOTE_PREVIEW_SCAN_LIMIT) : fullEnd;
    const contentEnd = end > start && markdown[end - 1] === "\r" ? end - 1 : end;
    return {
      start,
      end: contentEnd,
      next: newlineIndex === -1 ? markdown.length : newlineIndex + 1,
      truncated: end < fullEnd,
    };
  };

  const isTableDelimiter = (line: { start: number; end: number }) => {
    const text = markdown.slice(line.start, line.end);
    if (!text.includes("|") || text.length >= NOTE_PREVIEW_SCAN_LIMIT) return false;
    const cells = text
      .trim()
      .replace(/^\||\|$/gu, "")
      .split("|");
    return cells.length > 0 && cells.every((cell) => /^\s*:?-{1,}:?\s*$/u.test(cell));
  };

  let cursor = 0;
  while (cursor < markdown.length && !stopped) {
    const line = readLine(cursor, !codeFence);
    const lineStr = markdown.slice(line.start, line.end);
    const trimmed = lineStr.trim();

    // 1. 围栏代码块
    const fenceMatch = /^[ \t]{0,3}(`{3,}|~{3,})/u.exec(lineStr);
    if (codeFence) {
      if (
        fenceMatch &&
        fenceMatch[1]![0] === codeFence.marker &&
        fenceMatch[1]!.length >= codeFence.length
      ) {
        codeFence = null;
      }
      cursor = line.truncated ? markdown.length : line.next;
      continue;
    }
    if (fenceMatch) {
      flushParagraph();
      codeFence = { marker: fenceMatch[1]![0] as "`" | "~", length: fenceMatch[1]!.length };
      cursor = line.truncated ? markdown.length : line.next;
      continue;
    }

    // 2. 空行
    if (!trimmed) {
      flushParagraph();
      cursor = line.truncated ? markdown.length : line.next;
      continue;
    }

    // 3. 缩进代码（>= 4 个空格或制表符开头）
    if (/^(?: {4,}|\t)/u.test(lineStr)) {
      flushParagraph();
      cursor = line.truncated ? markdown.length : line.next;
      continue;
    }

    // 4. 富结构黑名单排除（除正向白名单外全部排除）
    // 4.1 表格行（当前行含 | 且下一行为分隔线时跳过整个表格）
    if (
      lineStr.includes("|") &&
      line.next < markdown.length &&
      isTableDelimiter(readLine(line.next))
    ) {
      flushParagraph();
      cursor = readLine(line.next).next;
      while (cursor < markdown.length) {
        const row = readLine(cursor, false);
        if (!markdown.slice(row.start, row.end).includes("|")) break;
        cursor = row.next;
      }
      continue;
    }
    // 4.2 分割线
    if (HORIZONTAL_RULE_PATTERN.test(lineStr)) {
      flushParagraph();
      cursor = line.truncated ? markdown.length : line.next;
      continue;
    }
    // 4.3 纯标签行
    if (TAG_ONLY_LINE_PATTERN.test(lineStr)) {
      flushParagraph();
      cursor = line.truncated ? markdown.length : line.next;
      continue;
    }
    // 4.4 待办任务项
    if (TASK_LIST_ITEM_PATTERN.test(lineStr)) {
      flushParagraph();
      cursor = line.truncated ? markdown.length : line.next;
      continue;
    }
    // 4.5 Callout 提示块，跳过连续引用行
    if (CALLOUT_START_PATTERN.test(lineStr)) {
      flushParagraph();
      cursor = line.next;
      while (cursor < markdown.length) {
        const nextLine = readLine(cursor, false);
        const nextStr = markdown.slice(nextLine.start, nextLine.end);
        if (!/^[ \t]*>/u.test(nextStr)) break;
        cursor = nextLine.next;
      }
      continue;
    }

    // 5. 正向语义白名单提取（标题、普通列表项、普通引用、普通正文）
    const available = NOTE_PREVIEW_LIMIT - outputLength - (output.length > 0 ? 1 : 0);

    // 5.1 标题
    if (HEADING_PATTERN.test(lineStr)) {
      flushParagraph();
      const body = lineStr.replace(/^[ \t]*#{1,6}[ \t\u3000]+/u, "");
      appendLine(readPlainText(body, available));
      cursor = line.truncated ? markdown.length : line.next;
      continue;
    }

    // 5.2 普通列表项（已在 4.4 排除待办复选框）
    if (LIST_ITEM_PREFIX_PATTERN.test(lineStr)) {
      flushParagraph();
      const body = lineStr.replace(LIST_ITEM_PREFIX_PATTERN, "");
      appendLine(readPlainText(body, available));
      cursor = line.truncated ? markdown.length : line.next;
      continue;
    }

    // 5.3 普通引用行
    if (BLOCKQUOTE_PREFIX_PATTERN.test(lineStr)) {
      flushParagraph();
      const body = lineStr.replace(BLOCKQUOTE_PREFIX_PATTERN, "");
      appendLine(readPlainText(body, available));
      cursor = line.truncated ? markdown.length : line.next;
      continue;
    }

    // 5.4 普通正文段落
    const paraAvail = available - paragraphLength - (paragraphLength > 0 ? 1 : 0);
    if (paraAvail <= 0) {
      stopped = true;
      break;
    }
    const text = readPlainText(lineStr, paraAvail);
    if (text) {
      if (paragraphLength > 0) {
        paragraph.push("\n");
        paragraphLength += 1;
      }
      paragraph.push(text);
      paragraphLength += text.length;
      if (paragraphLength >= paraAvail) stopped = true;
    }

    cursor = line.truncated ? markdown.length : line.next;
  }

  flushParagraph();
  return output.join("\n").slice(0, NOTE_PREVIEW_LIMIT);
}
