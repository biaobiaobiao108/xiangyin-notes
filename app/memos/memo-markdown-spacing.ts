import { extractAbsorbedBlankLines } from "@tiptap/markdown";
import type { Token, Tokens } from "marked";

export function normalizeMemoComposerContent(markdown: string) {
  return markdown.replace(/(?:\r?\n)+$/u, "");
}

export function preserveMemoBlankParagraphs(tokens: Token[]): Token[] {
  const blocks = extractAbsorbedBlankLines(tokens) as Token[];
  const first = blocks.findIndex((token) => token.type !== "space");
  let last = blocks.length - 1;
  while (blocks[last]?.type === "space") last--;
  return blocks.flatMap((token, index) => {
    if (token.type !== "space") return [token];

    // Tiptap uses the first pair between blocks as the Markdown separator.
    const pairs = token.raw.replaceAll("\r\n", "\n").match(/\n\n/gu)?.length ?? 0;
    if (!pairs) return [];
    const emptyParagraphs = index > first && index < last ? pairs - 1 : pairs;
    const paragraph: Tokens.Paragraph = {
      type: "paragraph",
      raw: "",
      text: "",
      tokens: [{ type: "br", raw: "" }],
    };
    return Array.from({ length: emptyParagraphs }, () => paragraph);
  });
}
