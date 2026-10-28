import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export const taskNavigationPluginKey = new PluginKey<DecorationSet>("taskNavigation");

export function createTaskNavigationPlugin() {
  return new Plugin<DecorationSet>({
    key: taskNavigationPluginKey,
    state: {
      init: () => DecorationSet.empty,
      apply(transaction, previous) {
        const position = transaction.getMeta(taskNavigationPluginKey) as number | null | undefined;
        if (position === null) return DecorationSet.empty;
        if (position !== undefined) {
          const node = transaction.doc.nodeAt(position);
          return node?.type.name === "taskItem"
            ? DecorationSet.create(transaction.doc, [
                Decoration.node(position, position + node.nodeSize, {
                  class: "task-navigation-highlight",
                }),
              ])
            : DecorationSet.empty;
        }
        return previous.map(transaction.mapping, transaction.doc);
      },
    },
    props: {
      decorations: (state) => taskNavigationPluginKey.getState(state) ?? DecorationSet.empty,
    },
  });
}

export const TaskNavigationExtension = Extension.create({
  name: "taskNavigation",
  addProseMirrorPlugins: () => [createTaskNavigationPlugin()],
});

export function findTaskPosition(doc: ProseMirrorNode, ordinal: number, text: string) {
  let index = 0;
  let position: number | null = null;
  const normalize = (value: string) => value.replace(/\s+/gu, " ").trim();
  doc.descendants((node, pos) => {
    if (node.type.name !== "taskItem") return;
    if (index++ === ordinal && normalize(node.firstChild?.textContent ?? "") === normalize(text)) {
      position = pos;
    }
  });
  return position;
}
