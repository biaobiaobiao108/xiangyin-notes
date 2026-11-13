import { useEffect, useMemo, useRef } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { editorCoreExtensionOptions } from "./editor-config";
import { createCommonEditorExtensions } from "./common-extensions";
import { ImageNode } from "./image-node";
import { WikiLinkNode } from "./wiki-link-node";
import { CalloutNode } from "./callout-node";
import { TableScrollbars } from "./table-scrollbars";
import { normalizeImagesInEmptyListItems } from "../image-markdown";
import { NoteAnnotation, NoteHighlight } from "./highlight-annotation";

export function prepareMarkdownForReadOnly(markdown: string) {
  return normalizeImagesInEmptyListItems(markdown);
}

export function createReadOnlyExtensions() {
  return [
    ...createCommonEditorExtensions({ openLinksOnClick: true }),
    NoteHighlight,
    NoteAnnotation,
    CalloutNode,
    ImageNode,
    WikiLinkNode,
  ];
}

export function ReadOnlyMarkdown({ markdown }: { markdown: string }) {
  const initialContentRef = useRef(markdown);
  const rootRef = useRef<HTMLDivElement>(null);
  const extensions = useMemo(createReadOnlyExtensions, []);
  const editorProps = useMemo(() => ({ attributes: { class: "note-prose read-only-prose" } }), []);
  const editor = useEditor({
    editable: false,
    extensions,
    coreExtensionOptions: editorCoreExtensionOptions,
    content: prepareMarkdownForReadOnly(initialContentRef.current),
    contentType: "markdown",
    editorProps,
  });

  const previousMarkdownRef = useRef(markdown);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (previousMarkdownRef.current !== markdown) {
      previousMarkdownRef.current = markdown;
      editor.commands.setContent(prepareMarkdownForReadOnly(markdown), {
        contentType: "markdown",
        emitUpdate: false,
      });
    }
  }, [editor, markdown]);

  return (
    <div ref={rootRef} className="markdown-render-shell">
      <EditorContent editor={editor} />
      <TableScrollbars rootRef={rootRef} />
    </div>
  );
}
