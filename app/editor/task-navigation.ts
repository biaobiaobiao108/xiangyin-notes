import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export const taskNavigationPluginKey = new PluginKey<DecorationSet>("taskNavigation");

type TaskNavigationMeta = number | { type: "fade" } | null;

export function createTaskNavigationPlugin() {
  return new Plugin<DecorationSet>({
    key: taskNavigationPluginKey,
    state: {
      init: () => DecorationSet.empty,
      apply(transaction, previous) {
        const meta = transaction.getMeta(taskNavigationPluginKey) as TaskNavigationMeta | undefined;
        if (meta === null) return DecorationSet.empty;
        if (meta !== undefined) {
          const current = typeof meta === "number" ? undefined : previous.find()[0];
          const position = typeof meta === "number" ? meta : current?.from;
          const node = position === undefined ? undefined : transaction.doc.nodeAt(position);
          if (position !== undefined && node?.type.name === "taskItem")
            return DecorationSet.create(transaction.doc, [
              Decoration.node(position, position + node.nodeSize, {
                class:
                  typeof meta === "number"
                    ? "task-navigation-highlight"
                    : "task-navigation-highlight is-fading",
              }),
            ]);
          return DecorationSet.empty;
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
  const matchingPositions: number[] = [];
  const normalize = (value: string) => value.replace(/\s+/gu, " ").trim();
  const targetText = normalize(text);
  doc.descendants((node, pos) => {
    if (node.type.name !== "taskItem") return;
    const currentOrdinal = index++;
    if (normalize(node.firstChild?.textContent ?? "") !== targetText) return;
    matchingPositions.push(pos);
    if (currentOrdinal === ordinal) position = pos;
  });
  return position ?? (matchingPositions.length === 1 ? matchingPositions[0]! : null);
}
