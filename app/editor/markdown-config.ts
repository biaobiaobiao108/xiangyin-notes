import { Markdown } from "@tiptap/markdown";
import { type marked } from "marked";
import { createXiangyingMarked } from "../../shared/markdown-lexer";

export const xiangyingMarked = createXiangyingMarked();

export function createMarkdownExtension() {
  return Markdown.configure({ marked: xiangyingMarked as unknown as typeof marked });
}
