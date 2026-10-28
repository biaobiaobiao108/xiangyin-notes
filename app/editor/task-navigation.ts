import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

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
