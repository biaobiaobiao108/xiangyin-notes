import { Markdown } from "@tiptap/markdown";
import { type marked } from "marked";
import { createXiangyingMarked } from "../../shared/markdown-lexer";

const XiangyingMarkdown = Markdown.extend({
  addOptions() {
    return {
      ...this.parent!(),
      // Tiptap registers tokenizers on this instance when it creates a manager.
      marked: createXiangyingMarked() as unknown as typeof marked,
    };
  },
});

export function createMarkdownExtension() {
  return XiangyingMarkdown;
}
