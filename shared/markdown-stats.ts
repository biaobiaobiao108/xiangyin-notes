import type { Token } from "marked";
import {
  createXiangyingMarked,
  findCalloutStart,
  findWikiLinkStart,
  tokenizeCallout,
  tokenizeWikiLink,
} from "./markdown-lexer";
import { countTextStats } from "./text-stats";
import { preserveEscapedHashtagsForEditor } from "./tags";

export type MarkdownStats = {
  markdownCharacterCount: number;
  textCharacterCount: number;
  wordCount: number;
};

// Separate instance: Tiptap registers its own node tokenizers on the editor's lexer.
const statsMarked = createXiangyingMarked();
statsMarked.use({
  extensions: [
    { name: "wikiLink", level: "inline", start: findWikiLinkStart, tokenizer: tokenizeWikiLink },
    {
      name: "callout",
      level: "block",
      start: findCalloutStart,
      tokenizer(source) {
        return tokenizeCallout(source, (body) => this.lexer.blockTokens(body));
      },
    },
  ],
});

/** Match Tiptap's Markdown text decoding; code and wiki-link attributes stay literal. */
function decodeMarkdownText(text: string) {
  return text.replace(
    /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(lt|gt|quot|amp));/g,
    (entity, decimal, hex, name) => {
      if (decimal !== undefined || hex !== undefined) {
        const codePoint = decimal !== undefined ? Number(decimal) : Number.parseInt(hex, 16);
        if (
          codePoint === 0 ||
          codePoint > 0x10ffff ||
          (codePoint >= 0xd800 && codePoint <= 0xdfff)
        ) {
          return "\ufffd";
        }
        return String.fromCodePoint(codePoint);
      }
      if (name === "lt") return "<";
      if (name === "gt") return ">";
      if (name === "quot") return '"';
      return "&";
    },
  );
}

const HTML_TAGS = new Set(
  "a abbr address area article aside audio b base bdi bdo blockquote body br button canvas caption cite code col colgroup data datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe img input ins kbd label legend li link main map mark menu meta meter nav noscript object ol optgroup option output p param picture pre progress q rp rt ruby s samp script search section select slot small source span strong style sub summary sup svg circle clippath defs ellipse foreignobject g image line lineargradient mask path polygon polyline radialgradient rect stop switch symbol textpath tspan use table tbody td template textarea tfoot th thead time title tr track u ul var video wbr".split(
    " ",
  ),
);
const HTML_BLOCKS = new Set(
  "address article aside blockquote dd details div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr li main menu nav ol p pre section table tbody td tfoot th thead tr ul".split(
    " ",
  ),
);
const HTML_IGNORED = new Set(["script", "style", "head", "noscript", "object", "title"]);

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  ndash: "–",
  mdash: "—",
  bull: "•",
  laquo: "«",
  raquo: "»",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  times: "×",
  divide: "÷",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  ensp: "\u2002",
  emsp: "\u2003",
  thinsp: "\u2009",
  Tab: "\t",
  NewLine: "\n",
};

/** Numeric and common named HTML entities decode once; unknown names remain literal. */
function decodeHtmlText(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (entity: string, name: string) => {
    if (!name.startsWith("#")) return HTML_ENTITIES[name] ?? entity;
    const codePoint = /^#x/i.test(name)
      ? Number.parseInt(name.slice(2), 16)
      : Number(name.slice(1));
    return codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ? "\ufffd"
      : String.fromCodePoint(codePoint);
  });
}

/** Only HTML tokens reach this Bun parser. Markdown/code never undergo tag stripping. */
function htmlText(html: string) {
  const parts: string[] = [];
  let ignored = 0;
  let unknown = false;
  new HTMLRewriter()
    .on("*", {
      element(element) {
        const tag = element.tagName;
        if (!HTML_TAGS.has(tag) && !tag.includes("-")) unknown = true;
        if (HTML_IGNORED.has(tag)) {
          ignored += 1;
          element.onEndTag(() => {
            ignored -= 1;
          });
          return;
        }
        if (ignored) return;
        if (HTML_BLOCKS.has(tag) || tag === "br" || tag === "img") parts.push("\n");
        if (HTML_BLOCKS.has(tag))
          element.onEndTag(() => {
            parts.push("\n");
          });
      },
    })
    .onDocument({
      text(chunk) {
        if (!ignored) parts.push(chunk.text);
      },
    })
    .transform(html);
  // Tiptap preserves unknown angle-bracket commands verbatim instead of dropping them.
  return unknown ? html.trimEnd() : decodeHtmlText(parts.join(""));
}

function inlineText(tokens: readonly Token[]): string {
  const parts: string[] = [];
  // Precompute the next matching closing tag. Unclosed tags must not rescan
  // the entire suffix for every token (e.g. pasted runs of <br> or <span>).
  const nextClosing = new Map<string, number>();
  const closingForOpening = new Map<number, number>();
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    if (token.type !== "html") continue;
    const raw = token.raw ?? token.text ?? "";
    const closing = /^<\/\s*([\w-]+)\b/i.exec(raw);
    if (closing) {
      nextClosing.set(closing[1].toLowerCase(), index);
      continue;
    }
    const opening = /^<\s*([\w-]+)(?:\s|>|\/|$)/i.exec(raw);
    if (!opening || /\/>$/.test(raw)) continue;
    const end = nextClosing.get(opening[1].toLowerCase());
    if (end !== undefined) closingForOpening.set(index, end);
  }
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    switch (token.type) {
      case "image":
        parts.push("\n");
        break;
      case "wikiLink":
        parts.push(token.alias || token.target || "");
        break;
      case "br":
        parts.push("\n");
        break;
      case "escape":
      case "codespan":
        parts.push(token.text || "");
        break;
      case "html": {
        const raw = token.raw ?? token.text ?? "";
        let html = raw;
        const end = closingForOpening.get(index);
        if (end !== undefined) {
          html = tokens
            .slice(index, end + 1)
            .map((item) => item.raw)
            .join("");
          index = end;
        }
        parts.push(htmlText(html));
        break;
      }
      default:
        if ("tokens" in token && token.tokens) parts.push(inlineText(token.tokens));
        else if (token.type === "text") parts.push(decodeMarkdownText(token.text || ""));
        break;
    }
  }
  return parts.join("");
}

/**
 * Raw size counts Unicode code points including syntax and whitespace. Body size
 * counts non-whitespace graphemes, with the same word rules as the editor.
 * Each paragraph/code block/table cell is counted independently. Image alt text,
 * link destinations, list markers and callout markers do not contribute.
 * HTML tokens use Bun's HTML parser; no editor, DOM or browser is instantiated.
 */
export function countMarkdownStats(markdown: string): MarkdownStats {
  let markdownCharacterCount = 0;
  for (const _character of markdown) markdownCharacterCount += 1;
  let textCharacterCount = 0;
  let wordCount = 0;
  const addText = (text: string) => {
    const stats = countTextStats(text);
    textCharacterCount += stats.characterCount;
    wordCount += stats.wordCount;
  };
  const visit = (tokens: readonly Token[]) => {
    for (const token of tokens) {
      switch (token.type) {
        case "paragraph":
        case "heading":
        case "text":
          addText(token.tokens ? inlineText(token.tokens) : decodeMarkdownText(token.text || ""));
          break;
        case "code":
          addText(token.text || "");
          break;
        case "html":
          addText(htmlText(token.text || token.raw || ""));
          break;
        case "list":
          for (const item of token.items) visit(item.tokens);
          break;
        case "table":
          for (const cell of token.header) addText(inlineText(cell.tokens));
          for (const row of token.rows) for (const cell of row) addText(inlineText(cell.tokens));
          break;
        case "blockquote":
        case "callout":
          visit(token.tokens ?? []);
          break;
        default:
          if ("tokens" in token && token.tokens && token.type !== "image") visit(token.tokens);
          break;
      }
    }
  };
  visit(statsMarked.lexer(preserveEscapedHashtagsForEditor(markdown)));
  return { markdownCharacterCount, textCharacterCount, wordCount };
}
