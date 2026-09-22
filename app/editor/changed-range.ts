import type { Transaction } from "@tiptap/pm/state";

export type ChangedDocumentRange = {
  from: number;
  to: number;
};

/** Returns the smallest new-document range affected by a transaction, with padding for text matches. */
export function changedDocumentRange(transaction: Transaction, padding = 0): ChangedDocumentRange | null {
  if (!transaction.docChanged) return null;
  let from = transaction.doc.content.size;
  let to = 0;
  for (const map of transaction.mapping.maps) {
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      from = Math.min(from, newStart);
      to = Math.max(to, newEnd);
    });
  }
  if (from > to) return { from: 0, to: transaction.doc.content.size };
  return {
    from: Math.max(0, from - padding),
    to: Math.min(transaction.doc.content.size, to + padding),
  };
}

export function expandRangeToTextNodes(doc: Transaction["doc"], range: ChangedDocumentRange): ChangedDocumentRange {
  let from = range.from;
  let to = range.to;
  doc.nodesBetween(range.from, range.to, (node, position) => {
    if (!node.isText) return;
    from = Math.min(from, position);
    to = Math.max(to, position + node.nodeSize);
  });
  return { from, to };
}
