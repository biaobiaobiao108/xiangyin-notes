import type { Editor } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";

/** A loaded document starts with fresh plugin state, including undo and redo. */
export function replaceEditorMarkdown(editor: Editor, markdown: string) {
  if (!editor.markdown) throw new Error("Markdown extension is required");
  const parsed = editor.schema.nodeFromJSON(editor.markdown.parse(markdown));
  const doc = parsed.type.createAndFill(parsed.attrs, parsed.content);
  if (!doc) throw new Error("Invalid Markdown document");
  editor.view.updateState(
    EditorState.create({
      schema: editor.schema,
      doc,
      plugins: editor.state.plugins,
    }),
  );
}
