export type TextStats = { wordCount: number; characterCount: number };

type Segmenter = { segment(input: string): Iterable<{ segment: string }> };
type SegmenterConstructor = new (
  locales?: string | string[],
  options?: { granularity: "grapheme" },
) => Segmenter;

export const HAN_RE = /\p{Script=Han}/u;
const LETTER_OR_NUMBER_RE = /[\p{Letter}\p{Number}]/u;
const EMOJI_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u;
const IntlSegmenter = (Intl as unknown as { Segmenter?: SegmenterConstructor }).Segmenter;
const graphemeSegmenter = IntlSegmenter
  ? new IntlSegmenter(undefined, { granularity: "grapheme" })
  : null;

/** Non-whitespace graphemes; Han and emoji count individually, other letters/numbers form runs. */
export function countTextStats(text: string): TextStats {
  let wordCount = 0;
  let characterCount = 0;
  let hasWordRun = false;
  const flushWordRun = () => {
    if (hasWordRun) wordCount += 1;
    hasWordRun = false;
  };
  const visit = (grapheme: string) => {
    // Markdown hashtag escaping uses WORD JOINER as an internal marker.
    if (grapheme === "\u2060") return;
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
