import { describe, expect, test } from "bun:test";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { createMarkdownExtension } from "../app/editor/markdown-config";
import { ImageNode } from "../app/editor/image-node";
import { createImageUploadPosition, createImageUploadPositionPlugin } from "../app/editor/image-upload-position";
import { replaceEditorMarkdown } from "../app/editor/document-content";

function withEditor(markdown: string, run: (editor: Editor) => void) {
  const editor = new Editor({
    element: null,
    extensions: [StarterKit, createMarkdownExtension(), ImageNode],
    content: markdown || { type: "doc", content: [{ type: "paragraph" }] }, contentType: "markdown",
  });
  // Core treats unmounted editors as destroyed; this harness drives their real
  // commands and plugin state without mounting a browser view.
  Object.defineProperty(editor, "isDestroyed", { get: () => false });
  editor.registerPlugin(createImageUploadPositionPlugin());
  try { run(editor); } finally { editor.destroy(); }
}

const image = (alt: string) => ({ type: "image", attrs: { src: "https://images.example/photo.png", alt } });

describe("asynchronous image insertion", () => {
  test("preserves a later text selection and inserts at the upload origin", () => {
    withEditor("first\n\nkeep this text", (editor) => {
      editor.commands.setTextSelection(6);
      const upload = createImageUploadPosition(editor);
      editor.commands.setTextSelection({ from: 8, to: 12 });
      expect(editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to)).toBe("keep");
      expect(upload.insert(image("uploaded"))).toBe(true);
      expect(editor.state.doc.textContent).toBe("firstkeep this text");
      expect(editor.state.doc.child(1).type.name).toBe("image");
      expect(editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to)).toBe("keep");
      upload.dispose();
    });
  });

  test("maps the upload origin through edits before it", () => {
    withEditor("first\n\nsecond", (editor) => {
      editor.commands.setTextSelection(6);
      const upload = createImageUploadPosition(editor);
      editor.view.dispatch(editor.state.tr.insertText("new ", 1));
      expect(upload.insert(image("mapped"))).toBe(true);
      expect(editor.state.doc.child(0).textContent).toBe("new first");
      expect(editor.state.doc.child(1).type.name).toBe("image");
      expect(editor.state.doc.lastChild?.textContent).toBe("second");
      upload.dispose();
    });
  });

  test("keeps multiple uploaded images in order when replacing an empty paragraph", () => {
    withEditor("", (editor) => {
      const upload = createImageUploadPosition(editor);
      expect(upload.insert(image("one"))).toBe(true);
      expect(upload.insert(image("two"))).toBe(true);
      const images: string[] = [];
      editor.state.doc.descendants((node) => { if (node.type.name === "image") images.push(node.attrs.alt); });
      expect(images).toEqual(["one", "two"]);
      upload.dispose();
    });
  });

  test("cancels insertion if the original location is deleted", () => {
    withEditor("first\n\nsecond", (editor) => {
      editor.commands.setTextSelection(3);
      const upload = createImageUploadPosition(editor);
      editor.view.dispatch(editor.state.tr.delete(0, 7));
      expect(upload.insert(image("cancelled"))).toBe(false);
      expect(editor.state.doc.textContent).toBe("second");
      upload.dispose();
    });
  });

  test("invalidates pending uploads on document switches or reloads", () => {
    withEditor("first", (editor) => {
      const upload = createImageUploadPosition(editor);
      replaceEditorMarkdown(editor, "another document");
      expect(upload.insert(image("stale"))).toBe(false);
      upload.dispose();
      expect(editor.state.doc.textContent).toBe("another document");
    });
  });

  test("releases completed or failed uploads independently", () => {
    withEditor("first", (editor) => {
      const cancelled = createImageUploadPosition(editor);
      const active = createImageUploadPosition(editor);
      cancelled.dispose();
      expect(cancelled.insert(image("cancelled"))).toBe(false);
      expect(active.insert(image("active"))).toBe(true);
      active.dispose();
      expect(active.insert(image("released"))).toBe(false);
    });
  });
});
