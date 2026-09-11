import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export type TextSearchMatch = {
  start: number;
  end: number;
};

export type EditorSearchMatch = {
  from: number;
  to: number;
};

export type SearchHighlightState = {
  query: string;
  matches: EditorSearchMatch[];
  decorations: DecorationSet;
};

export const searchHighlightPluginKey = new PluginKey<SearchHighlightState>("editorSearchHighlight");

const HAN_RE = /\p{Script=Han}/u;

export function getSearchTerms(query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const normalized = trimmed.toLocaleLowerCase("zh-CN");
  if (HAN_RE.test(trimmed)) return [normalized];

  return normalized
    .split(/\s+/u)
    .map((term) => term.replace(/[^\p{L}\p{N}_-]/gu, ""))
    .filter(Boolean);
}

export function findTextMatches(text: string, query: string): TextSearchMatch[] {
  const terms = getSearchTerms(query);
  if (!text || !terms.length) return [];

  const normalizedText = text.toLocaleLowerCase("zh-CN");
  const matches: TextSearchMatch[] = [];
  for (const term of terms) {
    let start = 0;
    while (start < normalizedText.length) {
      const matchStart = normalizedText.indexOf(term, start);
      if (matchStart === -1) break;
      matches.push({ start: matchStart, end: matchStart + term.length });
      start = matchStart + Math.max(term.length, 1);
    }
  }

  matches.sort((left, right) => left.start - right.start || right.end - left.end);
  const merged: TextSearchMatch[] = [];
  for (const match of matches) {
    const previous = merged[merged.length - 1];
    if (!previous || match.start > previous.end) {
      merged.push(match);
    } else if (match.end > previous.end) {
      previous.end = match.end;
    }
  }
  return merged;
}

export function findEditorSearchMatches(doc: ProseMirrorNode, query: string): EditorSearchMatch[] {
  const matches: EditorSearchMatch[] = [];
  doc.descendants((node, position) => {
    if (!node.isText || !node.text) return;
    for (const match of findTextMatches(node.text, query)) {
      matches.push({ from: position + match.start, to: position + match.end });
    }
  });
  return matches;
}

function createSearchHighlightState(doc: ProseMirrorNode, query: string): SearchHighlightState {
  const matches = findEditorSearchMatches(doc, query);
  const decorations = DecorationSet.create(doc, matches.map((match, index) => Decoration.inline(
    match.from,
    match.to,
    { class: index === 0 ? "editor-search-match editor-search-match--active" : "editor-search-match" },
  )));
  return { query, matches, decorations };
}

export const SearchHighlightExtension = Extension.create({
  name: "editorSearchHighlight",

  addProseMirrorPlugins() {
    return [
      new Plugin<SearchHighlightState>({
        key: searchHighlightPluginKey,
        state: {
          init: () => ({ query: "", matches: [], decorations: DecorationSet.empty }),
          apply: (transaction, previous) => {
            const nextQuery = transaction.getMeta(searchHighlightPluginKey);
            if (typeof nextQuery === "string") return createSearchHighlightState(transaction.doc, nextQuery);
            if (transaction.docChanged && previous.query) return createSearchHighlightState(transaction.doc, previous.query);
            return previous;
          },
        },
        props: {
          decorations: (state) => searchHighlightPluginKey.getState(state)?.decorations ?? DecorationSet.empty,
        },
      }),
    ];
  },
});
