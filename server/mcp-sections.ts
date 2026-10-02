import { createHash } from "node:crypto";
import { marked } from "marked";

export interface MarkdownSection {
  sectionId: string;
  level: number;
  /** Heading text as written in Markdown, without heading delimiters. */
  text: string;
  /** Original Markdown UTF-16 offsets; end is exclusive. */
  start: number;
  end: number;
}

export interface MarkdownSectionSelector {
  sectionId?: string;
  heading?: string;
  /** One-based occurrence among headings with exactly the same text. */
  occurrence?: number;
}

export type MarkdownSectionResult =
  | { section: MarkdownSection }
  | { error: { code: "INVALID_ARGUMENT" | "SECTION_NOT_FOUND" | "SECTION_AMBIGUOUS"; message: string; candidates?: MarkdownSection[] } };

/** Document-level headings only: quoted/list/code/HTML headings are not sections. */
export function parseMarkdownSections(markdown: string): MarkdownSection[] {
  // Marked normalizes line endings. Record only CRLF expansions so token offsets
  // can be mapped back without retaining one offset per character of a long note.
  const crlfOffsets: number[] = [];
  let removed = 0;
  const normalized = markdown.replace(/\r\n?/g, (newline, offset: number) => {
    if (newline.length === 2) {
      crlfOffsets.push(offset - removed + 1);
      removed++;
    }
    return "\n";
  });
  let originalOffsetCursor = 0;
  const toOriginalOffset = (offset: number) => {
    while (originalOffsetCursor < crlfOffsets.length && crlfOffsets[originalOffsetCursor]! <= offset) originalOffsetCursor++;
    return offset + originalOffsetCursor;
  };
  const fingerprint = createHash("sha256").update(markdown).digest("hex");
  const sections: MarkdownSection[] = [];
  const stack: MarkdownSection[] = [];
  let offset = 0;
  for (const token of marked.lexer(normalized)) {
    if (token.type === "heading") {
      const start = toOriginalOffset(offset);
      while (stack.length && stack[stack.length - 1]!.level >= token.depth) stack.pop()!.end = start;
      const section: MarkdownSection = {
        sectionId: `section-${fingerprint}-${sections.length + 1}-${start}`,
        level: token.depth,
        text: token.text,
        start,
        end: markdown.length,
      };
      sections.push(section);
      stack.push(section);
    }
    offset += token.raw.length;
  }
  return sections;
}

export function getMarkdownOutline(markdown: string): MarkdownSection[] {
  return parseMarkdownSections(markdown);
}

export function locateMarkdownSection(markdown: string, selector: MarkdownSectionSelector): MarkdownSectionResult {
  const hasId = selector.sectionId !== undefined;
  const hasHeading = selector.heading !== undefined;
  if (hasId === hasHeading || (hasId && selector.occurrence !== undefined)
    || (hasId && !selector.sectionId)
    || (hasHeading && !selector.heading)
    || (selector.occurrence !== undefined && (!Number.isSafeInteger(selector.occurrence) || selector.occurrence < 1))) {
    return { error: { code: "INVALID_ARGUMENT", message: "提供 sectionId 或 heading 中的一个；occurrence 仅用于 heading，且必须是从 1 开始的整数。" } };
  }
  const sections = parseMarkdownSections(markdown);
  const matches = sections.filter((section) => hasId ? section.sectionId === selector.sectionId : section.text === selector.heading);
  if (hasHeading && selector.occurrence === undefined && matches.length > 1) {
    return { error: { code: "SECTION_AMBIGUOUS", message: "标题存在多个匹配，请提供 occurrence 或使用大纲中的 sectionId。", candidates: matches.slice(0, 10) } };
  }
  const section = matches[(selector.occurrence ?? 1) - 1];
  return section ? { section } : { error: { code: "SECTION_NOT_FOUND", message: "未找到章节；正文变化后旧 sectionId 会失效，请重新读取大纲。" } };
}
