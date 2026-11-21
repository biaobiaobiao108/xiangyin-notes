import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { findLongTextRuns } from "../../shared/long-text-wrap";
import { changedDocumentRange, expandRangeToTextNodes } from "./changed-range";

export const longTextWrapKey = new PluginKey<DecorationSet>("longTextWrap");

function decorationsIn(doc: ProseMirrorNode, from = 0, to = doc.content.size) {
  const decorations: Decoration[] = [];
  doc.nodesBetween(from, to, (node, position) => {
    if (!node.text) return;
    const inlineCode = node.marks.some((mark) => mark.type.spec.code);
    for (const run of findLongTextRuns(node.text, inlineCode)) {
      const start = position + run.index;
      decorations.push(Decoration.inline(start, start + run[0].length, { class: "long-text-run" }));
    }
  });
  return decorations;
}

export const LongTextWrap = Extension.create({
  name: "longTextWrap",

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: longTextWrapKey,
        state: {
          init: (_config, { doc }) => DecorationSet.create(doc, decorationsIn(doc)),
          apply: (transaction, previous) => {
            if (!transaction.docChanged) return previous;
            const { doc, mapping } = transaction;
            // Step ranges in compound edits are expressed in intermediate documents.
            if (transaction.steps.length > 1) return DecorationSet.create(doc, decorationsIn(doc));
            const changed = changedDocumentRange(transaction, 2);
            const mapped = previous.map(mapping, doc);
            if (!changed) return mapped;
            const { from, to } = expandRangeToTextNodes(doc, changed);
            const affected = mapped
              .find(from, to)
              .filter((span) => span.from < to && span.to > from);
            return mapped.remove(affected).add(doc, decorationsIn(doc, from, to));
          },
        },
        props: { decorations: (state) => longTextWrapKey.getState(state) ?? DecorationSet.empty },
      }),
    ];
  },
});
