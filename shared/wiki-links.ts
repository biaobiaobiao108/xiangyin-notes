type Fence = {
  marker: "`" | "~";
  length: number;
};

function lineFence(markdown: string, lineStart: number, lineEnd: number): Fence | null {
  let cursor = lineStart;
  let indentation = 0;
  while (cursor < lineEnd && indentation < 4 && (markdown[cursor] === " " || markdown[cursor] === "\t")) {
    cursor += 1;
    indentation += 1;
  }
  if (indentation > 3) return null;

  const marker = markdown[cursor];
  if (marker !== "`" && marker !== "~") return null;
  let length = 0;
  while (cursor + length < lineEnd && markdown[cursor + length] === marker) length += 1;
  return length >= 3 ? { marker, length } : null;
}

function isClosingFence(fence: Fence, candidate: Fence | null) {
  return Boolean(candidate && candidate.marker === fence.marker && candidate.length >= fence.length);
}

/** Finds all line-level code fence intervals [start, end) */
export function findCodeFenceIntervals(markdown: string): { start: number; end: number }[] {
  const intervals: { start: number; end: number }[] = [];
  let fence: Fence | null = null;
  let fenceStart = 0;
  let lineStart = 0;

  while (lineStart <= markdown.length) {
    const lineBreak = markdown.indexOf("\n", lineStart);
    const lineEnd = lineBreak === -1 ? markdown.length : lineBreak;
    const candidateFence = lineFence(markdown, lineStart, lineEnd);

    if (fence) {
      if (isClosingFence(fence, candidateFence)) {
        intervals.push({ start: fenceStart, end: lineEnd });
        fence = null;
      }
    } else if (candidateFence) {
      fence = candidateFence;
      fenceStart = lineStart;
    }

    if (lineBreak === -1) break;
    lineStart = lineBreak + 1;
  }

  if (fence) {
    intervals.push({ start: fenceStart, end: markdown.length });
  }

  return intervals;
}

/** Finds inline code intervals `...` on a single line */
export function findInlineCodeIntervals(markdown: string): { start: number; end: number }[] {
  const intervals: { start: number; end: number }[] = [];
  const regex = /(`+)([\s\S]*?)\1/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(markdown)) !== null) {
    intervals.push({ start: match.index, end: match.index + match[0].length });
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

export const WIKI_LINK_PATTERN = /(?:\[\[|【【)([^\]】\r\n|｜]+)(?:[|｜]([^\]】\r\n]+))?(?:\]\]|】】)/g;

export function normalizeLinkTitle(title: string) {
  return title.trim().normalize("NFKC").toLocaleLowerCase("zh-CN");
}

/**
 * Extracts all Wiki-link matches in Markdown outside code fences and inline code.
 */
export function extractWikiLinks(markdown: string): WikiLinkMatch[] {
  if (!markdown || (!markdown.includes("[[") && !markdown.includes("【【"))) return [];

  const codeFences = findCodeFenceIntervals(markdown);
  const inlineCodes = findInlineCodeIntervals(markdown);
  const isInsideCode = (start: number, end: number) => {
    return codeFences.some((f) => start >= f.start && end <= f.end) ||
      inlineCodes.some((c) => start >= c.start && end <= c.end);
  };

  const matches: WikiLinkMatch[] = [];
  const regex = new RegExp(WIKI_LINK_PATTERN.source, "g");
  let match: RegExpExecArray | null;

  while ((match = regex.exec(markdown)) !== null) {
    const raw = match[0];
    const target = match[1]?.trim() ?? "";
    const alias = match[2]?.trim();
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
    const replacement = link.alias ? `[[${newTitle}|${link.alias}]]` : `[[${newTitle}]]`;
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

  // Intervals to exclude: code fences, inline codes, wiki links, markdown links/images
  const excludedIntervals: { start: number; end: number }[] = [
    ...findCodeFenceIntervals(markdown),
    ...findInlineCodeIntervals(markdown),
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

  // Check if range overlaps with excluded
  const isExcluded = (start: number, end: number) => {
    return excludedIntervals.some((interval) => (start < interval.end && end > interval.start));
  };

  const results: UnlinkedMentionMatch[] = [];
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // For words composed of letters/digits, use word boundary; for Chinese, direct regex match
  const isLatinWord = /^[a-zA-Z0-9_-]+$/.test(trimmed);
  const regex = new RegExp(isLatinWord ? `\\b${escaped}\\b` : escaped, "gi");

  let match: RegExpExecArray | null;
  while ((match = regex.exec(markdown)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (isExcluded(start, end)) continue;

    results.push({
      start,
      end,
      matchText: match[0],
      snippet: extractContextSnippet(markdown, start, end),
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
  const replacement = text.trim() === cleanTarget
    ? `[[${cleanTarget}]]`
    : `[[${cleanTarget}|${text}]]`;
  return markdown.slice(0, start) + replacement + markdown.slice(end);
}
