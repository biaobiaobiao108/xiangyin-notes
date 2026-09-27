import Link from "@tiptap/extension-link";

export const NoteLink = Link.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      title: { default: null, rendered: false },
    };
  },
});
