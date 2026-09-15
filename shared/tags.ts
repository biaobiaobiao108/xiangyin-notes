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

/** Extracts unique body hashtags in first-seen order, excluding fenced code blocks. */
export function extractTags(markdown: string) {
  const tags: string[] = [];
  const seen = new Set<string>();
  let fence: Fence | null = null;
  let lineStart = 0;

  while (lineStart <= markdown.length) {
    const lineBreak = markdown.indexOf("\n", lineStart);
    const lineEnd = lineBreak === -1 ? markdown.length : lineBreak;
    const candidateFence = lineFence(markdown, lineStart, lineEnd);

    if (fence) {
      if (isClosingFence(fence, candidateFence)) fence = null;
    } else if (candidateFence) {
      fence = candidateFence;
    } else {
      for (let index = lineStart; index < lineEnd; index += 1) {
        if (markdown[index] !== "#" || markdown[index - 1] === "#") continue;
        const tagStart = index + 1;
        if (!TAG_CHARACTER_PATTERN.test(tagCharacterAt(markdown, tagStart))) continue;

        let tagEnd = tagStart;
        while (tagEnd < lineEnd) {
          const character = tagCharacterAt(markdown, tagEnd);
          if (!TAG_CHARACTER_PATTERN.test(character)) break;
          tagEnd += character.length;
        }
        const tag = markdown.slice(tagStart, tagEnd);
        const normalized = normalizeTag(tag);
        if (!seen.has(normalized)) {
          seen.add(normalized);
          tags.push(tag);
        }
        index = tagEnd - 1;
      }
    }

    if (lineBreak === -1) break;
    lineStart = lineBreak + 1;
  }

  return tags;
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
