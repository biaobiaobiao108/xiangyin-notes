import { describe, expect, test } from "bun:test";
import { Editor, Node } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";

const WikiLinkNode = Node.create({
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
      {
        "data-wiki-link": target,
        "data-alias": alias || undefined,
        class: "editor-wiki-link",
      },
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

describe("WikiLinkNode markdown integration", () => {
  test("parses and serializes wiki links seamlessly with @tiptap/markdown", () => {
    const editor = new Editor({
      extensions: [StarterKit, Markdown, WikiLinkNode],
      content: "Hello [[目标笔记]] and [[目标笔记|别名展示]] world!",
      contentType: "markdown",
    });

    const json = editor.getJSON();
    expect((json.content?.[0].content?.[1] as any)?.type).toBe("wikiLink");
    expect((json.content?.[0].content?.[1] as any)?.attrs?.target).toBe("目标笔记");

    const markdown = (editor as any).getMarkdown();
    expect(markdown).toBe("Hello [[目标笔记]] and [[目标笔记|别名展示]] world!");
    editor.destroy();
  });
});
