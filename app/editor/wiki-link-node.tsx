import { Node, mergeAttributes } from "@tiptap/core";

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
        title: `按住 Ctrl 或 ⌘ 点击跳转至「${target}」`,
      }),
      displayText,
    ];
  },

  markdownTokenizer: {
    name: "wikiLink",
    level: "inline",
    start(src: string) {
      return src.indexOf("[[");
    },
    tokenize(src: string) {
      const match = /^\[\[([^\]\r\n|]+)(?:\|([^\]\r\n]+))?\]\]/.exec(src);
      if (match) {
        return {
          type: "wikiLink",
          raw: match[0],
          target: match[1].trim(),
          alias: match[2]?.trim(),
        };
      }
      return undefined;
    },
  },

  parseMarkdown(token, helpers) {
    const t = token as unknown as { target: string; alias?: string };
    return helpers.createNode("wikiLink", { target: t.target, alias: t.alias || null });
  },

  renderMarkdown(node) {
    const attrs = node.attrs as { target: string; alias?: string | null };
    return attrs.alias ? `[[${attrs.target}|${attrs.alias}]]` : `[[${attrs.target}]]`;
  },
});
