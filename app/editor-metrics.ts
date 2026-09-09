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

const HAN_RE = /\p{Script=Han}/u;
const LETTER_OR_NUMBER_RE = /[\p{Letter}\p{Number}]/u;
const EMOJI_RE = /\p{Extended_Pictographic}/u;

const IntlSegmenter = (Intl as unknown as { Segmenter?: SegmenterConstructor }).Segmenter;
const graphemeSegmenter = IntlSegmenter ? new IntlSegmenter(undefined, { granularity: "grapheme" }) : null;

function graphemes(text: string): string[] {
  return graphemeSegmenter ? Array.from(graphemeSegmenter.segment(text), ({ segment }) => segment) : Array.from(text);
}

function countWords(text: string): number {
  let count = 0;
  let hasWordRun = false;

  const flushWordRun = () => {
    if (hasWordRun) count += 1;
    hasWordRun = false;
  };

  for (const grapheme of graphemes(text)) {
    if (/\s/u.test(grapheme)) {
      flushWordRun();
      continue;
    }

    if (HAN_RE.test(grapheme) || EMOJI_RE.test(grapheme)) {
      flushWordRun();
      count += 1;
      continue;
    }

    if (LETTER_OR_NUMBER_RE.test(grapheme)) {
      hasWordRun = true;
      continue;
    }

    flushWordRun();
  }

  flushWordRun();
  return count;
}

export function countEditorText(text: string): EditorStats {
  const textGraphemes = graphemes(text);
  return {
    wordCount: countWords(text),
    characterCount: textGraphemes.filter((grapheme) => !/\s/u.test(grapheme)).length,
  };
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
    id: `lumen-heading-${index + 1}-${slugifyHeading(heading.title)}`,
  }));
}
