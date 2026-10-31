import { Marked } from "marked";
import { decodeWikiLinkComponent, WIKI_LINK_PATTERN } from "./wiki-links";

export function findWikiLinkStart(source: string) {
  const ascii = source.indexOf("[[");
  const fullWidth = source.indexOf("【【");
  return ascii === -1 ? fullWidth : fullWidth === -1 ? ascii : Math.min(ascii, fullWidth);
}

export function tokenizeWikiLink(source: string) {
  const match = new RegExp(`^(?:${WIKI_LINK_PATTERN.source})`).exec(source);
  if (!match) return undefined;
  return {
    type: "wikiLink",
    raw: match[0],
    target: decodeWikiLinkComponent(match[1].trim()),
    alias: match[2] ? decodeWikiLinkComponent(match[2].trim()) : undefined,
  };
}

export function findCalloutStart(source: string) {
  return source.search(/^ {0,3}>[ \t]*\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/im);
}

export function tokenizeCallout<T>(source: string, blockTokens: (body: string) => T[]) {
  const opening = /^ {0,3}>[ \t]*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\r?\n|$)/i.exec(
    source,
  );
  if (!opening) return undefined;
  const lines: string[] = [];
  let consumed = opening[0].length;
  while (consumed < source.length) {
    const newlineIndex = source.indexOf("\n", consumed);
    const lineEnd = newlineIndex === -1 ? source.length : newlineIndex;
    const line = source.slice(consumed, lineEnd).replace(/\r$/u, "");
    const quotedLine = /^ {0,3}>[ \t]?(.*)$/u.exec(line);
    if (!quotedLine) break;
    lines.push(quotedLine[1]);
    consumed = newlineIndex === -1 ? source.length : newlineIndex + 1;
  }
  const body = lines.join("\n");
  return {
    type: "callout",
    raw: source.slice(0, consumed),
    calloutType: opening[1].toUpperCase(),
    tokens: body ? blockTokens(body) : [],
  };
}
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
const STAR_STRONG_RE =
  /^\*\*(?!\*|\s)((?:\\.|(?!\*\*)(?:[^\n\r]|\r?\n(?!\r?\n)))+?)(?<!\*|\s)\*\*(?!\*)/u;
const UND_STRONG_RE = /^__(?!_|\s)((?:\\.|(?!__)(?:[^\n\r]|\r?\n(?!\r?\n)))+?)(?<!_|\s)__(?!_)/u;
const UND_EM_CJK_RE =
  /^_(?!_|\s)((?:\\.|(?!_)(?:[^\n\r]|\r?\n(?!\r?\n)))+?)(?<!_|\s)_(?=[\p{Script=Han}\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65])/u;

export function createXiangyingMarked() {
  return new Marked({
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
      {
        name: "em",
        level: "inline",
        start(src: string) {
          return src.indexOf("_");
        },
        tokenizer(src: string, tokens: any) {
          if (!src.startsWith("_")) return;
          const prev = tokens?.[tokens.length - 1];
          if (prev && prev.type === "text") {
            const precedingText = prev.raw || prev.text;
            const endsWithWordCharacter = /[^\s\p{P}\p{S}]$/u.test(precedingText);
            const endsWithHanCharacter = /\p{Script=Han}$/u.test(precedingText);
            if (endsWithWordCharacter && !endsWithHanCharacter) return;
          }
          const match = UND_EM_CJK_RE.exec(src);
          if (match) {
            return {
              type: "em",
              raw: match[0],
              text: match[1],
              tokens: this.lexer.inlineTokens(match[1]),
            };
          }
        },
      },
    ],
  });
}

export type MarkdownDestinationReference = {
  type: "image" | "link";
  destination: string;
};

const destinationLexer = createXiangyingMarked();

export function extractMarkdownDestinationReferences(markdown: string) {
  if (!markdown.includes("[")) return [];

  const references: MarkdownDestinationReference[] = [];
  const visited = new WeakSet<object>();
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }

    const token = value as { type?: unknown; href?: unknown };
    if ((token.type === "image" || token.type === "link") && typeof token.href === "string") {
      references.push({ type: token.type, destination: token.href });
    }
    if (token.type === "image") return;
    for (const child of Object.values(value)) visit(child);
  };

  visit(destinationLexer.lexer(markdown));
  return references;
}
