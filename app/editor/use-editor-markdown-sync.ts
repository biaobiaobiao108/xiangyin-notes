import { useCallback, useRef, type MutableRefObject } from "react";
import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

type EditorWithMarkdown = Editor & { getMarkdown: () => string };

const EDITOR_SYNC_DEBOUNCE_MS = 180;
const EDITOR_SYNC_MAX_WAIT_MS = 720;

export type UseEditorMarkdownSyncOptions = {
  editorInstanceRef: MutableRefObject<Editor | null>;
  markdownOwnerRef: MutableRefObject<{ noteId: string; reloadToken: number }>;
  onChangeRef: MutableRefObject<(noteId: string, patch: { contentMarkdown?: string }) => void>;
  onMarkdownDirtyChangeRef: MutableRefObject<
    ((noteId: string, isDirty: boolean) => void) | undefined
  >;
};

/** Debounces and flushes TipTap Markdown serialization back to workspace persistence. */
export function useEditorMarkdownSync({
  editorInstanceRef,
  markdownOwnerRef,
  onChangeRef,
  onMarkdownDirtyChangeRef,
}: UseEditorMarkdownSyncOptions) {
  const markdownSyncFrameRef = useRef<number | null>(null);
  const markdownSyncStartedAtRef = useRef<number | null>(null);
  const markdownDirtyRef = useRef(false);
  const serializedMarkdownRef = useRef<{ doc: ProseMirrorNode; markdown: string } | null>(null);

  const clearMarkdownSyncTimer = useCallback(() => {
    if (markdownSyncFrameRef.current !== null) {
      window.clearTimeout(markdownSyncFrameRef.current);
      markdownSyncFrameRef.current = null;
    }
    markdownSyncStartedAtRef.current = null;
  }, []);

  const resetMarkdownDirtyState = useCallback(() => {
    clearMarkdownSyncTimer();
    serializedMarkdownRef.current = null;
    markdownDirtyRef.current = false;
  }, [clearMarkdownSyncTimer]);

  const readDirtyMarkdown = useCallback((instance: Editor) => {
    if (instance.isDestroyed || !markdownDirtyRef.current) return null;
    const doc = instance.state.doc;
    const cached = serializedMarkdownRef.current;
    if (cached?.doc === doc) return cached.markdown;
    const markdown = (instance as EditorWithMarkdown).getMarkdown();
    serializedMarkdownRef.current = { doc, markdown };
    return markdown;
  }, []);

  const flushMarkdownChange = useCallback(
    (source?: Editor) => {
      clearMarkdownSyncTimer();
      const instance = source ?? editorInstanceRef.current;
      const markdown = instance ? readDirtyMarkdown(instance) : null;
      if (markdown === null) return;
      serializedMarkdownRef.current = null;
      markdownDirtyRef.current = false;
      const { noteId } = markdownOwnerRef.current;
      onMarkdownDirtyChangeRef.current?.(noteId, false);
      onChangeRef.current(noteId, { contentMarkdown: markdown });
    },
    [
      clearMarkdownSyncTimer,
      editorInstanceRef,
      markdownOwnerRef,
      onChangeRef,
      onMarkdownDirtyChangeRef,
      readDirtyMarkdown,
    ],
  );

  const scheduleMarkdownChange = useCallback(
    (instance: Editor) => {
      serializedMarkdownRef.current = null;
      const wasDirty = markdownDirtyRef.current;
      markdownDirtyRef.current = true;
      const noteId = markdownOwnerRef.current.noteId;
      if (!wasDirty) onMarkdownDirtyChangeRef.current?.(noteId, true);
      const currentReloadToken = markdownOwnerRef.current.reloadToken;
      const now = performance.now();
      const startedAt = markdownSyncStartedAtRef.current ?? now;
      markdownSyncStartedAtRef.current = startedAt;
      if (markdownSyncFrameRef.current !== null) window.clearTimeout(markdownSyncFrameRef.current);
      const wait = Math.min(
        EDITOR_SYNC_DEBOUNCE_MS,
        Math.max(0, startedAt + EDITOR_SYNC_MAX_WAIT_MS - now),
      );
      markdownSyncFrameRef.current = window.setTimeout(() => {
        markdownSyncFrameRef.current = null;
        markdownSyncStartedAtRef.current = null;
        if (instance.isDestroyed || !markdownDirtyRef.current) return;
        if (
          noteId !== markdownOwnerRef.current.noteId ||
          currentReloadToken !== markdownOwnerRef.current.reloadToken
        ) {
          serializedMarkdownRef.current = null;
          markdownDirtyRef.current = false;
          onMarkdownDirtyChangeRef.current?.(noteId, false);
          return;
        }
        flushMarkdownChange(instance);
      }, wait);
    },
    [flushMarkdownChange, markdownOwnerRef, onMarkdownDirtyChangeRef],
  );

  return {
    readDirtyMarkdown,
    flushMarkdownChange,
    scheduleMarkdownChange,
    clearMarkdownSyncTimer,
    resetMarkdownDirtyState,
  };
}
