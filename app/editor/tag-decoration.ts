import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { findTagRanges } from "../../shared/tags";

export const tagDecorationPluginKey = new PluginKey<DecorationSet>("editorTagDecoration");

function createTagDecorationSet(doc: ProseMirrorNode) {
  const decorations: Decoration[] = [];
  doc.descendants((node, position, parent) => {
    if (!node.isText || !node.text || parent?.type.name === "codeBlock") return;
    for (const range of findTagRanges(node.text)) {
      decorations.push(Decoration.inline(position + range.start, position + range.end, { class: "editor-tag" }));
    }
  });
  return DecorationSet.create(doc, decorations);
}

export const TagDecorationExtension = Extension.create({
  name: "editorTagDecoration",

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: tagDecorationPluginKey,
        state: {
          init: (_config, state) => createTagDecorationSet(state.doc),
          apply: (transaction, previous) => transaction.docChanged ? createTagDecorationSet(transaction.doc) : previous,
        },
        props: {
          decorations: (state) => tagDecorationPluginKey.getState(state) ?? DecorationSet.empty,
        },
      }),
    ];
  },
});
