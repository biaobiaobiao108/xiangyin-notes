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
} from "react";
import { createCommonEditorExtensions } from "../editor/common-extensions";
import { editorCoreExtensionOptions } from "../editor/editor-config";

type EditorWithMarkdown = Editor & { getMarkdown: () => string };

export type MemoComposerHandle = {
  focus: () => void;
  clear: () => void;
  getMarkdown: () => string;
};

export type MemoComposerProps = {
  initialMarkdown?: string;
  placeholder: string;
  ariaLabel: string;
  autoFocus?: boolean;
  className?: string;
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
    onDraftChange,
    onSubmit,
    onCancel,
  },
  ref,
) {
  const editorRef = useRef<EditorWithMarkdown | null>(null);
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingDraftRef = useRef<string | null>(null);
  const onSubmitRef = useRef(onSubmit);
  const onDraftChangeRef = useRef(onDraftChange);
  const onCancelRef = useRef(onCancel);
  const savingRef = useRef(false);
  const [empty, setEmpty] = useState(!initialMarkdown.trim());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  onSubmitRef.current = onSubmit;
  onDraftChangeRef.current = onDraftChange;
  onCancelRef.current = onCancel;

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
      const nextEmpty = !instance.getText().trim();
      setEmpty((previous) => (previous === nextEmpty ? previous : nextEmpty));
      if (error) setError("");
      queueDraft(markdown);
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

  const clear = useCallback(() => {
    const instance = editorRef.current;
    if (!instance || instance.isDestroyed) return;
    if (draftTimerRef.current) {
      clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
    pendingDraftRef.current = null;
    instance.commands.clearContent(false);
    setEmpty(true);
    setError("");
    onDraftChangeRef.current?.("");
    instance.commands.focus("start");
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => editorRef.current?.commands.focus("end"),
      clear,
      getMarkdown: () => editorRef.current?.getMarkdown() ?? "",
    }),
    [clear],
  );

  const submit = useCallback(async () => {
    const instance = editorRef.current;
    if (!instance || instance.isDestroyed || savingRef.current) return;
    const markdown = instance.getMarkdown();
    if (!markdown.trim()) {
      instance.commands.focus("end");
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError("");
    try {
      await onSubmitRef.current(markdown);
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, []);

  return (
    <div
      className={`memo-composer ${className}`.trim()}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
          event.preventDefault();
          void submit();
        } else if (event.key === "Escape" && onCancelRef.current) {
          event.preventDefault();
          onCancelRef.current();
        }
      }}
    >
      <EditorContent editor={editor} />
      {(!empty || saving || error) && (
        <div className="memo-composer-actions">
          {error && (
            <span className="memo-composer-error" role="alert">
              {error}
            </span>
          )}
          <div className="memo-composer-buttons">
            {onCancel && (
              <button
                className="memo-text-button"
                type="button"
                onClick={onCancel}
                disabled={saving}
              >
                取消
              </button>
            )}
            <button
              className="memo-save-button"
              type="button"
              onClick={() => void submit()}
              disabled={saving || empty}
              aria-keyshortcuts="Control+Enter Meta+Enter"
            >
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
});
