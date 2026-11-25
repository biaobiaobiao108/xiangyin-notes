import type { Editor } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createCommonEditorExtensions } from "../editor/common-extensions";
import { editorCoreExtensionOptions } from "../editor/editor-config";
import { useContextMenu } from "../context-menu";
import { copyPlainText } from "../editor/code-block-copy";
import { pastePlainTextIntoCodeBlock } from "../editor/code-block-paste";
import {
  executeBlockShortcutAtSelection,
  handleMarkdownBlockShortcutInput,
} from "../editor/markdown-shortcuts";
import { normalizeChineseMarkdownBlockMarkers, shouldParseMarkdownPaste } from "../editor-metrics";
import { WikiLinkNode } from "../editor/wiki-link-node";
import { TableScrollbars } from "../editor/table-scrollbars";
import { isMermaidLanguage } from "../mermaid/protocol";
import { buildMemoComposerMenuItems } from "./memo-context-menu";
import { normalizeMemoComposerContent } from "./memo-markdown-spacing";

type EditorWithMarkdown = Editor & { getMarkdown: () => string };
type SubmitReason = "shortcut" | "blur";

export function isMemoSubmitShortcut(event: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}): boolean {
  if (event.isComposing || event.keyCode === 229) return false;
  return event.key === "Enter" && Boolean(event.ctrlKey || event.metaKey);
}

export function isMemoCancelShortcut(event: {
  key: string;
  isComposing?: boolean;
  keyCode?: number;
}) {
  return event.key === "Escape" && !event.isComposing && event.keyCode !== 229;
}

export function handleEmptyMemoPaste(event: ClipboardEvent) {
  const data = event.clipboardData;
  if (!data || data.files.length) return false;
  const textTypes = ["text/plain", "text/html", "text/uri-list", "Text"];
  if (Array.from(data.types).some((type) => !textTypes.includes(type))) return false;
  if (textTypes.some((type) => data.getData(type))) return false;
  // ProseMirror otherwise focuses a hidden textarea to capture the paste,
  // which would cause the memo's blur handler to save and close the editor.
  event.preventDefault();
  return true;
}

export type MemoComposerHandle = {
  focus: () => void;
  discardPendingDraft: () => void;
  getMarkdown: () => string;
};

export type MemoComposerProps = {
  initialMarkdown?: string;
  placeholder: string;
  ariaLabel: string;
  autoFocus?: boolean;
  className?: string;
  resetOnSubmit?: boolean;
  onDraftChange?: (markdown: string) => void;
  onSubmit: (markdown: string, unchangedSource?: string) => Promise<void>;
  onSaveError: (reason: unknown) => void;
  onCancel?: () => void;
};

export function createMemoEditorExtensions(placeholder?: string) {
  return [...createCommonEditorExtensions({ placeholder, trailingNode: false }), WikiLinkNode];
}

export const MemoComposer = forwardRef<MemoComposerHandle, MemoComposerProps>(function MemoComposer(
  {
    initialMarkdown = "",
    placeholder,
    ariaLabel,
    autoFocus = false,
    className = "",
    resetOnSubmit = false,
    onDraftChange,
    onSubmit,
    onSaveError,
    onCancel,
  },
  ref,
) {
  const rootRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<EditorWithMarkdown | null>(null);
  const initialDocumentRef = useRef<Editor["state"]["doc"] | null>(null);
  const initialSourceRef = useRef(initialMarkdown);
  const { openMenu, menu } = useContextMenu();
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingDraftRef = useRef<string | null>(null);
  const onSubmitRef = useRef(onSubmit);
  const onSaveErrorRef = useRef(onSaveError);
  const onDraftChangeRef = useRef(onDraftChange);
  const onCancelRef = useRef(onCancel);
  const resetOnSubmitRef = useRef(resetOnSubmit);
  const savingRef = useRef(false);
  const closingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  onSubmitRef.current = onSubmit;
  onSaveErrorRef.current = onSaveError;
  onDraftChangeRef.current = onDraftChange;
  onCancelRef.current = onCancel;
  resetOnSubmitRef.current = resetOnSubmit;

  const discardPendingDraft = useCallback(() => {
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = null;
    pendingDraftRef.current = null;
  }, []);

  const flushPendingDraft = useCallback(() => {
    const markdown = pendingDraftRef.current;
    discardPendingDraft();
    if (markdown !== null) onDraftChangeRef.current?.(markdown);
  }, [discardPendingDraft]);

  useImperativeHandle(ref, () => ({
    focus: () => {
      editorRef.current?.commands.focus("end");
    },
    discardPendingDraft,
    getMarkdown: () => editorRef.current?.getMarkdown() ?? "",
  }));

  const extensions = useMemo(() => createMemoEditorExtensions(placeholder), [placeholder]);

  const queueDraft = useCallback(
    (markdown: string) => {
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
      pendingDraftRef.current = markdown;
      draftTimerRef.current = setTimeout(flushPendingDraft, 180);
    },
    [flushPendingDraft],
  );

  const submit = useCallback(
    async (reason: SubmitReason) => {
      const instance = editorRef.current;
      if (!instance || instance.isDestroyed || savingRef.current || closingRef.current) return;
      const markdown = instance.getMarkdown();
      if (!markdown.trim()) {
        if (reason === "shortcut") instance.commands.focus("end");
        return;
      }
      flushPendingDraft();
      savingRef.current = true;
      setSaving(true);
      // Freeze the editor before yielding to the network so the saved snapshot
      // cannot diverge from text that would be cleared or unmounted on success.
      instance.setEditable(false, false);
      try {
        const unchangedSource = initialDocumentRef.current?.eq(instance.state.doc)
          ? initialSourceRef.current
          : undefined;
        await onSubmitRef.current(markdown, unchangedSource);
        discardPendingDraft();
        if (resetOnSubmitRef.current && !instance.isDestroyed) {
          instance.commands.clearContent(false);
          if (reason === "shortcut") instance.commands.blur();
        }
      } catch (reason) {
        onSaveErrorRef.current(reason);
      } finally {
        savingRef.current = false;
        setSaving(false);
        if (!instance.isDestroyed) instance.setEditable(true, false);
      }
    },
    [discardPendingDraft, flushPendingDraft],
  );

  const cancel = useCallback(() => {
    if (!onCancelRef.current || savingRef.current) return;
    closingRef.current = true;
    flushPendingDraft();
    onCancelRef.current();
  }, [flushPendingDraft]);

  const handleKeyDownInEditor = useCallback(
    (_view: unknown, event: KeyboardEvent) => {
      if (isMemoSubmitShortcut(event)) {
        event.preventDefault();
        event.stopPropagation();
        void submit("shortcut");
        return true;
      }
      if (isMemoCancelShortcut(event) && onCancelRef.current) {
        event.preventDefault();
        event.stopPropagation();
        cancel();
        return true;
      }
      return false;
    },
    [cancel, submit],
  );

  const replaceSelectionWithChineseMarkdown = useCallback((view: Editor["view"], text: string) => {
    if (!shouldParseMarkdownPaste(text, false)) return false;
    const instance = editorRef.current;
    if (!instance?.markdown) return false;
    try {
      const parsedDocument = view.state.schema.nodeFromJSON(
        instance.markdown.parse(normalizeChineseMarkdownBlockMarkers(text)),
      );
      const slice = parsedDocument.slice(0, parsedDocument.content.size);
      view.dispatch(view.state.tr.replaceSelection(slice).setMeta("uiEvent", "paste"));
      return true;
    } catch {
      return false;
    }
  }, []);

  const editorProps = useMemo(
    () => ({
      attributes: {
        class: "memo-composer-prose note-prose",
        "aria-label": ariaLabel,
      },
      handleTextInput: (view: Editor["view"], from: number, to: number, text: string) =>
        handleMarkdownBlockShortcutInput(view, from, to, text),
      handlePaste: (view: Editor["view"], event: ClipboardEvent) => {
        const text = event.clipboardData?.getData("text/plain") ?? "";
        const html = event.clipboardData?.getData("text/html") ?? "";
        if (pastePlainTextIntoCodeBlock(view, text)) return true;
        if (!shouldParseMarkdownPaste(text, Boolean(html))) return false;
        return replaceSelectionWithChineseMarkdown(view, text);
      },
      handleDOMEvents: {
        paste: (_view: Editor["view"], event: ClipboardEvent) => handleEmptyMemoPaste(event),
        compositionend: (view: Editor["view"]) => {
          window.setTimeout(() => {
            if (!view.isDestroyed) executeBlockShortcutAtSelection(view);
          }, 30);
          return false;
        },
      },
      handleKeyDown: handleKeyDownInEditor,
    }),
    [ariaLabel, handleKeyDownInEditor, replaceSelectionWithChineseMarkdown],
  );

  const handleContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      const instance = editorRef.current;
      if (!instance || instance.isDestroyed || instance.view.composing) return;
      const { selection, doc } = instance.state;
      const editable = instance.isEditable && !savingRef.current;
      const hasSelection = !selection.empty;

      const restore = () => {
        if (
          instance.isDestroyed ||
          !instance.isEditable ||
          instance.state.doc !== doc ||
          !instance.state.selection.eq(selection)
        )
          return false;
        instance.view.dispatch(instance.state.tr.setSelection(selection));
        instance.view.focus();
        return true;
      };

      const copy = async (cut = false) => {
        const { dom, text } = instance.view.serializeForClipboard(selection.content());
        try {
          if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
            await navigator.clipboard.write([
              new ClipboardItem({
                "text/plain": new Blob([text], { type: "text/plain" }),
                "text/html": new Blob([dom.innerHTML], { type: "text/html" }),
              }),
            ]);
          } else {
            await copyPlainText(text);
          }
        } catch {
          try {
            await copyPlainText(text);
          } catch {
            throw new Error("浏览器未允许写入剪贴板");
          }
        }
        if (cut) {
          if (!restore()) throw new Error("随记已更改，请重新选择后剪切");
          instance.commands.deleteSelection();
        }
      };

      const paste = async (plain = false) => {
        let text = "";
        let html = "";
        try {
          if (!plain && navigator.clipboard?.read) {
            const items = await navigator.clipboard.read();
            for (const item of items) {
              if (item.types.includes("text/plain"))
                text = await (await item.getType("text/plain")).text();
              if (item.types.includes("text/html"))
                html = await (await item.getType("text/html")).text();
            }
          } else if (navigator.clipboard?.readText) {
            text = await navigator.clipboard.readText();
          }
        } catch {
          throw new Error("浏览器未允许读取剪贴板");
        }
        if (!restore()) throw new Error("随记已更改，请重新选择位置后粘贴");
        if (pastePlainTextIntoCodeBlock(instance.view, text)) return;
        if (plain) {
          if (text) instance.commands.insertContent(text);
          return;
        }
        const data = new DataTransfer();
        if (text) data.setData("text/plain", text);
        if (html) data.setData("text/html", html);
        const clipboardEvent = new ClipboardEvent("paste", { clipboardData: data });
        if (html) instance.view.pasteHTML(html, clipboardEvent);
        else if (text && !replaceSelectionWithChineseMarkdown(instance.view, text))
          instance.view.pasteText(text, clipboardEvent);
      };

      const command = (run: () => unknown) => () => {
        if (restore()) run();
      };

      const items = buildMemoComposerMenuItems({
        canUndo: instance.can().undo(),
        canRedo: instance.can().redo(),
        hasSelection,
        editable,
        isEditingMemo: Boolean(onCancelRef.current),
        actions: {
          undo: command(() => instance.commands.undo()),
          redo: command(() => instance.commands.redo()),
          cut: () => copy(true),
          copy: () => copy(false),
          paste: () => paste(false),
          pastePlain: () => paste(true),
          selectAll: command(() => instance.commands.selectAll()),
          toggleBold: command(() => instance.commands.toggleBold()),
          toggleItalic: command(() => instance.commands.toggleItalic()),
          clearFormatting: command(() => instance.chain().focus().unsetAllMarks().run()),
          submit: editable && !instance.isEmpty ? () => void submit("shortcut") : undefined,
          cancel: onCancelRef.current ? () => cancel() : undefined,
        },
      });

      openMenu(event, items, onCancelRef.current ? "编辑随记" : "新建随记");
    },
    [cancel, openMenu, replaceSelectionWithChineseMarkdown, submit],
  );

  const editor = useEditor({
    extensions,
    coreExtensionOptions: editorCoreExtensionOptions,
    content: normalizeMemoComposerContent(initialMarkdown),
    contentType: "markdown",
    editorProps,
    onCreate: ({ editor: instance }) => {
      initialDocumentRef.current = instance.state.doc;
      if (!autoFocus) return;
      const { $from } = instance.state.selection;
      // Focusing the source of a diagram would open it during the card transition.
      if (
        $from.parent.type.name === "codeBlock" &&
        isMermaidLanguage($from.parent.attrs.language)
      ) {
        const block = instance.view.nodeDOM($from.before());
        if (block instanceof HTMLElement) {
          const trigger = block.querySelector<HTMLButtonElement>(".mermaid-edit-trigger");
          if (trigger) {
            trigger.focus({ preventScroll: true });
            return;
          }
        }
      }
      instance.view.focus();
    },
    onUpdate: ({ editor: instance }) => {
      const markdown = (instance as EditorWithMarkdown).getMarkdown();
      queueDraft(markdown);
    },
  });
  editorRef.current = editor as EditorWithMarkdown | null;

  useEffect(() => {
    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") flushPendingDraft();
    };
    document.addEventListener("visibilitychange", flushWhenHidden);
    window.addEventListener("pagehide", flushPendingDraft);
    return () => {
      document.removeEventListener("visibilitychange", flushWhenHidden);
      window.removeEventListener("pagehide", flushPendingDraft);
      flushPendingDraft();
    };
  }, [flushPendingDraft]);

  return (
    <div
      ref={rootRef}
      className={`memo-composer ${className}`.trim()}
      aria-busy={saving}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (
          next instanceof Element &&
          (event.currentTarget.contains(next) || next.closest(".context-menu, .memo-conflict"))
        )
          return;
        void submit("blur");
      }}
      onKeyDown={(event) => {
        if (isMemoSubmitShortcut(event.nativeEvent)) {
          event.preventDefault();
          void submit("shortcut");
        } else if (isMemoCancelShortcut(event.nativeEvent) && onCancelRef.current) {
          event.preventDefault();
          cancel();
        } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
          const instance = editorRef.current;
          if (!instance || instance.isDestroyed) return;
          event.preventDefault();
          event.stopPropagation();
          const coords = instance.view.coordsAtPos(instance.state.selection.from);
          handleContextMenu({
            clientX: coords.left,
            clientY: coords.bottom + 4,
            currentTarget: event.currentTarget,
            target: event.target,
            preventDefault() {},
            stopPropagation() {},
            defaultPrevented: false,
          } as unknown as ReactMouseEvent<HTMLElement>);
        }
      }}
      onContextMenu={handleContextMenu}
    >
      <EditorContent editor={editor} />
      <TableScrollbars rootRef={rootRef} />
      {menu}
    </div>
  );
});
