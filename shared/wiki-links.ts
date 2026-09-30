import { Lexer } from "marked";

type MarkdownInterval = { start: number; end: number };

/** Finds fenced and indented block code using the same Markdown grammar as the editor. */
export function findCodeFenceIntervals(markdown: string): MarkdownInterval[] {
  if (!/^[ \t]*(?:`{3}|~{3})|^(?: {4}| {0,3}\t)/m.test(markdown)) return [];
  // Marked normalizes line endings. Keep only the removed CR offsets so ranges
  // continue to address the original Markdown, without a per-character map.
  const removedOffsets: number[] = [];
  const normalized = markdown.replace(/\r\n|\r/g, (lineEnding, offset: number) => {
    if (lineEnding.length === 2) removedOffsets.push(offset - removedOffsets.length);
    return "\n";
  });
  const originalOffset = (offset: number) => {
    let low = 0;
    let high = removedOffsets.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (removedOffsets[middle] < offset) low = middle + 1;
      else high = middle;
    }
    return offset + low;
  };
  const intervals: MarkdownInterval[] = [];
  let offset = 0;
  // Block tokenization suffices here; avoid building an inline AST for the body.
  for (const token of new Lexer().blockTokens(normalized)) {
    const end = offset + token.raw.length;
    if (token.type === "code") intervals.push({ start: originalOffset(offset), end: originalOffset(end) });
    offset = end;
  }
  return intervals;
}

/** Finds inline code outside block code, with matching complete backtick runs. */
export function findInlineCodeIntervals(markdown: string, blocks = findCodeFenceIntervals(markdown)): MarkdownInterval[] {
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
  alias?: string;
  start: number;
  end: number;
};

/**
 * Components containing a structural delimiter use a `\]` marker followed
 * by a URI-encoded JSON string. The marker cannot begin a valid legacy target,
 * which lets the parser keep interpreting every existing link as before.
 */
export const WIKI_LINK_PATTERN = /(?:\[\[|【【)(\\\][^\]】\r\n|｜]+|[^\]】\r\n|｜]+)(?:[|｜](\\\][^\]】\r\n|｜]+|[^\]】\r\n]+))?(?:\]\]|】】)/g;

export type WikiLinkComponentKind = "target" | "alias";

function isEscapableWikiLinkDelimiter(character: string, kind: WikiLinkComponentKind) {
  return character === "]" || character === "】" || character === "\r" || character === "\n"
    || (kind === "target" && (character === "|" || character === "｜"));
}

/** Encodes a target or alias so it can be written inside a wiki-link. */
export function encodeWikiLinkComponent(value: string, kind: WikiLinkComponentKind = "target") {
  const hasDelimiter = [...value].some((character) => isEscapableWikiLinkDelimiter(character, kind));
  if (!hasDelimiter) return value;
  return `\\]${encodeURIComponent(JSON.stringify(value))}`;
}

/** Decodes a target or alias captured from wiki-link Markdown. */
export function decodeWikiLinkComponent(value: string) {
  if (!value.startsWith("\\]")) return value;
  try {
    const decoded: unknown = JSON.parse(decodeURIComponent(value.slice(2)));
    return typeof decoded === "string" ? decoded : value;
  } catch {
    return value;
  }
}

export function normalizeLinkTitle(title: string) {
  return title.trim().normalize("NFKC").toLocaleLowerCase("zh-CN");
}

/**
 * Extracts all Wiki-link matches in Markdown outside code fences and inline code.
 */
export function extractWikiLinks(markdown: string): WikiLinkMatch[] {
  if (!markdown || (!markdown.includes("[[") && !markdown.includes("【【"))) return [];

  const codeFences = findCodeFenceIntervals(markdown);
  const inlineCodes = findInlineCodeIntervals(markdown, codeFences);
  const isInsideCode = (start: number, end: number) => {
    return codeFences.some((f) => start >= f.start && end <= f.end) ||
      inlineCodes.some((c) => start >= c.start && end <= c.end);
  };

  const matches: WikiLinkMatch[] = [];
  const regex = new RegExp(WIKI_LINK_PATTERN.source, "g");
  let match: RegExpExecArray | null;

  while ((match = regex.exec(markdown)) !== null) {
    const raw = match[0];
    const target = decodeWikiLinkComponent(match[1] ?? "").trim();
    const alias = match[2] ? decodeWikiLinkComponent(match[2]).trim() : undefined;
    const start = match.index;
    const end = start + raw.length;

    if (!target) continue;
    if (isInsideCode(start, end)) continue;

    matches.push({
      raw,
      target,
      alias: alias || undefined,
      start,
      end,
    });
  }

  return matches;
}

/**
 * Extracts unique target titles from Markdown.
 */
export function extractWikiLinkTargets(markdown: string): string[] {
  const links = extractWikiLinks(markdown);
  const seen = new Set<string>();
  const targets: string[] = [];

  for (const link of links) {
    const key = normalizeLinkTitle(link.target);
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(link.target);
  }

  return targets;
}

/**
 * Extracts a concise human-readable snippet around an index in Markdown.
 */
export function extractContextSnippet(markdown: string, matchStart: number, matchEnd: number, maxLength = 120): string {
  // Find surrounding line or paragraph
  const lineStart = Math.max(0, markdown.lastIndexOf("\n", matchStart - 1) + 1);
  let lineEnd = markdown.indexOf("\n", matchEnd);
  if (lineEnd === -1) lineEnd = markdown.length;

  let snippet = markdown.slice(lineStart, lineEnd).trim();

  // If the line is very long, center around match
  if (snippet.length > maxLength) {
    const offsetInSnippet = matchStart - lineStart;
    const half = Math.floor(maxLength / 2);
    const start = Math.max(0, offsetInSnippet - half);
    const end = Math.min(snippet.length, start + maxLength);
    const prefix = start > 0 ? "…" : "";
    const suffix = end < snippet.length ? "…" : "";
    snippet = `${prefix}${snippet.slice(start, end).trim()}${suffix}`;
  }

  return snippet;
}

/**
 * Replaces all Wiki-link references to oldTitle with newTitle outside code blocks.
 */
export function replaceWikiLinkTarget(markdown: string, oldTitle: string, newTitle: string): { content: string; count: number } {
  const normalizedOld = normalizeLinkTitle(oldTitle);
  if (!normalizedOld) return { content: markdown, count: 0 };

  const links = extractWikiLinks(markdown);
  if (!links.length) return { content: markdown, count: 0 };

  // Filter links matching oldTitle
  const matchedLinks = links.filter((link) => normalizeLinkTitle(link.target) === normalizedOld);
  if (!matchedLinks.length) return { content: markdown, count: 0 };

  // Replace from end to start to keep indices valid
  let result = markdown;
  for (let i = matchedLinks.length - 1; i >= 0; i--) {
    const link = matchedLinks[i];
    const encodedTitle = encodeWikiLinkComponent(newTitle, "target");
    const replacement = link.alias
      ? `[[${encodedTitle}|${encodeWikiLinkComponent(link.alias, "alias")}]]`
      : `[[${encodedTitle}]]`;
    result = result.slice(0, link.start) + replacement + result.slice(link.end);
  }

  return { content: result, count: matchedLinks.length };
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
export function findUnlinkedMentionsInMarkdown(markdown: string, targetTitle: string): UnlinkedMentionMatch[] {
  const trimmed = targetTitle.trim();
  if (!trimmed || trimmed.length < 2) return [];

  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // For words composed of letters/digits, use word boundary; for Chinese, direct regex match
  const isLatinWord = /^[a-zA-Z0-9_-]+$/.test(trimmed);
  const regex = new RegExp(isLatinWord ? `\\b${escaped}\\b` : escaped, "gi");

  // Fast-path: quickly collect raw matches. If there are no candidate matches at all,
  // skip all expensive AST / interval parsing completely.
  const rawMatches: Array<{ start: number; end: number; matchText: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(markdown)) !== null) {
    rawMatches.push({
      start: match.index,
      end: match.index + match[0].length,
      matchText: match[0],
    });
  }

  if (rawMatches.length === 0) return [];

  // Intervals to exclude: code fences, inline codes, wiki links, markdown links/images
  const codeBlocks = findCodeFenceIntervals(markdown);
  const excludedIntervals: MarkdownInterval[] = [
    ...codeBlocks,
    ...findInlineCodeIntervals(markdown, codeBlocks),
  ];

  // Exclude existing wiki-links
  const wikiRegex = new RegExp(WIKI_LINK_PATTERN.source, "g");
  let wMatch: RegExpExecArray | null;
  while ((wMatch = wikiRegex.exec(markdown)) !== null) {
    excludedIntervals.push({ start: wMatch.index, end: wMatch.index + wMatch[0].length });
  }

  // Exclude markdown links and images [text](url)
  const mdLinkRegex = /!?\[([^\]]*)\]\(([^)]*)\)/g;
  let mdMatch: RegExpExecArray | null;
  while ((mdMatch = mdLinkRegex.exec(markdown)) !== null) {
    excludedIntervals.push({ start: mdMatch.index, end: mdMatch.index + mdMatch[0].length });
  }

  // Sort intervals by start for fast pruning
  excludedIntervals.sort((a, b) => a.start - b.start);

  // Check if range overlaps with excluded
  const isExcluded = (start: number, end: number) => {
    for (const interval of excludedIntervals) {
      if (interval.start >= end) break;
      if (start < interval.end && end > interval.start) return true;
    }
    return false;
  };

  const results: UnlinkedMentionMatch[] = [];
  for (const raw of rawMatches) {
    if (isExcluded(raw.start, raw.end)) continue;

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
export function linkMentionInMarkdown(markdown: string, start: number, end: number, targetTitle: string): string {
  const text = markdown.slice(start, end);
  const cleanTarget = targetTitle.replace(/^(?:\[\[|【【)\s*|\s*(?:\]\]|】】)$/g, "").trim();
  const encodedTarget = encodeWikiLinkComponent(cleanTarget, "target");
  const replacement = text.trim() === cleanTarget
    ? `[[${encodedTarget}]]`
    : `[[${encodedTarget}|${encodeWikiLinkComponent(text, "alias")}]]`;
  return markdown.slice(0, start) + replacement + markdown.slice(end);
}
