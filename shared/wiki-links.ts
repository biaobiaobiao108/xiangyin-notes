import { Lexer } from "marked";
import { maskHtmlAttributeValues } from "./markdown-attributes";

type MarkdownInterval = { start: number; end: number };
type BlockToken = {
  type: string;
  raw: string;
  text?: string;
  tokens?: BlockToken[];
  items?: BlockToken[];
};

function sourceLineIntervals(source: string): MarkdownInterval[] {
  const lines: MarkdownInterval[] = [];
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character !== "\n" && character !== "\r") continue;
    const end = index + (character === "\r" && source[index + 1] === "\n" ? 2 : 1);
    lines.push({
      start,
      end,
    });
    if (end === index + 2) index += 1;
    start = end;
  }
  if (start < source.length)
    lines.push({
      start,
      end: source.length,
    });
  return lines;
}

/** Finds fenced and indented block code using the same Markdown grammar as the editor. */
export function findCodeFenceIntervals(markdown: string): MarkdownInterval[] {
  if (!/[`~]{3}|\t| {4}/u.test(markdown)) return [];
  const intervals: MarkdownInterval[] = [];
  const normalized = markdown.replace(/\r\n|\r/g, "\n");
  const tokens = new Lexer().blockTokens(normalized);
  const process = (children: BlockToken[], source: string, lines: MarkdownInterval[]) => {
    const lineStarts = [0];
    for (let index = 0; index < source.length; index += 1) {
      if (source[index] === "\n") lineStarts.push(index + 1);
    }
    const lineAt = (offset: number) => {
      let low = 0;
      let high = lineStarts.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (lineStarts[middle]! <= offset) low = middle + 1;
        else high = middle;
      }
      return low - 1;
    };
    let cursor = 0;
    for (const token of children) {
      const start = source.indexOf(token.raw, cursor);
      if (start === -1) continue;
      cursor = start + token.raw.length;
      if (
        token.type !== "code" &&
        token.type !== "blockquote" &&
        token.type !== "list" &&
        token.type !== "list_item"
      )
        continue;
      const tokenLines = lines.slice(lineAt(start), lineAt(cursor - 1) + 1);

      if (token.type === "code") {
        intervals.push({
          start: tokenLines[0]!.start,
          end: tokenLines[tokenLines.length - 1]!.end,
        });
        continue;
      }

      if (token.type === "list" && token.items) {
        process(token.items, token.raw, tokenLines);
      } else if (token.tokens && token.text !== undefined) {
        // Container text loses prefixes/indentation but preserves physical lines.
        // Reuse their source ranges instead of duplicating Markdown's strip rules.
        process(token.tokens, token.text, tokenLines);
      }
    }
  };
  process(tokens as BlockToken[], normalized, sourceLineIntervals(markdown));

  return intervals;
}

/** Finds inline code outside block code, with matching complete backtick runs. */
export function findInlineCodeIntervals(
  markdown: string,
  blocks = findCodeFenceIntervals(markdown),
): MarkdownInterval[] {
  const intervals: MarkdownInterval[] = [];
  const regex = /(?<!`)(`+)(?!`)([\s\S]*?)(?<!`)\1(?!`)/g;
  let start = 0;
  for (let index = 0; index <= blocks.length; index += 1) {
    const end = blocks[index]?.start ?? markdown.length;
    const segment = markdown.slice(start, end);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(segment)) !== null) {
      intervals.push({ start: start + match.index, end: start + match.index + match[0].length });
    }
    start = blocks[index]?.end ?? markdown.length;
    regex.lastIndex = 0;
  }
  return intervals;
}

export type WikiLinkMatch = {
  raw: string;
  target: string;
  label?: string;
  alias?: string;
  start: number;
  end: number;
};

export const WIKI_NOTE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Markdown table cells escape the field separators when serializing.
export const WIKI_LINK_PATTERN =
  /\[\[([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\\?\|(\\\][^\\\]\r\n|]+|[^\\\]\r\n|]+)(?:\\?\|(\\\][^\\\]\r\n|]+|[^\\\]\r\n|]+))?)?\]\]/gi;

export function encodeWikiLinkComponent(value: string) {
  return /[\[\]|\x60<\r\n\\]/u.test(value)
    ? `\\]${encodeURIComponent(JSON.stringify(value))}`
    : value;
}

export function formatWikiLink(target: string, label?: string, alias?: string | null) {
  const fallback = label || "未命名笔记";
  return `[[${target}${label || alias ? `|${encodeWikiLinkComponent(fallback)}` : ""}${alias ? `|${encodeWikiLinkComponent(alias)}` : ""}]]`;
}

/** Decodes a label or alias captured from wiki-link Markdown. */
export function decodeWikiLinkComponent(value: string) {
  if (!value.startsWith("\\]")) return value;
  try {
    const decoded: unknown = JSON.parse(decodeURIComponent(value.slice(2)));
    return typeof decoded === "string" ? decoded : value;
  } catch {
    return value;
  }
}

export function wikiLinkDisplayText(label?: string | null, alias?: string | null) {
  return alias || label || "未命名笔记";
}

export function replaceWikiLinksWithText(
  markdown: string,
  preserveMarkdown = false,
  display = (link: WikiLinkMatch) => wikiLinkDisplayText(link.label, link.alias),
) {
  let cursor = 0;
  const parts: string[] = [];
  for (const link of extractWikiLinks(markdown)) {
    const label = display(link);
    // Escape punctuation before a second Markdown parse so labels stay literal.
    const text = preserveMarkdown
      ? label.replace(/[!-\/:-@\[-`{-~]/g, "\\$&").replace(/\r\n|[\r\n]/g, " ")
      : label;
    parts.push(markdown.slice(cursor, link.start), text);
    cursor = link.end;
  }
  return cursor > 0 ? parts.join("") + markdown.slice(cursor) : markdown;
}

function wikiLinkIsEscaped(source: string, start: number) {
  let preceding = start;
  while (preceding > 0 && source[preceding - 1] === "\\") preceding -= 1;
  return (start - preceding) % 2 === 1;
}

/**
 * Extracts all Wiki-link matches in Markdown outside code fences and inline code.
 */
export function extractWikiLinks(markdown: string): WikiLinkMatch[] {
  if (!markdown || !markdown.includes("[[")) return [];

  const regex = new RegExp(WIKI_LINK_PATTERN.source, WIKI_LINK_PATTERN.flags);
  if (!regex.test(markdown)) return [];
  regex.lastIndex = 0;

  const source = maskHtmlAttributeValues(markdown);
  const codeFences = findCodeFenceIntervals(source);
  const inlineCodes = findInlineCodeIntervals(source, codeFences);
  let codeFenceIndex = 0;
  let inlineCodeIndex = 0;
  const isContainedIn = (
    intervals: MarkdownInterval[],
    index: number,
    start: number,
    end: number,
  ) => {
    while (index < intervals.length && intervals[index]!.end <= start) index += 1;
    const interval = intervals[index];
    return {
      index,
      contains: Boolean(interval && start >= interval.start && end <= interval.end),
    };
  };

  const matches: WikiLinkMatch[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(source)) !== null) {
    const raw = markdown.slice(match.index, match.index + match[0].length);
    const target = match[1]!;
    const label = match[2] ? decodeWikiLinkComponent(match[2]) : undefined;
    const alias = match[3] ? decodeWikiLinkComponent(match[3]) : undefined;
    const start = match.index;
    const end = start + raw.length;

    if (wikiLinkIsEscaped(source, start)) continue;
    const fenceResult = isContainedIn(codeFences, codeFenceIndex, start, end);
    codeFenceIndex = fenceResult.index;
    const inlineResult = isContainedIn(inlineCodes, inlineCodeIndex, start, end);
    inlineCodeIndex = inlineResult.index;
    if (fenceResult.contains || inlineResult.contains) continue;

    matches.push({
      raw,
      target,
      label,
      alias: alias || undefined,
      start,
      end,
    });
  }

  return matches;
}

/**
 * Extracts a concise human-readable snippet around an index in Markdown.
 */
export function extractContextSnippet(
  markdown: string,
  matchStart: number,
  matchEnd: number,
  maxLength = 120,
): string {
  // Find surrounding line or paragraph
  const lineStart = Math.max(0, markdown.lastIndexOf("\n", matchStart - 1) + 1);
  let lineEnd = markdown.indexOf("\n", matchEnd);
  if (lineEnd === -1) lineEnd = markdown.length;

  if (lineEnd - lineStart <= maxLength) return markdown.slice(lineStart, lineEnd).trim();
  const remaining = Math.max(0, maxLength - (matchEnd - matchStart));
  const start = Math.max(lineStart, matchStart - Math.floor(remaining / 2));
  const end = Math.min(lineEnd, Math.max(matchEnd, start + maxLength));
  const prefix = start > lineStart ? "…" : "";
  const suffix = end < lineEnd ? "…" : "";
  return `${prefix}${markdown.slice(start, end).trim()}${suffix}`;
}

export type UnlinkedMentionMatch = {
  start: number;
  end: number;
  matchText: string;
  snippet: string;
};

/**
 * Searches for occurrences of targetTitle in Markdown that are not already part of a wiki link,
 * code block, image, or markdown link URL.
 */
export function findUnlinkedMentionsInMarkdown(
  markdown: string,
  targetTitle: string,
): UnlinkedMentionMatch[] {
  const trimmed = targetTitle.trim();
  if (!trimmed || trimmed.length < 2) return [];

  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const source = maskHtmlAttributeValues(markdown);
  // For words composed of letters/digits, use word boundary; for Chinese, direct regex match
  const isLatinWord = /^[a-zA-Z0-9_-]+$/.test(trimmed);
  const regex = new RegExp(isLatinWord ? `\\b${escaped}\\b` : escaped, "gi");

  // Fast-path: quickly collect raw matches. If there are no candidate matches at all,
  // skip all expensive AST / interval parsing completely.
  const rawMatches: Array<{ start: number; end: number; matchText: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    rawMatches.push({
      start: match.index,
      end: match.index + match[0].length,
      matchText: markdown.slice(match.index, match.index + match[0].length),
    });
  }

  if (rawMatches.length === 0) return [];

  // Intervals to exclude: code fences, inline codes, wiki links, markdown links/images
  const codeBlocks = findCodeFenceIntervals(source);
  const excludedIntervals: MarkdownInterval[] = [
    ...codeBlocks,
    ...findInlineCodeIntervals(source, codeBlocks),
  ];

  // Exclude existing wiki-links
  const wikiRegex = new RegExp(WIKI_LINK_PATTERN.source, WIKI_LINK_PATTERN.flags);
  let wMatch: RegExpExecArray | null;
  while ((wMatch = wikiRegex.exec(source)) !== null) {
    if (!wikiLinkIsEscaped(source, wMatch.index))
      excludedIntervals.push({ start: wMatch.index, end: wMatch.index + wMatch[0].length });
  }

  // Exclude markdown links and images [text](url)
  const mdLinkRegex = /!?\[([^\]]*)\]\(([^)]*)\)/g;
  let mdMatch: RegExpExecArray | null;
  while ((mdMatch = mdLinkRegex.exec(source)) !== null) {
    excludedIntervals.push({ start: mdMatch.index, end: mdMatch.index + mdMatch[0].length });
  }

  // Sort intervals by start for fast pruning
  excludedIntervals.sort((a, b) => a.start - b.start);

  // Coalesce the union so each candidate can advance through exclusions once.
  const mergedIntervals: MarkdownInterval[] = [];
  for (const interval of excludedIntervals) {
    const previous = mergedIntervals[mergedIntervals.length - 1];
    if (previous && interval.start <= previous.end) {
      previous.end = Math.max(previous.end, interval.end);
    } else {
      mergedIntervals.push({ ...interval });
    }
  }

  const results: UnlinkedMentionMatch[] = [];
  let excludedIndex = 0;
  for (const raw of rawMatches) {
    while (
      excludedIndex < mergedIntervals.length &&
      mergedIntervals[excludedIndex]!.end <= raw.start
    )
      excludedIndex += 1;
    const interval = mergedIntervals[excludedIndex];
    if (interval && interval.start < raw.end && raw.start < interval.end) continue;

    results.push({
      start: raw.start,
      end: raw.end,
      matchText: raw.matchText,
      snippet: extractContextSnippet(markdown, raw.start, raw.end),
    });
  }

  return results;
}

/**
 * Converts an unlinked mention at [start, end] into a Wiki-link.
 */
export function linkMentionInMarkdown(
  markdown: string,
  start: number,
  end: number,
  targetId: string,
  targetTitle: string,
): string {
  const mention = markdown.slice(start, end);
  return (
    markdown.slice(0, start) +
    formatWikiLink(targetId, targetTitle, mention === targetTitle ? undefined : mention) +
    markdown.slice(end)
  );
}
