import { Node, type MarkdownToken } from "@tiptap/core";
import type { DOMOutputSpec } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";

export const CALLOUT_TYPES = ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"] as const;
export type CalloutType = (typeof CALLOUT_TYPES)[number];

const calloutTypeSet = new Set<string>(CALLOUT_TYPES);
const SVG_NS_TAG = "http://www.w3.org/2000/svg svg";

const calloutIcons: Record<CalloutType, DOMOutputSpec> = {
  NOTE: [SVG_NS_TAG, { viewBox: "0 0 24 24", focusable: "false", "aria-hidden": "true" },
    ["circle", { cx: "12", cy: "12", r: "9" }], ["path", { d: "M12 11v5" }], ["path", { d: "M12 8h.01" }]],
  TIP: [SVG_NS_TAG, { viewBox: "0 0 24 24", focusable: "false", "aria-hidden": "true" },
    ["path", { d: "M9 18h6M10 22h4" }], ["path", { d: "M15.1 14a6 6 0 1 0-6.2 0c.5.3.9.8 1 1.3L10 17h4l.1-1.7c.1-.5.5-1 1-1.3Z" }],
    ["path", { d: "M12 2v1M4.9 4.9l.7.7M2 12h1M20 12h2M18.4 5.6l.7-.7" }]],
  IMPORTANT: [SVG_NS_TAG, { viewBox: "0 0 24 24", focusable: "false", "aria-hidden": "true" },
    ["path", { d: "M6 4.5A1.5 1.5 0 0 1 7.5 3H18v18l-6-4-6 4V4.5Z" }]],
  WARNING: [SVG_NS_TAG, { viewBox: "0 0 24 24", focusable: "false", "aria-hidden": "true" },
    ["path", { d: "m10.3 3.9-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3.1l-8-14a2 2 0 0 0-3.4 0Z" }], ["path", { d: "M12 9v4M12 17h.01" }]],
  CAUTION: [SVG_NS_TAG, { viewBox: "0 0 24 24", focusable: "false", "aria-hidden": "true" },
    ["path", { d: "M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z" }], ["path", { d: "M12 8v4M12 16h.01" }]],
};

export function normalizeCalloutType(value: unknown): CalloutType | null {
  if (typeof value !== "string") return null;
  const normalized = value.toUpperCase();
  return calloutTypeSet.has(normalized) ? normalized as CalloutType : null;
}

export function shouldExitCalloutOnEnter(state: EditorState): boolean {
  const { selection } = state;
  const { $from } = selection;
  if (!selection.empty || $from.parent.type.name !== "paragraph" || $from.parent.content.size > 0) return false;

  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name !== "callout") continue;
    return $from.index(depth) === $from.node(depth).childCount - 1;
  }
  return false;
}

type CalloutToken = MarkdownToken & { calloutType?: string };

export const CalloutNode = Node.create({
  name: "callout",
  priority: 110,
  group: "block",
  content: "block+",
  defining: true,
  markdownTokenName: "callout",

  addKeyboardShortcuts() {
    return {
      Enter: () => {
        if (!shouldExitCalloutOnEnter(this.editor.state)) return false;
        return this.editor.commands.liftEmptyBlock();
      },
    };
  },

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
    const accessibleNames: Record<CalloutType, string> = {
      NOTE: "说明提示块",
      TIP: "建议提示块",
      IMPORTANT: "重要提示块",
      WARNING: "警告提示块",
      CAUTION: "注意提示块",
    };

    return [
      "aside",
      { ...HTMLAttributes, class: "note-callout", "data-callout": type, role: "note", "aria-label": accessibleNames[type] },
      ["span", { class: "note-callout-icon", "aria-hidden": "true" }, calloutIcons[type]],
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
    const content = helpers.renderChildren(node.content ?? [], "\n\n").replace(/\n+$/u, "");
    const quotedLines = content
      ? content.split("\n").map((line) => line ? `> ${line}` : ">")
      : [">"];
    return [`> [!${type}]`, ...quotedLines].join("\n");
  },
});
