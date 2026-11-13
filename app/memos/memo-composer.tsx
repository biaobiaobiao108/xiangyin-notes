import type { Editor } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createCommonEditorExtensions } from "../editor/common-extensions";
import { editorCoreExtensionOptions } from "../editor/editor-config";

type EditorWithMarkdown = Editor & { getMarkdown: () => string };
type SubmitReason = "shortcut" | "blur";

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

export function MemoComposer({
  initialMarkdown = "",
  placeholder,
  ariaLabel,
  autoFocus = false,
  className = "",
  resetOnSubmit = false,
  onDraftChange,
  onSubmit,
  onCancel,
}: MemoComposerProps) {
  const editorRef = useRef<EditorWithMarkdown | null>(null);
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

  const extensions = useMemo(() => createCommonEditorExtensions({ placeholder }), [placeholder]);
  const editorProps = useMemo(
    () => ({
      attributes: {
        class: "memo-composer-prose note-prose",
        "aria-label": ariaLabel,
      },
    }),
    [ariaLabel],
  );

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
      setError("");
      try {
        await onSubmitRef.current(markdown);
        if (resetOnSubmitRef.current) {
          clearDraft(instance);
          if (reason === "shortcut") instance.commands.focus("end");
        }
      } catch (reason) {
        setError(messageOf(reason));
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [clearDraft],
  );

  const cancel = useCallback(() => {
    if (!onCancelRef.current || savingRef.current) return;
    closingRef.current = true;
    onCancelRef.current();
  }, []);

  const editor = useEditor({
    extensions,
    coreExtensionOptions: editorCoreExtensionOptions,
    content: initialMarkdown,
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
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
          event.preventDefault();
          void submit("shortcut");
        } else if (event.key === "Escape" && onCancelRef.current) {
          event.preventDefault();
          cancel();
        }
      }}
    >
      <EditorContent editor={editor} />
      {error && (
        <p className="memo-composer-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
