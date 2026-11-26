import { createContext, useContext, useEffect, useState } from "react";
import { InputRule, Node, type Editor } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { findWikiLinkStart, tokenizeWikiLink } from "../../shared/markdown-lexer";
import {
  formatWikiLink,
  WIKI_LINK_PATTERN,
  WIKI_NOTE_ID_PATTERN,
  wikiLinkDisplayText,
} from "../../shared/wiki-links";
import { api } from "../api";
import type { NoteSummary } from "../../shared/types";

export type WikiLinkNodeAttrs = {
  target: string;
  label?: string | null;
  alias?: string | null;
};

const emptyTitles: ReadonlyMap<string, string> = new Map();
export const WikiLinkTitles = createContext(emptyTitles);

export function useWikiLinkTitles(editor: Editor | null, notes: readonly NoteSummary[]) {
  const [targetIds, setTargetIds] = useState("");
  const [titles, setTitles] = useState(emptyTitles);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    let timer: ReturnType<typeof setTimeout>;
    const collectTargets = () => {
      const ids = new Set<string>();
      editor.state.doc.descendants((node) => {
        if (node.type.name === "wikiLink" && !node.attrs.alias) ids.add(node.attrs.target);
      });
      setTargetIds([...ids].sort().join(","));
    };
    const schedule = ({ transaction }: { transaction: { docChanged: boolean } }) => {
      if (!transaction.docChanged) return;
      clearTimeout(timer);
      timer = setTimeout(collectTargets, 150);
    };
    collectTargets();
    editor.on("transaction", schedule);
    return () => {
      clearTimeout(timer);
      editor.off("transaction", schedule);
    };
  }, [editor]);

  useEffect(() => {
    const ids = targetIds ? targetIds.split(",") : [];
    if (!ids.length) {
      setTitles(emptyTitles);
      return;
    }
    let controller: AbortController | undefined;
    const refresh = async () => {
      controller?.abort();
      const request = new AbortController();
      controller = request;
      const next = new Map<string, string>();
      try {
        for (let index = 0; index < ids.length; index += 100) {
          const { notes } = await api.getWikiNoteTitles(
            ids.slice(index, index + 100),
            request.signal,
          );
          if (request.signal.aborted) return;
          for (const { id, title } of notes) next.set(id, title);
        }
        setTitles(next);
      } catch (error) {
        if (!request.signal.aborted) console.warn("读取双链标题失败", error);
      }
    };
    void refresh();
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      controller?.abort();
    };
  }, [targetIds, notes]);

  return titles;
}

function displayText(attrs: WikiLinkNodeAttrs, title?: string) {
  return wikiLinkDisplayText(title === undefined ? attrs.label : title.trim(), attrs.alias);
}

function WikiLinkView({ node }: NodeViewProps) {
  const attrs = node.attrs as WikiLinkNodeAttrs;
  const titles = useContext(WikiLinkTitles);
  return (
    <NodeViewWrapper
      as="span"
      className="editor-wiki-link"
      data-wiki-link={attrs.target}
      contentEditable={false}
    >
      {displayText(attrs, titles.get(attrs.target))}
    </NodeViewWrapper>
  );
}

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
      label: { default: null },
      alias: { default: null },
    };
  },

  addInputRules() {
    return [
      new InputRule({
        find: new RegExp(`${WIKI_LINK_PATTERN.source}$`, "i"),
        handler: ({ state, range, match }) => {
          const token = tokenizeWikiLink(match[0]);
          if (!token) return null;
          const { target, label, alias } = token;
          state.tr.replaceWith(range.from, range.to, this.type.create({ target, label, alias }));
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
          const target = el.getAttribute("data-wiki-link") ?? "";
          if (!WIKI_NOTE_ID_PATTERN.test(target)) return false;
          return {
            target,
            label: el.getAttribute("data-label"),
            alias: el.getAttribute("data-alias"),
          };
        },
      },
    ];
  },

  renderHTML({ node }) {
    const attrs = node.attrs as WikiLinkNodeAttrs;
    return [
      "span",
      {
        "data-wiki-link": attrs.target,
        "data-label": attrs.label,
        "data-alias": attrs.alias,
        class: "editor-wiki-link",
      },
      displayText(attrs),
    ];
  },

  renderText({ node }) {
    return displayText(node.attrs as WikiLinkNodeAttrs);
  },

  markdownTokenizer: {
    name: "wikiLink",
    level: "inline",
    start: findWikiLinkStart,
    tokenize: tokenizeWikiLink,
  },

  parseMarkdown(token, helpers) {
    const { target, label, alias } = token as unknown as WikiLinkNodeAttrs;
    return helpers.createNode("wikiLink", { target, label, alias });
  },

  renderMarkdown(node) {
    const attrs = node.attrs as WikiLinkNodeAttrs;
    return formatWikiLink(attrs.target, attrs.label ?? undefined, attrs.alias);
  },
});

export const EditableWikiLinkNode = WikiLinkNode.extend({
  addNodeView() {
    return ReactNodeViewRenderer(WikiLinkView, { as: "span" });
  },
});
