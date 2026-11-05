import { Mark, mergeAttributes, type MarkdownToken } from "@tiptap/core";
import type { DOMOutputSpec, Node as ProseMirrorNode } from "@tiptap/pm/model";
import { createUuid } from "../uuid";

export const HIGHLIGHT_COLORS = ["amber", "sage", "sky", "rose", "lilac", "sand"] as const;
export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number];

export const HIGHLIGHT_COLOR_LABELS: Record<HighlightColor, string> = {
  amber: "琥珀",
  sage: "草木",
  sky: "雾蓝",
  rose: "胭脂",
  lilac: "紫藤",
  sand: "麦沙",
};

export const HIGHLIGHT_COLOR_VALUES: Record<HighlightColor, string> = {
  amber: "#f3e3b5",
  sage: "#dfe9dc",
  sky: "#dce8ef",
  rose: "#f2deda",
  lilac: "#e6e0ed",
  sand: "#eadfcf",
};

const colorSet = new Set<string>(HIGHLIGHT_COLORS);

export function normalizeHighlightColor(value: unknown): HighlightColor {
  return typeof value === "string" && colorSet.has(value) ? (value as HighlightColor) : "amber";
}

export function escapeHtmlAttribute(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\n", "&#10;")
    .replaceAll("\t", "&#9;");
}

export function decodeHtmlAttribute(value: string) {
  return value
    .replace(/&#10;/g, "\n")
    .replace(/&#9;/g, "\t")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function openingTagAttribute(source: string, name: string) {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(source)?.[1];
}

function tokenizeInlineHtmlTag(
  source: string,
  tag: string,
  tokenType: string,
  lexer: { inlineTokens: (source: string) => MarkdownToken[] },
  requiredAttribute?: string,
): MarkdownToken | undefined {
  const openingEnd = source.indexOf(">");
  if (openingEnd === -1) return undefined;
  const opening = source.slice(1, openingEnd);
  if (!new RegExp(`^${tag}(?:\\s|$)`).test(opening)) return undefined;
  if (requiredAttribute && !new RegExp(`\\b${requiredAttribute}="`).test(opening)) return undefined;
  const closing = `</${tag}>`;
  const closingStart = source.indexOf(closing, openingEnd + 1);
  if (closingStart === -1) return undefined;
  const raw = source.slice(0, closingStart + closing.length);
  const inner = source.slice(openingEnd + 1, closingStart);
  return {
    type: tokenType,
    raw,
    attributes: opening,
    tokens: lexer.inlineTokens(inner),
  };
}

type HighlightToken = MarkdownToken & { attributes?: string };
type AnnotationToken = MarkdownToken & { attributes?: string };

export const NoteHighlight = Mark.create({
  name: "noteHighlight",
  priority: 920,

  addAttributes() {
    return {
      color: {
        default: "amber" satisfies HighlightColor,
        parseHTML: (element: HTMLElement) =>
          normalizeHighlightColor(element.getAttribute("data-color")),
        renderHTML: (attributes: { color?: unknown }) => ({
          "data-color": normalizeHighlightColor(attributes.color),
        }),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: "mark[data-color]",
        getAttrs: (element: HTMLElement) => ({
          color: normalizeHighlightColor(element.getAttribute("data-color")),
        }),
      },
      {
        tag: "mark",
        getAttrs: (element: HTMLElement) =>
          element.hasAttribute("data-color")
            ? false
            : { color: normalizeHighlightColor(element.getAttribute("data-color")) },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "mark",
      mergeAttributes(HTMLAttributes, { class: "note-highlight" }),
      0,
    ] as DOMOutputSpec;
  },

  markdownTokenizer: {
    name: "noteHighlight",
    level: "inline",
    start: "<mark",
    tokenize(source, _tokens, lexer) {
      return tokenizeInlineHtmlTag(source, "mark", "noteHighlight", lexer);
    },
  },

  parseMarkdown(token: HighlightToken, helpers) {
    const color = normalizeHighlightColor(
      openingTagAttribute(token.attributes ?? "", "data-color"),
    );
    return helpers.applyMark("noteHighlight", helpers.parseInline(token.tokens ?? []), { color });
  },

  renderMarkdown(node) {
    const color = normalizeHighlightColor(node.attrs?.color);
    return `<mark data-color="${color}">\uE000__TIPTAP_MARKDOWN_PLACEHOLDER__\uE001</mark>`;
  },
});

export const NoteAnnotation = Mark.create({
  name: "noteAnnotation",
  priority: 910,

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-annotation-id"),
        renderHTML: (attributes: { id?: unknown }) =>
          typeof attributes.id === "string" ? { "data-annotation-id": attributes.id } : {},
      },
      note: {
        default: "",
        parseHTML: (element: HTMLElement) => element.getAttribute("data-note") ?? "",
        renderHTML: (attributes: { note?: unknown }) => ({
          "data-note": typeof attributes.note === "string" ? attributes.note : "",
        }),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: "span[data-annotation-id]",
        getAttrs: (element: HTMLElement) => {
          const id = element.getAttribute("data-annotation-id");
          return id ? { id, note: element.getAttribute("data-note") ?? "" } : false;
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, { class: "note-annotation" }),
      0,
    ] as DOMOutputSpec;
  },

  transformPastedHTML(html) {
    const ids = new Map<string, string>();
    return html.replace(/data-annotation-id="([^"]*)"/g, (_match, id: string) => {
      let next = ids.get(id);
      if (!next) {
        next = createUuid();
        ids.set(id, next);
      }
      return `data-annotation-id="${next}"`;
    });
  },

  markdownTokenizer: {
    name: "noteAnnotation",
    level: "inline",
    start: "<span data-annotation-id=",
    tokenize(source, _tokens, lexer) {
      return tokenizeInlineHtmlTag(source, "span", "noteAnnotation", lexer, "data-annotation-id");
    },
  },

  parseMarkdown(token: AnnotationToken, helpers) {
    const attributes = token.attributes ?? "";
    const id = openingTagAttribute(attributes, "data-annotation-id");
    const note = openingTagAttribute(attributes, "data-note");
    return helpers.applyMark("noteAnnotation", helpers.parseInline(token.tokens ?? []), {
      id: id ? decodeHtmlAttribute(id) : null,
      note: note ? decodeHtmlAttribute(note) : "",
    });
  },

  renderMarkdown(node) {
    const id = typeof node.attrs?.id === "string" ? node.attrs.id : "";
    const note = typeof node.attrs?.note === "string" ? node.attrs.note : "";
    return `<span data-annotation-id="${escapeHtmlAttribute(id)}" data-note="${escapeHtmlAttribute(note)}">\uE000__TIPTAP_MARKDOWN_PLACEHOLDER__\uE001</span>`;
  },
});

export type AnnotationRecord = {
  id: string;
  note: string;
  from: number;
  to: number;
};

export function findAnnotationRanges(doc: ProseMirrorNode, id: string) {
  const ranges: Array<{ from: number; to: number }> = [];
  doc.descendants((node, position) => {
    if (!node.isText) return;
    const mark = node.marks.find(
      (candidate) => candidate.type.name === "noteAnnotation" && candidate.attrs.id === id,
    );
    if (!mark) return;
    const previous = ranges[ranges.length - 1];
    if (previous && previous.to === position) previous.to += node.nodeSize;
    else ranges.push({ from: position, to: position + node.nodeSize });
  });
  return ranges;
}

export function annotationIdsInRange(doc: ProseMirrorNode, from: number, to: number) {
  const ids = new Set<string>();
  const start = Math.max(0, from);
  const end = Math.min(doc.content.size, Math.max(start, to));
  doc.nodesBetween(start, end, (node) => {
    if (!node.isText) return;
    for (const mark of node.marks) {
      if (mark.type.name !== "noteAnnotation") continue;
      if (typeof mark.attrs.id === "string" && mark.attrs.id) ids.add(mark.attrs.id);
    }
  });
  return [...ids];
}

export function collectAnnotations(doc: ProseMirrorNode): AnnotationRecord[] {
  const byId = new Map<string, AnnotationRecord>();
  doc.descendants((node, position) => {
    if (!node.isText || !node.text) return;
    const mark = node.marks.find((candidate) => candidate.type.name === "noteAnnotation");
    if (!mark) return;
    const id = typeof mark.attrs.id === "string" ? mark.attrs.id : "";
    const note = typeof mark.attrs.note === "string" ? mark.attrs.note : "";
    if (!id || !note.trim()) return;
    const existing = byId.get(id);
    if (existing) {
      existing.to = Math.max(existing.to, position + node.nodeSize);
      return;
    }
    byId.set(id, { id, note, from: position, to: position + node.nodeSize });
  });
  return [...byId.values()].sort((left, right) => left.from - right.from);
}
