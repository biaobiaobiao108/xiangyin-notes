import { Node, type MarkdownToken } from "@tiptap/core";

export const CALLOUT_TYPES = ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"] as const;
export type CalloutType = (typeof CALLOUT_TYPES)[number];

const calloutTypeSet = new Set<string>(CALLOUT_TYPES);

export function normalizeCalloutType(value: unknown): CalloutType | null {
  if (typeof value !== "string") return null;
  const normalized = value.toUpperCase();
  return calloutTypeSet.has(normalized) ? normalized as CalloutType : null;
}

type CalloutToken = MarkdownToken & { calloutType?: string };

export const CalloutNode = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,
  isolating: true,
  markdownTokenName: "callout",

  addAttributes() {
    return {
      type: {
        default: "NOTE" satisfies CalloutType,
        parseHTML: (element: HTMLElement) => normalizeCalloutType(element.getAttribute("data-callout")) ?? "NOTE",
        renderHTML: (attributes: { type?: unknown }) => ({ "data-callout": normalizeCalloutType(attributes.type) ?? "NOTE" }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "aside[data-callout]" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const type = normalizeCalloutType(node.attrs.type) ?? "NOTE";
    const labels: Record<CalloutType, string> = {
      NOTE: "说明",
      TIP: "建议",
      IMPORTANT: "重要",
      WARNING: "警告",
      CAUTION: "注意",
    };

    return [
      "aside",
      { ...HTMLAttributes, class: "note-callout", "data-callout": type, role: "note", "aria-label": labels[type] },
      ["div", { class: "note-callout-label", "aria-hidden": "true" }, labels[type]],
      ["div", { class: "note-callout-content" }, 0],
    ];
  },

  markdownTokenizer: {
    name: "callout",
    level: "block",
    start(source: string) {
      return source.search(/^ {0,3}>[ \t]*\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/im);
    },
    tokenize(source, _tokens, lexer) {
      const opening = /^ {0,3}>[ \t]*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\r?\n|$)/i.exec(source);
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
        tokens: body ? lexer.blockTokens(body) : [],
      };
    },
  },

  parseMarkdown(token, helpers) {
    const callout = token as CalloutToken;
    const type = normalizeCalloutType(callout.calloutType) ?? "NOTE";
    const parseBlockChildren = helpers.parseBlockChildren ?? helpers.parseChildren;
    const content = parseBlockChildren(callout.tokens ?? []);
    return helpers.createNode("callout", { type }, content.length ? content : [{ type: "paragraph" }]);
  },

  renderMarkdown(node, helpers) {
    const type = normalizeCalloutType(node.attrs?.type) ?? "NOTE";
    const content = helpers.renderChildren(node.content ?? []).replace(/\n+$/u, "");
    const quotedLines = content
      ? content.split("\n").map((line) => line ? `> ${line}` : ">")
      : [">"];
    return [`> [!${type}]`, ...quotedLines].join("\n");
  },
});
