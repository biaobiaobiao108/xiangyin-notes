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
import { buildMemoComposerMenuItems } from "./memo-context-menu";

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

export function normalizeMemoComposerContent(markdown: string) {
  return markdown.replace(/(?:\r?\n)+$/u, "");
}

export type MemoComposerHandle = {
  focus: () => void;
};

export type MemoComposerProps = {
  initialMarkdown?: string;
  placeholder: string;
  ariaLabel: string;
  autoFocus?: boolean;
  className?: string;
  resetOnSubmit?: boolean;
  onDraftChange?: (markdown: string) => void;
  onSubmit: (markdown: string) => Promise<void>;
  onCancel?: () => void;
};

function messageOf(reason: unknown) {
  return reason instanceof Error && reason.message ? reason.message : "保存失败，请重试";
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
    onCancel,
  },
  ref,
) {
  const editorRef = useRef<EditorWithMarkdown | null>(null);
  const { openMenu, menu } = useContextMenu();
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingDraftRef = useRef<string | null>(null);
  const onSubmitRef = useRef(onSubmit);
  const onDraftChangeRef = useRef(onDraftChange);
  const onCancelRef = useRef(onCancel);
  const resetOnSubmitRef = useRef(resetOnSubmit);
  const savingRef = useRef(false);
  const closingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  onSubmitRef.current = onSubmit;
  onDraftChangeRef.current = onDraftChange;
  onCancelRef.current = onCancel;
  resetOnSubmitRef.current = resetOnSubmit;

  useImperativeHandle(ref, () => ({
    focus: () => {
      editorRef.current?.commands.focus("end");
    },
  }));

  const extensions = useMemo(() => createCommonEditorExtensions({ placeholder }), [placeholder]);

  const queueDraft = useCallback((markdown: string) => {
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    pendingDraftRef.current = markdown;
    draftTimerRef.current = setTimeout(() => {
      draftTimerRef.current = null;
      pendingDraftRef.current = null;
      onDraftChangeRef.current?.(markdown);
    }, 180);
  }, []);

  const clearDraft = useCallback((instance: EditorWithMarkdown) => {
    if (draftTimerRef.current) {
      clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
    pendingDraftRef.current = null;
    instance.commands.clearContent(false);
    setError("");
    onDraftChangeRef.current?.("");
  }, []);

  const submit = useCallback(
    async (reason: SubmitReason) => {
      const instance = editorRef.current;
      if (!instance || instance.isDestroyed || savingRef.current || closingRef.current) return;
      const markdown = instance.getMarkdown();
      if (!markdown.trim()) {
        if (reason === "shortcut") instance.commands.focus("end");
        return;
      }
      savingRef.current = true;
      setSaving(true);
      // Freeze the editor before yielding to the network so the saved snapshot
      // cannot diverge from text that would be cleared or unmounted on success.
      instance.setEditable(false, false);
      setError("");
      try {
        await onSubmitRef.current(markdown);
        if (resetOnSubmitRef.current) {
          clearDraft(instance);
          if (reason === "shortcut") instance.commands.blur();
        }
      } catch (reason) {
        setError(messageOf(reason));
      } finally {
        savingRef.current = false;
        setSaving(false);
        if (!instance.isDestroyed) instance.setEditable(true, false);
      }
    },
    [clearDraft],
  );

  const cancel = useCallback(() => {
    if (!onCancelRef.current || savingRef.current) return;
    closingRef.current = true;
    onCancelRef.current();
  }, []);

  const handleKeyDownInEditor = useCallback(
    (_view: unknown, event: KeyboardEvent) => {
      if (isMemoSubmitShortcut(event)) {
        event.preventDefault();
        event.stopPropagation();
        void submit("shortcut");
        return true;
      }
      if (event.key === "Escape" && onCancelRef.current) {
        event.preventDefault();
        event.stopPropagation();
        cancel();
        return true;
      }
      return false;
    },
    [cancel, submit],
  );

  const editorProps = useMemo(
    () => ({
      attributes: {
        class: "memo-composer-prose note-prose",
        "aria-label": ariaLabel,
      },
      handleKeyDown: handleKeyDownInEditor,
    }),
    [ariaLabel, handleKeyDownInEditor],
  );

  const handleContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      const instance = editorRef.current;
      if (!instance || instance.isDestroyed || instance.view.composing) return;
      const { selection } = instance.state;
      const editable = instance.isEditable && !savingRef.current;
      const hasSelection = !selection.empty;

      const restore = () => {
        if (instance.isDestroyed || !instance.isEditable) return false;
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
        if (cut && restore() && instance.isEditable) instance.commands.deleteSelection();
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
        if (!restore() || !instance.isEditable) return;
        if (plain || !html) {
          if (text) instance.commands.insertContent(text);
        } else {
          const data = new DataTransfer();
          if (text) data.setData("text/plain", text);
          if (html) data.setData("text/html", html);
          const clipboardEvent = new ClipboardEvent("paste", { clipboardData: data });
          instance.view.pasteHTML(html, clipboardEvent);
        }
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
          submit: () => void submit("shortcut"),
          cancel: onCancelRef.current ? () => cancel() : undefined,
        },
      });

      openMenu(event, items, onCancelRef.current ? "编辑随记" : "新建随记");
    },
    [cancel, openMenu, submit],
  );

  const editor = useEditor({
    extensions,
    coreExtensionOptions: editorCoreExtensionOptions,
    content: normalizeMemoComposerContent(initialMarkdown),
    contentType: "markdown",
    editorProps,
    onCreate: ({ editor: instance }) => {
      if (autoFocus) instance.commands.focus("end");
    },
    onUpdate: ({ editor: instance }) => {
      const markdown = (instance as EditorWithMarkdown).getMarkdown();
      setError((current) => (current ? "" : current));
      queueDraft(markdown);
    },
    onBlur: () => {
      void submit("blur");
    },
  });
  editorRef.current = editor as EditorWithMarkdown | null;

  useEffect(
    () => () => {
      if (!draftTimerRef.current) return;
      clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
      // Preserve the last keystrokes when the memo surface is closed or switched.
      if (pendingDraftRef.current !== null) {
        onDraftChangeRef.current?.(pendingDraftRef.current);
        pendingDraftRef.current = null;
      }
    },
    [],
  );

  return (
    <div
      className={`memo-composer ${className}`.trim()}
      aria-busy={saving}
      onKeyDown={(event) => {
        if (isMemoSubmitShortcut(event.nativeEvent)) {
          event.preventDefault();
          void submit("shortcut");
        } else if (event.key === "Escape" && onCancelRef.current) {
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
      {error && (
        <p className="memo-composer-error" role="alert">
          {error}
        </p>
      )}
      {menu}
    </div>
  );
});
