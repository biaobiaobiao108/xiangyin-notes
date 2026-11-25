import { useCallback, useRef, type MutableRefObject } from "react";
import type { Note } from "../../shared/types";
import type { useNoteSaveQueue } from "./use-note-save-queue";

type PersistFn = ReturnType<typeof useNoteSaveQueue>["persist"];

type UseWorkspaceEditorDraftsOptions = {
  selectedRef: MutableRefObject<Note | null>;
  splitSelectedRef: MutableRefObject<Note | null>;
  splitMarkdownReaderRef: MutableRefObject<((noteId: string) => string | null) | null>;
  trashOperationsRef: MutableRefObject<Set<string>>;
  persistRef: MutableRefObject<PersistFn>;
};

/**
 * 维护主编辑器与分屏编辑器的未落盘 Markdown 读取桥接，并在切篇/操作前统一刷出草稿。
 */
export function useWorkspaceEditorDrafts({
  selectedRef,
  splitSelectedRef,
  splitMarkdownReaderRef,
  trashOperationsRef,
  persistRef,
}: UseWorkspaceEditorDraftsOptions) {
  const editorMarkdownReaderRef = useRef<((noteId: string) => string | null) | null>(null);
  const editorMarkdownDirtyNoteRef = useRef<string | null>(null);
  const flushEditorDraftRef = useRef<() => void>(() => undefined);

  const registerEditorMarkdownReader = useCallback(
    (reader: ((noteId: string) => string | null) | null) => {
      editorMarkdownReaderRef.current = reader;
    },
    [],
  );

  const registerEditorMarkdownDirty = useCallback((noteId: string, isDirty: boolean) => {
    if (isDirty) editorMarkdownDirtyNoteRef.current = noteId;
    else if (editorMarkdownDirtyNoteRef.current === noteId)
      editorMarkdownDirtyNoteRef.current = null;
  }, []);

  const flushActiveEditorDraft = useCallback(() => {
    const current = selectedRef.current;
    if (current && !trashOperationsRef.current.has(current.id)) {
      const markdown = editorMarkdownReaderRef.current?.(current.id);
      if (markdown != null && markdown !== current.contentMarkdown) {
        const next = { ...current, contentMarkdown: markdown };
        selectedRef.current = next;
        persistRef.current(next, ["contentMarkdown"]);
      }
    }
    const split = splitSelectedRef.current;
    if (split && !trashOperationsRef.current.has(split.id)) {
      const markdown = splitMarkdownReaderRef.current?.(split.id);
      if (markdown != null && markdown !== split.contentMarkdown) {
        const next = { ...split, contentMarkdown: markdown };
        splitSelectedRef.current = next;
        persistRef.current(next, ["contentMarkdown"]);
      }
    }
  }, [persistRef, selectedRef, splitMarkdownReaderRef, splitSelectedRef, trashOperationsRef]);

  flushEditorDraftRef.current = flushActiveEditorDraft;

  return {
    editorMarkdownReaderRef,
    editorMarkdownDirtyNoteRef,
    flushEditorDraftRef,
    registerEditorMarkdownReader,
    registerEditorMarkdownDirty,
    flushActiveEditorDraft,
  };
}
