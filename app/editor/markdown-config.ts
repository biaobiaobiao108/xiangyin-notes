import { Markdown } from "@tiptap/markdown";
import { type marked, Marked } from "marked";

/**
 * CommonMark delimiter flanking rules dictate that a delimiter run preceded by punctuation
 * and followed by a non-whitespace character (such as a CJK character) is classified as
 * left-flanking (opener) but NOT right-flanking (closer).
 *
 * In CJK typography and AI-generated text (e.g. `**判断：**已知人物`), full-width punctuation
 * like `：` is placed directly against the following text without an ASCII space.
 * Standard CommonMark therefore treats the second `**` as an opener, leaving the bold unclosed.
 *
 * This extension provides an inline tokenizer for `strong` that recognizes bold spans
 * even when the closing delimiter is preceded by punctuation and immediately followed
 * by CJK or other non-whitespace characters.
 */
const STAR_STRONG_RE = /^\*\*(?!\*|\s)((?:\\.|(?!\*\*)(?:[^\n\r]|\r?\n(?!\r?\n)))+?)(?<!\*|\s)\*\*(?!\*)/u;
const UND_STRONG_RE = /^__(?!_|\s)((?:\\.|(?!__)(?:[^\n\r]|\r?\n(?!\r?\n)))+?)(?<!_|\s)__(?!_)/u;

export const xiangyingMarked = new Marked({
  extensions: [
    {
      name: "strong",
      level: "inline",
      start(src: string) {
        const star = src.indexOf("**");
        const under = src.indexOf("__");
        if (star === -1) return under;
        if (under === -1) return star;
        return Math.min(star, under);
      },
      tokenizer(src: string, tokens: any) {
        if (src.startsWith("__")) {
          const prev = tokens?.[tokens.length - 1];
          if (prev && prev.type === "text" && /[^\s\p{P}\p{S}]$/u.test(prev.raw || prev.text)) {
            return;
          }
        }
        const match = STAR_STRONG_RE.exec(src) || UND_STRONG_RE.exec(src);
        if (match) {
          return {
            type: "strong",
            raw: match[0],
            text: match[1],
            tokens: this.lexer.inlineTokens(match[1]),
          };
        }
      },
    },
  ],
});

export function createMarkdownExtension() {
  return Markdown.configure({ marked: xiangyingMarked as unknown as typeof marked });
}
