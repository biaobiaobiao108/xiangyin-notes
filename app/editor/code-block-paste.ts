import type { EditorView } from "@tiptap/pm/view";

export function pastePlainTextIntoCodeBlock(view: EditorView, text: string) {
  if (!text) return false;

  const { $from, $to } = view.state.selection;
  if (!$from.parent.type.spec.code || !$from.sameParent($to)) return false;

  view.dispatch(view.state.tr.insertText(text).setMeta("uiEvent", "paste").scrollIntoView());
  return true;
}
