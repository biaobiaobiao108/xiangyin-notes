import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { findTagRanges } from "../../shared/tags";
import { changedDocumentRange, expandRangeToTextNodes } from "./changed-range";

export const tagDecorationPluginKey = new PluginKey<DecorationSet>("editorTagDecoration");

function createTagDecorations(doc: ProseMirrorNode, from = 0, to = doc.content.size) {
  const decorations: Decoration[] = [];
  doc.nodesBetween(from, to, (node, position, parent) => {
    if (!node.isText || !node.text || parent?.type.name === "codeBlock") return;
    for (const range of findTagRanges(node.text)) {
      decorations.push(Decoration.inline(position + range.start, position + range.end, { class: "editor-tag" }));
    }
  });
  return decorations;
}

function createTagDecorationSet(doc: ProseMirrorNode) {
  return DecorationSet.create(doc, createTagDecorations(doc));
}

export const TagDecorationExtension = Extension.create({
  name: "editorTagDecoration",

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: tagDecorationPluginKey,
        state: {
          init: (_config, state) => createTagDecorationSet(state.doc),
          apply: (transaction, previous) => {
            if (!transaction.docChanged) return previous;
            const rawRange = changedDocumentRange(transaction, 2);
            const range = rawRange ? expandRangeToTextNodes(transaction.doc, rawRange) : null;
            if (!range) return previous.map(transaction.mapping, transaction.doc);
            const mapped = previous.map(transaction.mapping, transaction.doc);
            const removed = mapped.remove(mapped.find(range.from, range.to));
            return removed.add(transaction.doc, createTagDecorations(transaction.doc, range.from, range.to));
          },
        },
        props: {
          decorations: (state) => tagDecorationPluginKey.getState(state) ?? DecorationSet.empty,
        },
      }),
    ];
  },
});
