import StarterKit from "@tiptap/starter-kit";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import Placeholder from "@tiptap/extension-placeholder";
import { CodeBlockDoubleEnter } from "./code-block-enter";
import { CodeBlockWithCopy } from "./code-block-copy";
import { InlineMarkExitOnEnter } from "./inline-mark-exit";
import { NoteLink } from "./note-link";
import { createMarkdownExtension } from "./markdown-config";
import { createTableExtensions } from "./table-extensions";
import { TagDecorationExtension } from "./tag-decoration";
import { LongTextWrap } from "./long-text-wrap";
import { ImeMarkdownSafeExtension } from "../ime-markdown-safe-extension";

type CommonEditorExtensionOptions = {
  placeholder?: string;
  openLinksOnClick?: boolean;
  trailingNode?: boolean;
};

const taskListTokenizer = TaskList.config.markdownTokenizer!;
const MarkdownTaskList = TaskList.extend({
  markdownTokenizer: {
    ...taskListTokenizer,
    tokenize(source, tokens, lexer) {
      // The upstream parser skips leading blank lines, then splits the entire source.
      if (!/^(?:[^\S\n]*\n)*[^\S\n]*[-+*][^\S\n]+\[[ xX]\][^\S\n]+/u.test(source)) return undefined;
      return taskListTokenizer.tokenize(source, tokens, lexer);
    },
  },
});

/** The Markdown editing contract shared by notes and short-form memos. */
export function createCommonEditorExtensions({
  placeholder,
  openLinksOnClick = false,
  trailingNode = true,
}: CommonEditorExtensionOptions = {}) {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4, 5, 6] },
      link: false,
      codeBlock: false,
      ...(trailingNode ? {} : { trailingNode: false }),
    }),
    CodeBlockWithCopy.configure({ exitOnTripleEnter: false }),
    CodeBlockDoubleEnter,
    InlineMarkExitOnEnter,
    ...createTableExtensions(),
    NoteLink.configure({
      openOnClick: openLinksOnClick,
      autolink: true,
      linkOnPaste: true,
      ...(openLinksOnClick
        ? { HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" } }
        : {}),
    }),
    MarkdownTaskList,
    TaskItem.configure({ nested: true }),
    ...(placeholder ? [Placeholder.configure({ placeholder })] : []),
    createMarkdownExtension(),
    ImeMarkdownSafeExtension,
    TagDecorationExtension,
    LongTextWrap,
  ];
}
