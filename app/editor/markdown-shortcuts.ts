import { findWrapping } from "@tiptap/pm/transform";
import type { EditorView } from "@tiptap/pm/view";
import { parseMarkdownBlockShortcut, type MarkdownBlockShortcut } from "../editor-metrics";
import { imeMarkdownSafePluginKey } from "../ime-markdown-safe-extension";

const WRAPPER_NODES: Partial<Record<MarkdownBlockShortcut["type"], string>> = {
  blockquote: "blockquote",
  bulletList: "bulletList",
  orderedList: "orderedList",
  taskList: "taskList",
};

export function executeBlockShortcut(
  view: EditorView,
  from: number,
  shortcut: MarkdownBlockShortcut,
): boolean {
  const $from = view.state.doc.resolve(from);
  const start = $from.start();
  const tr = view.state.tr.delete(start, from);

  if (shortcut.type === "heading") {
    const headingNode = view.state.schema.nodes.heading;
    if (!headingNode) return false;
    tr.setBlockType(start, start, headingNode, { level: shortcut.level });
  } else if (shortcut.type === "codeBlock") {
    const codeBlockNode = view.state.schema.nodes.codeBlock;
    if (!codeBlockNode) return false;
    tr.setBlockType(start, start, codeBlockNode);
  } else {
    const nodeName = WRAPPER_NODES[shortcut.type];
    const wrapperNode = nodeName ? view.state.schema.nodes[nodeName] : undefined;
    const range = tr.doc.resolve(start).blockRange();
    if (!wrapperNode || !range) return false;
    const wrapping = findWrapping(range, wrapperNode);
    if (!wrapping) return false;
    tr.wrap(range, wrapping);
  }

  tr.setMeta(imeMarkdownSafePluginKey, { type: "blockConverted", pos: start });
  view.dispatch(tr.scrollIntoView());
  return true;
}

/** Applies a shortcut committed by an input method at the current text cursor. */
export function executeBlockShortcutAtSelection(view: EditorView): boolean {
  if (view.isDestroyed || !view.state.selection.empty) return false;
  const { $from } = view.state.selection;
  if ($from.parent.type.name !== "paragraph") return false;
  const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, "\uFFFC");
  const shortcut = parseMarkdownBlockShortcut(textBefore);
  return shortcut ? executeBlockShortcut(view, $from.pos, shortcut) : false;
}
