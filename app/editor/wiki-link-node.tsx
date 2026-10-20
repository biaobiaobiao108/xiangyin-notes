import { findWikiLinkStart, tokenizeWikiLink } from "../../shared/markdown-lexer";
import { InputRule, Node, mergeAttributes } from "@tiptap/core";
import { decodeWikiLinkComponent, encodeWikiLinkComponent, WIKI_LINK_PATTERN } from "../../shared/wiki-links";

export type WikiLinkNodeAttrs = {
  target: string;
  alias?: string | null;
};

export const WikiLinkNode = Node.create({
  name: "wikiLink",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,
  markdownTokenName: "wikiLink",

  addAttributes() {
    return {
      target: { default: "" },
      alias: { default: null },
    };
  },

  addInputRules() {
    return [
      new InputRule({
        find: new RegExp(`${WIKI_LINK_PATTERN.source}$`),
        handler: ({ state, range, match }) => {
          const target = decodeWikiLinkComponent(match[1]?.trim() ?? "");
          if (!target) return null;
          const alias = match[2] ? decodeWikiLinkComponent(match[2].trim()) || null : null;
          const { tr } = state;
          tr.replaceWith(
            range.from,
            range.to,
            this.type.create({ target, alias })
          );
        },
      }),
    ];
  },

  parseHTML() {
    return [
      {
        tag: "span[data-wiki-link]",
        getAttrs: (dom) => {
          const el = dom as HTMLElement;
          return {
            target: el.getAttribute("data-wiki-link") ?? "",
            alias: el.getAttribute("data-alias") || null,
          };
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    const target = (HTMLAttributes.target as string) ?? "";
    const alias = HTMLAttributes.alias as string | null | undefined;
    const displayText = alias || target;
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-wiki-link": target,
        "data-alias": alias || undefined,
        class: "editor-wiki-link",
      }),
      displayText,
    ];
  },

  renderText({ node }) {
    return String(node.attrs.alias || node.attrs.target || "");
  },

  markdownTokenizer: {
    name: "wikiLink",
    level: "inline",
    start: findWikiLinkStart,
    tokenize: tokenizeWikiLink,
  },

  parseMarkdown(token, helpers) {
    const t = token as unknown as { target: string; alias?: string };
    return helpers.createNode("wikiLink", { target: t.target, alias: t.alias || null });
  },

  renderMarkdown(node) {
    const attrs = node.attrs as { target: string; alias?: string | null };
    const target = encodeWikiLinkComponent(attrs.target, "target");
    return attrs.alias
      ? `[[${target}|${encodeWikiLinkComponent(attrs.alias, "alias")}]]`
      : `[[${target}]]`;
  },
});
