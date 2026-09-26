import { useMemo, useRef } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Link from "@tiptap/extension-link";
import { editorCoreExtensionOptions } from "./editor-config";
import { ImageNode } from "./image-node";
import { TagDecorationExtension } from "./tag-decoration";
import { WikiLinkNode } from "./wiki-link-node";
import { CalloutNode } from "./callout-node";
import { TableScrollbars } from "./table-scrollbars";
import { createTableExtensions } from "./table-extensions";

export function ReadOnlyMarkdown({ markdown }: { markdown: string }) {
  const initialContentRef = useRef(markdown);
  const rootRef = useRef<HTMLDivElement>(null);
  const extensions = useMemo(() => [
    StarterKit.configure({ heading: { levels: [1, 2, 3, 4] }, link: false }),
    ...createTableExtensions(),
    Link.configure({ openOnClick: true, autolink: true, HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Markdown,
    CalloutNode,
    ImageNode,
    WikiLinkNode,
    TagDecorationExtension,
  ], []);
  const editorProps = useMemo(() => ({ attributes: { class: "note-prose share-prose" } }), []);
  const editor = useEditor({ editable: false, extensions, coreExtensionOptions: editorCoreExtensionOptions, content: initialContentRef.current, contentType: "markdown", editorProps });
  return <div ref={rootRef} className="markdown-render-shell"><EditorContent editor={editor} /><TableScrollbars rootRef={rootRef} /></div>;
}
