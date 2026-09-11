export type EditorStats = {
  wordCount: number;
  characterCount: number;
};

export type OutlineHeading = {
  level: 1 | 2 | 3;
  title: string;
};

export type OutlineItem = OutlineHeading & {
  id: string;
};

export type MarkdownHeadingLevel = 1 | 2 | 3;

export function isMarkdownHeadingMarker(text: string): boolean {
  return /^#{1,3}$/u.test(text);
}

export function parseMarkdownHeadingPrefix(text: string): { level: MarkdownHeadingLevel; length: number } | null {
  const match = /^(#{1,3})\s/u.exec(text);
  if (!match) return null;
  return { level: match[1].length as MarkdownHeadingLevel, length: match[0].length };
}

export type MarkdownBlockShortcut =
  | { type: "heading"; level: MarkdownHeadingLevel; length: number }
  | { type: "bulletList"; length: number }
  | { type: "orderedList"; length: number }
  | { type: "blockquote"; length: number }
  | { type: "taskList"; length: number };

export function parseMarkdownBlockShortcut(text: string): MarkdownBlockShortcut | null {
  const headingMatch = /^(#{1,3})\s/u.exec(text);
  if (headingMatch) {
    return { type: "heading", level: headingMatch[1].length as MarkdownHeadingLevel, length: headingMatch[0].length };
  }
  const taskMatch = /^\[(?: |)\]\s/u.exec(text);
  if (taskMatch) {
    return { type: "taskList", length: taskMatch[0].length };
  }
  const bulletMatch = /^[-+*]\s/u.exec(text);
  if (bulletMatch) {
    return { type: "bulletList", length: bulletMatch[0].length };
  }
  const orderedMatch = /^1\.\s/u.exec(text);
  if (orderedMatch) {
    return { type: "orderedList", length: orderedMatch[0].length };
  }
  const quoteMatch = /^>\s/u.exec(text);
  if (quoteMatch) {
    return { type: "blockquote", length: quoteMatch[0].length };
  }
  return null;
}

const MARKDOWN_PASTE_RE = /(?:^|\n)\s{0,3}(?:#{1,3}\s|[-+*]\s|\d+[.)]\s|>\s|```|~~~|-{3,}\s*$)|(?:\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|`[^`\n]+`|\[[^\]\n]+\]\([^\)\n]+\))/u;

export function shouldParseMarkdownPaste(text: string, hasHtml: boolean): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return !hasHtml || MARKDOWN_PASTE_RE.test(text);
}

type Segment = {
  segment: string;
};

type Segmenter = {
  segment(input: string): Iterable<Segment>;
};

type SegmenterConstructor = new (
  locales?: string | string[],
  options?: { granularity: "grapheme" },
) => Segmenter;

export const HAN_RE = /\p{Script=Han}/u;

export function detectLeakedImePrefix(
  blockText: string,
  candidateKey?: string | null,
  committedText?: string | null,
): number | null {
  if (!blockText) return null;

  if (candidateKey && candidateKey.length > 0) {
    const key = candidateKey.startsWith("Key")
      ? candidateKey.slice(3).toLowerCase()
      : candidateKey.startsWith("Digit")
        ? candidateKey.slice(5)
        : candidateKey.toLowerCase();
    const keyLen = key.length;
    if (blockText.length > keyLen && blockText.slice(0, keyLen).toLowerCase() === key) {
      const remainder = blockText.slice(keyLen);
      if (committedText && committedText.length > 0) {
        if (remainder.startsWith(committedText)) {
          return keyLen;
        }
      } else if (HAN_RE.test(remainder[0])) {
        return keyLen;
      }
    }
  }

  if (committedText && committedText.length > 0 && HAN_RE.test(committedText)) {
    if (blockText.length > committedText.length && blockText.endsWith(committedText)) {
      const prefixLen = blockText.length - committedText.length;
      const prefix = blockText.slice(0, prefixLen);
      if (/^[a-zA-Z]$/.test(prefix)) {
        return prefixLen;
      }
    }
  }

  return null;
}
const LETTER_OR_NUMBER_RE = /[\p{Letter}\p{Number}]/u;
const EMOJI_RE = /\p{Extended_Pictographic}/u;

const IntlSegmenter = (Intl as unknown as { Segmenter?: SegmenterConstructor }).Segmenter;
const graphemeSegmenter = IntlSegmenter ? new IntlSegmenter(undefined, { granularity: "grapheme" }) : null;

export function countEditorText(text: string): EditorStats {
  let wordCount = 0;
  let characterCount = 0;
  let hasWordRun = false;

  const flushWordRun = () => {
    if (hasWordRun) wordCount += 1;
    hasWordRun = false;
  };

  const visit = (grapheme: string) => {
    if (/\s/u.test(grapheme)) {
      flushWordRun();
      return;
    }

    characterCount += 1;
    if (HAN_RE.test(grapheme) || EMOJI_RE.test(grapheme)) {
      flushWordRun();
      wordCount += 1;
      return;
    }

    if (LETTER_OR_NUMBER_RE.test(grapheme)) {
      hasWordRun = true;
      return;
    }

    flushWordRun();
  };

  if (graphemeSegmenter) {
    for (const { segment } of graphemeSegmenter.segment(text)) visit(segment);
  } else {
    for (const grapheme of text) visit(grapheme);
  }
  flushWordRun();

  return { wordCount, characterCount };
}

function slugifyHeading(title: string): string {
  const slug = title
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}\p{Script=Han}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "section";
}

export function buildOutlineItems(headings: OutlineHeading[]): OutlineItem[] {
  return headings.map((heading, index) => ({
    ...heading,
    id: `xiangying-heading-${index + 1}-${slugifyHeading(heading.title)}`,
  }));
}
