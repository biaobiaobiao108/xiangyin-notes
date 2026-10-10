import type { TextSerializer } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { changedDocumentRange } from "./editor/changed-range";
import { countEditorText, type EditorStats } from "./editor-metrics";

export type EditorTextStatsSnapshot = {
  doc: ProseMirrorNode;
  stats: EditorStats;
};

export type EditorTextBlockStatsCache = WeakMap<ProseMirrorNode, EditorStats>;

function getEditorTextBlockContent(node: ProseMirrorNode): string {
  let text = "";
  const range = { from: 0, to: node.content.size };
  node.descendants((child, pos, parent, index) => {
    const serializer = child.type.spec.toText as TextSerializer | undefined;
    if (serializer) {
      if (parent) text += serializer({ node: child, pos, parent, index, range });
      return false;
    }
    if (child.isText) text += child.text ?? "";
  });
  return text;
}

function getEditorTextBlockStats(node: ProseMirrorNode, cache: EditorTextBlockStatsCache) {
  let stats = cache.get(node);
  if (!stats) {
    stats = countEditorText(getEditorTextBlockContent(node));
    cache.set(node, stats);
  }
  return stats;
}

export function countEditorDocumentText(doc: ProseMirrorNode, cache: EditorTextBlockStatsCache): EditorStats {
  let wordCount = 0;
  let characterCount = 0;
  doc.descendants((node) => {
    if (!node.isTextblock) return;
    const stats = getEditorTextBlockStats(node, cache);
    wordCount += stats.wordCount;
    characterCount += stats.characterCount;
  });
  return { wordCount, characterCount };
}

function collectTextBlocks(doc: ProseMirrorNode, from: number, to: number) {
  const start = Math.max(0, Math.min(from, doc.content.size));
  const end = Math.max(start, Math.min(to, doc.content.size));
  const blocks = new Set<ProseMirrorNode>();
  const addAncestors = (position: number) => {
    const $position = doc.resolve(position);
    for (let depth = $position.depth; depth > 0; depth -= 1) {
      const node = $position.node(depth);
      if (node.isTextblock) blocks.add(node);
    }
  };

  addAncestors(start);
  addAncestors(end);
  const $start = doc.resolve(start);
  if ($start.nodeBefore?.isTextblock) blocks.add($start.nodeBefore);
  if ($start.nodeAfter?.isTextblock) blocks.add($start.nodeAfter);
  if (end > start) {
    doc.nodesBetween(start, end, (node) => {
      if (node.isTextblock) {
        blocks.add(node);
        return false;
      }
      return true;
    });
  }
  return blocks;
}

export function updateEditorDocumentText(transaction: Transaction, previous: EditorTextStatsSnapshot | null, cache: EditorTextBlockStatsCache): EditorTextStatsSnapshot {
  if (!transaction.docChanged) {
    if (previous?.doc === transaction.doc) return previous;
    return { doc: transaction.doc, stats: countEditorDocumentText(transaction.doc, cache) };
  }
  if (!previous || previous.doc !== transaction.before) {
    return { doc: transaction.doc, stats: countEditorDocumentText(transaction.doc, cache) };
  }

  const changedRange = changedDocumentRange(transaction);
  if (!changedRange) return { doc: transaction.doc, stats: countEditorDocumentText(transaction.doc, cache) };

  const inverse = transaction.mapping.invert();
  const beforeFrom = Math.max(0, Math.min(transaction.before.content.size, inverse.map(changedRange.from, -1)));
  const beforeTo = Math.max(beforeFrom, Math.min(transaction.before.content.size, inverse.map(changedRange.to, 1)));
  const beforeBlocks = collectTextBlocks(transaction.before, Math.max(0, beforeFrom - 1), Math.min(transaction.before.content.size, beforeTo + 1));
  const afterBlocks = collectTextBlocks(transaction.doc, Math.max(0, changedRange.from - 1), Math.min(transaction.doc.content.size, changedRange.to + 1));

  let wordCount = previous.stats.wordCount;
  let characterCount = previous.stats.characterCount;
  for (const block of beforeBlocks) {
    const stats = getEditorTextBlockStats(block, cache);
    wordCount -= stats.wordCount;
    characterCount -= stats.characterCount;
  }
  for (const block of afterBlocks) {
    const stats = countEditorText(getEditorTextBlockContent(block));
    cache.set(block, stats);
    wordCount += stats.wordCount;
    characterCount += stats.characterCount;
  }
  return { doc: transaction.doc, stats: { wordCount, characterCount } };
}

export function getEditorDocumentTextSnapshot(doc: ProseMirrorNode, previous: EditorTextStatsSnapshot | null, cache: EditorTextBlockStatsCache) {
  return previous?.doc === doc
    ? previous
    : { doc, stats: countEditorDocumentText(doc, cache) };
}
