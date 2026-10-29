import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { changedDocumentRange } from "./changed-range";

function rangeTouchesHeading(doc: ProseMirrorNode, from: number, to: number): boolean {
  const start = Math.max(0, Math.min(from, doc.content.size));
  const end = Math.max(start, Math.min(to, doc.content.size));
  const $start = doc.resolve(start);
  for (let depth = $start.depth; depth > 0; depth -= 1) {
    if ($start.node(depth).type.name === "heading") return true;
  }
  if ($start.nodeAfter?.type.name === "heading" || $start.nodeBefore?.type.name === "heading")
    return true;

  let touchesHeading = false;
  if (end > start) {
    doc.nodesBetween(start, end, (node) => {
      if (node.type.name === "heading") {
        touchesHeading = true;
        return false;
      }
      return !touchesHeading;
    });
  }
  return touchesHeading;
}

export function transactionMayChangeOutline(transaction: Transaction): boolean {
  if (!transaction.docChanged) return false;
  const range = changedDocumentRange(transaction);
  if (range && rangeTouchesHeading(transaction.doc, range.from, range.to)) return true;

  for (const map of transaction.mapping.maps) {
    let touchesHeading = false;
    map.forEach((oldStart, oldEnd, newStart, newEnd) => {
      if (
        rangeTouchesHeading(transaction.before, oldStart, oldEnd) ||
        rangeTouchesHeading(transaction.doc, newStart, newEnd)
      ) {
        touchesHeading = true;
      }
    });
    if (touchesHeading) return true;
  }
  return false;
}
