import { describe, expect, test } from "bun:test";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import type { EditorView } from "@tiptap/pm/view";
import { ImeMarkdownSafeExtension, imeMarkdownSafePluginKey } from "../app/ime-markdown-safe-extension";

function createComposition(text: string, cursor = text.length + 1) {
  const editor = new Editor({
    extensions: [StarterKit, ImeMarkdownSafeExtension],
    content: { type: "doc", content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : [] }] },
  });
  editor.commands.setTextSelection(cursor);
  const plugin = editor.extensionManager.plugins.find((candidate) => candidate.spec.key === imeMarkdownSafePluginKey)!;
  let state = editor.state.reconfigure({ plugins: [plugin] });
  const view = {
    get state() { return state; },
    dispatch(transaction: typeof state.tr) { state = state.applyTransaction(transaction).state; },
  } as EditorView;
  const handlers = plugin.props.handleDOMEvents!;
  return {
    start: () => handlers.compositionstart!.call(plugin, view, {} as CompositionEvent),
    insert: (value: string) => view.dispatch(state.tr.insertText(value)),
    end: (value: string) => handlers.compositionend!.call(plugin, view, { data: value } as CompositionEvent),
    cancel: () => handlers.compositioncancel!.call(plugin, view, {} as Event),
    get text() { return state.doc.textContent; },
    destroy: () => editor.destroy(),
  };
}

describe("IME prefix repair transactions", () => {
  test("preserves an existing Latin letter when Chinese is entered after it", async () => {
    const composition = createComposition("a");
    try {
      composition.start();
      composition.insert("型号");
      composition.end("型号");
      await Bun.sleep(40);
      expect(composition.text).toBe("a型号");
    } finally { composition.destroy(); }
  });

  test("preserves existing mixed text when composition is cancelled at its start", async () => {
    const composition = createComposition("a型号", 1);
    try {
      composition.start();
      composition.cancel();
      composition.end("");
      await Bun.sleep(40);
      expect(composition.text).toBe("a型号");
    } finally { composition.destroy(); }
  });

  test("repairs a tracked leak only after composition has committed", () => {
    const composition = createComposition("");
    try {
      composition.start();
      composition.insert("b标题");
      expect(composition.text).toBe("b标题");
      composition.end("标题");
      expect(composition.text).toBe("标题");
    } finally { composition.destroy(); }
  });

  test("preserves a Latin prefix included in the actual committed text", () => {
    const composition = createComposition("");
    try {
      composition.start();
      composition.insert("a型号");
      composition.end("a型号");
      expect(composition.text).toBe("a型号");
    } finally { composition.destroy(); }
  });

  test("cancellation releases tracking before subsequent input", () => {
    const composition = createComposition("");
    try {
      composition.start();
      composition.cancel();
      composition.insert("a型号");
      expect(composition.text).toBe("a型号");
    } finally { composition.destroy(); }
  });
});
