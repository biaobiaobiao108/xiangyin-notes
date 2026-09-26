import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { Plugin, type EditorState } from "@tiptap/pm/state";

export function shouldExitCodeBlockOnEnter(state: EditorState) {
  const { selection } = state;
  const { $from } = selection;
  return selection.empty &&
    $from.parent.type.name === "codeBlock" &&
    $from.parentOffset === $from.parent.content.size &&
    $from.parent.textContent.endsWith("\n");
}

export function handleCodeBlockDoubleEnter(editor: Editor, event: { key?: string; isComposing?: boolean; keyCode?: number }) {
  if (event.key !== "Enter") return false;
  if (editor.view.composing || event.isComposing || event.keyCode === 229) return false;
  if (!shouldExitCodeBlockOnEnter(editor.state)) return false;

  const { from } = editor.state.selection;
  return editor.chain()
    .command(({ tr }) => {
      tr.delete(from - 1, from);
      return true;
    })
    .exitCode()
    .run();
}

export const CodeBlockDoubleEnter = Extension.create({
  name: "codeBlockDoubleEnter",
  priority: 110,

  addProseMirrorPlugins() {
    return [new Plugin({
      props: {
        handleKeyDown: (_view, event) => handleCodeBlockDoubleEnter(this.editor, event),
      },
    })];
  },
});
