const TAG_CHARACTER_PATTERN = /[\p{L}\p{N}_-]/u;
const TAG_QUERY_PATTERN = /^#([\p{L}\p{N}_-]+)$/u;

type Fence = {
  marker: "`" | "~";
  length: number;
};

export function normalizeTag(tag: string) {
  return tag.normalize("NFKC").toLocaleLowerCase("zh-CN");
}

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

function tagCharacterAt(markdown: string, index: number) {
  const codePoint = markdown.codePointAt(index);
  return codePoint === undefined ? "" : String.fromCodePoint(codePoint);
}

export type TagRange = {
  start: number;
  end: number;
  tag: string;
};

type MarkdownSegment = { start: number; end: number };
type BacktickRun = { start: number; end: number; length: number; indexForLength: number };

function collectVisibleSegments(markdown: string) {
  const segments: MarkdownSegment[] = [];
  let fence: Fence | null = null;
  let visibleStart = 0;
  let lineStart = 0;

  while (lineStart <= markdown.length) {
    const lineBreak = markdown.indexOf("\n", lineStart);
    const lineEnd = lineBreak === -1 ? markdown.length : lineBreak;
    const candidateFence = lineFence(markdown, lineStart, lineEnd);

    if (fence) {
      if (isClosingFence(fence, candidateFence)) {
        fence = null;
        visibleStart = lineBreak === -1 ? markdown.length : lineBreak + 1;
      }
    } else if (candidateFence) {
      if (lineStart > visibleStart) segments.push({ start: visibleStart, end: lineStart });
      fence = candidateFence;
    }

    if (lineBreak === -1) break;
    lineStart = lineBreak + 1;
  }

  if (!fence && visibleStart < markdown.length) segments.push({ start: visibleStart, end: markdown.length });
  return segments;
}

function collectBacktickRuns(markdown: string, segment: MarkdownSegment) {
  const runs: BacktickRun[] = [];
  const byLength = new Map<number, BacktickRun[]>();
  let cursor = segment.start;
  while (cursor < segment.end) {
    if (markdown[cursor] !== "`") {
      cursor += 1;
      continue;
    }
    const start = cursor;
    while (cursor < segment.end && markdown[cursor] === "`") cursor += 1;
    const group = byLength.get(cursor - start) ?? [];
    const run = { start, end: cursor, length: cursor - start, indexForLength: group.length };
    group.push(run);
    byLength.set(run.length, group);
    runs.push(run);
  }
  return { runs, byLength };
}

function collectTagsOutsideCode(markdown: string, start: number, end: number, ranges: TagRange[]) {
  for (let index = start; index < end; index += 1) {
    if (markdown[index] !== "#" || markdown[index - 1] === "#") continue;
    const tagStart = index + 1;
    if (!TAG_CHARACTER_PATTERN.test(tagCharacterAt(markdown, tagStart))) continue;

    let tagEnd = tagStart;
    while (tagEnd < end) {
      const character = tagCharacterAt(markdown, tagEnd);
      if (!TAG_CHARACTER_PATTERN.test(character)) break;
      tagEnd += character.length;
    }
    ranges.push({ start: index, end: tagEnd, tag: markdown.slice(tagStart, tagEnd) });
    index = tagEnd - 1;
  }
}

function collectSegmentTagRanges(markdown: string, segment: MarkdownSegment, ranges: TagRange[]) {
  const { runs, byLength } = collectBacktickRuns(markdown, segment);
  let cursor = segment.start;
  let runIndex = 0;

  while (runIndex < runs.length) {
    const run = runs[runIndex];
    if (run.start > cursor) collectTagsOutsideCode(markdown, cursor, run.start, ranges);

    const sameLengthRuns = byLength.get(run.length) ?? [];
    const closingRun = sameLengthRuns[run.indexForLength + 1];
    if (closingRun) {
      cursor = closingRun.end;
      while (runIndex < runs.length && runs[runIndex].start < cursor) runIndex += 1;
    } else {
      cursor = run.end;
      runIndex += 1;
    }
  }

  if (cursor < segment.end) collectTagsOutsideCode(markdown, cursor, segment.end, ranges);
}

/** Finds body hashtag ranges, excluding fenced and inline code. */
export function findTagRanges(markdown: string) {
  const ranges: TagRange[] = [];
  for (const segment of collectVisibleSegments(markdown)) collectSegmentTagRanges(markdown, segment, ranges);
  return ranges;
}

/** Extracts unique body hashtags in first-seen order, excluding fenced and inline code. */
export function extractTags(markdown: string) {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const range of findTagRanges(markdown)) {
    const normalized = normalizeTag(range.tag);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    tags.push(range.tag);
  }
  return tags;
}

/** Removes visible body hashtag markers that match any normalized tag name. */
export function removeTagsFromMarkdown(markdown: string, tags: string[]) {
  const targets = new Set(tags.map(normalizeTag).filter(Boolean));
  if (targets.size === 0) return markdown;

  const ranges = findTagRanges(markdown).filter((range) => targets.has(normalizeTag(range.tag)));
  if (ranges.length === 0) return markdown;
  let result = "";
  let lineStart = 0;
  let rangeIndex = 0;

  while (lineStart <= markdown.length) {
    const nextLf = markdown.indexOf("\n", lineStart);
    const nextCr = markdown.indexOf("\r", lineStart);
    const lineBreak = nextLf === -1 ? nextCr : nextCr === -1 ? nextLf : Math.min(nextLf, nextCr);
    const lineEnd = lineBreak === -1 ? markdown.length : lineBreak;
    const lineBreakEnd = lineBreak === -1
      ? markdown.length
      : lineBreak + (markdown[lineBreak] === "\r" && markdown[lineBreak + 1] === "\n" ? 2 : 1);

    while (rangeIndex < ranges.length && ranges[rangeIndex].end <= lineStart) rangeIndex += 1;
    let lineCursor = lineStart;
    let lineHasRemovedTag = false;
    let nextRangeIndex = rangeIndex;
    let remainingLine = "";
    while (nextRangeIndex < ranges.length && ranges[nextRangeIndex].start < lineEnd) {
      const range = ranges[nextRangeIndex];
      remainingLine += markdown.slice(lineCursor, range.start);
      lineCursor = range.end;
      lineHasRemovedTag = true;
      nextRangeIndex += 1;
    }

    if (lineHasRemovedTag) {
      remainingLine += markdown.slice(lineCursor, lineEnd);
      if (remainingLine.trim().length > 0) result += remainingLine + markdown.slice(lineEnd, lineBreakEnd);
    } else {
      result += markdown.slice(lineStart, lineBreakEnd);
    }

    rangeIndex = nextRangeIndex;
    if (lineBreak === -1) break;
    lineStart = lineBreakEnd;
  }
  return result;
}

export function parseTagQuery(query: string) {
  const match = query.trim().match(TAG_QUERY_PATTERN);
  return match ? normalizeTag(match[1]) : null;
}

export function hasTag(markdown: string, tag: string) {
  const normalizedTarget = normalizeTag(tag);
  if (!normalizedTarget) return false;
  return extractTags(markdown).some((candidate) => normalizeTag(candidate) === normalizedTarget);
}
