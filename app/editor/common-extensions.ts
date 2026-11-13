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
import { ImeMarkdownSafeExtension } from "../ime-markdown-safe-extension";

type CommonEditorExtensionOptions = {
  placeholder?: string;
  openLinksOnClick?: boolean;
};

/** The Markdown editing contract shared by notes and short-form memos. */
export function createCommonEditorExtensions({
  placeholder,
  openLinksOnClick = false,
}: CommonEditorExtensionOptions = {}) {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4, 5, 6] },
      link: false,
      codeBlock: false,
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
    TaskList,
    TaskItem.configure({ nested: true }),
    ...(placeholder ? [Placeholder.configure({ placeholder })] : []),
    createMarkdownExtension(),
    ImeMarkdownSafeExtension,
    TagDecorationExtension,
  ];
}
