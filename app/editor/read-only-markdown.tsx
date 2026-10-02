import { useEffect, useMemo, useRef } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { createMarkdownExtension } from "./markdown-config";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { editorCoreExtensionOptions } from "./editor-config";
import { ImageNode } from "./image-node";
import { TagDecorationExtension } from "./tag-decoration";
import { WikiLinkNode } from "./wiki-link-node";
import { CalloutNode } from "./callout-node";
import { NoteLink } from "./note-link";
import { CodeBlockWithCopy } from "./code-block-copy";
import { TableScrollbars } from "./table-scrollbars";
import { createTableExtensions } from "./table-extensions";

export function createReadOnlyExtensions() {
  return [
    StarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] }, link: false, codeBlock: false }),
    CodeBlockWithCopy.configure({ exitOnTripleEnter: false }),
    ...createTableExtensions(),
    NoteLink.configure({ openOnClick: true, autolink: true, HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    createMarkdownExtension(),
    CalloutNode,
    ImageNode,
    WikiLinkNode,
    TagDecorationExtension,
  ];
}


export function ReadOnlyMarkdown({ markdown }: { markdown: string }) {
  const initialContentRef = useRef(markdown);
  const rootRef = useRef<HTMLDivElement>(null);
  const extensions = useMemo(createReadOnlyExtensions, []);
  const editorProps = useMemo(() => ({ attributes: { class: "note-prose read-only-prose" } }), []);
  const editor = useEditor({ editable: false, extensions, coreExtensionOptions: editorCoreExtensionOptions, content: initialContentRef.current, contentType: "markdown", editorProps });

  const previousMarkdownRef = useRef(markdown);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (previousMarkdownRef.current !== markdown) {
      previousMarkdownRef.current = markdown;
      editor.commands.setContent(markdown, { contentType: "markdown", emitUpdate: false });
    }
  }, [editor, markdown]);

  return <div ref={rootRef} className="markdown-render-shell"><EditorContent editor={editor} /><TableScrollbars rootRef={rootRef} /></div>;
}
