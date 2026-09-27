import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";

const INLINE_FORMAT_MARKS = new Set(["bold", "italic", "strike", "underline", "code"]);
const LIST_ITEM_TYPES = new Set(["listItem", "taskItem"]);

function clearInlineFormatMarks(editor: Editor) {
  const { state, view } = editor;
  const activeMarks = state.storedMarks ?? state.selection.$from.marks();
  if (!activeMarks.some((mark) => INLINE_FORMAT_MARKS.has(mark.type.name))) return;
  view.dispatch(state.tr.setStoredMarks(activeMarks.filter((mark) => !INLINE_FORMAT_MARKS.has(mark.type.name))));
}

export function handleInlineMarkExitOnEnter(editor: Editor, event: KeyboardEvent): boolean {
  if (
    event.key === "Process" ||
    event.isComposing ||
    event.keyCode === 229 ||
    editor.view.composing
  ) return false;
  if (event.key !== "Enter") return false;

  const { selection, storedMarks } = editor.state;
  if (!selection.empty) return false;
  const activeMarks = storedMarks ?? selection.$from.marks();
  if (!activeMarks.some((mark) => INLINE_FORMAT_MARKS.has(mark.type.name))) return false;

  for (let depth = selection.$from.depth; depth > 0; depth -= 1) {
    const listItemType = selection.$from.node(depth).type.name;
    if (!LIST_ITEM_TYPES.has(listItemType)) continue;
    if (editor.can().splitListItem(listItemType)) {
      const handled = editor.chain().splitListItem(listItemType).run();
      if (handled) clearInlineFormatMarks(editor);
      return handled;
    }
    break;
  }

  const handled = editor.commands.first(({ commands }) => [
    () => commands.newlineInCode(),
    () => commands.createParagraphNear(),
    () => commands.liftEmptyBlock(),
    () => commands.splitBlock({ keepMarks: false }),
  ]);
  if (handled) clearInlineFormatMarks(editor);
  return handled;
}

export const InlineMarkExitOnEnter = Extension.create({
  name: "inlineMarkExitOnEnter",
  priority: 120,

  addProseMirrorPlugins() {
    return [new Plugin({
      props: {
        handleKeyDown: (_view, event) => handleInlineMarkExitOnEnter(this.editor, event),
      },
    })];
  },
});
