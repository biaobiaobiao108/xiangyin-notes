import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
} from "react";
import type { Editor, JSONContent } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import type { Note } from "../../shared/types";
import { api } from "../api";
import { playEntranceAnimation } from "../animation";
import { countEditorText, type EditorStats, type OutlineItem } from "../editor-metrics";
import { replaceEditorMarkdown } from "./document-content";
import { prepareMarkdownForEditor } from "./prepare-markdown";
import { findTaskPosition, taskNavigationPluginKey } from "./task-navigation";

function resizeTitleField(field: HTMLTextAreaElement | null) {
  if (!field) return;
  field.style.height = "auto";
  field.style.height = `${field.scrollHeight}px`;
}

type UseEditorNoteLifecycleOptions = {
  editor: Editor | null;
  note: Note;
  contentMarkdown: string;
  reloadToken: number;
  isLoading: boolean;
  bodyEditable: boolean;
  editorLocked: boolean;
  focusRequested: boolean;
  isMobileViewport: boolean;
  deferredImages?: readonly JSONContent[];
  taskNavigation: { noteId: string; ordinal: number; text: string; token: number } | null;
  onFocusHandled?: () => void;
  onTaskNavigationMissing?: () => void;
  onCloseOutline: () => void;
  onOutlineItemsChange: (items: OutlineItem[]) => void;
  onOutlineActiveChange: (id: string | null) => void;
  onOutlineNavigationReady: (navigate: ((id: string) => void) | null) => void;
  onMarkdownReaderChange?: (reader: ((noteId: string) => string | null) | null) => void;
  onMarkdownDirtyChangeRef: MutableRefObject<
    ((noteId: string, isDirty: boolean) => void) | undefined
  >;
  insertDeferredImages: (noteId: string, insert: (images: JSONContent[]) => boolean) => void;
  readDirtyMarkdown: (instance: Editor) => string | null;
  flushMarkdownChange: (instance?: Editor) => void;
  clearMarkdownSyncTimer: () => void;
  resetMarkdownDirtyState: () => void;
  scheduleEditorSurfaceSync: (
    instance: Editor,
    outlineMayHaveChanged?: boolean,
    transaction?: Transaction,
  ) => void;
  syncSearchNavigation: (instance: Editor) => void;
  syncActiveOutlineFromSelection: (instance: Editor) => boolean;
  cancelOutlineSmoothScroll: () => void;
  setEditorStats: Dispatch<SetStateAction<EditorStats>>;
  editorInstanceRef: MutableRefObject<Editor | null>;
  editorScrollRef: RefObject<HTMLDivElement | null>;
  documentRef: RefObject<HTMLDivElement | null>;
  titleInputRef: RefObject<HTMLTextAreaElement | null>;
  initialContentRef: MutableRefObject<string | null>;
  activeEditorNoteIdRef: MutableRefObject<string>;
  syncFrameRef: MutableRefObject<number | null>;
  syncStartedAtRef: MutableRefObject<number | null>;
  syncOutlineDirtyRef: MutableRefObject<boolean>;
  imeCleanupTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  leakedCandidateRef: MutableRefObject<{
    key: string;
    blockStartPos: number;
    emptyAtStart: boolean;
  } | null>;
  composingRef: MutableRefObject<boolean>;
  outlineHeadingElementsRef: MutableRefObject<Map<string, HTMLElement>>;
  outlineSelectionSynchronizedRef: MutableRefObject<boolean>;
  outlineFallbackSyncRef: MutableRefObject<(() => void) | null>;
  typewriterModeRef: MutableRefObject<boolean>;
  alignTypewriterRef: MutableRefObject<(instance: Editor) => void>;
  markdownOwnerRef: MutableRefObject<{ noteId: string; reloadToken: number }>;
};

/**
 * 管理笔记编辑器与当前笔记之间的生命周期同步：切篇重载、标题自适应、
 * 反向链接计数、任务定位高亮、延迟图片补插以及选区/事务监听。
 */
export function useEditorNoteLifecycle({
  editor,
  note,
  contentMarkdown,
  reloadToken,
  isLoading,
  bodyEditable,
  editorLocked,
  focusRequested,
  isMobileViewport,
  deferredImages,
  taskNavigation,
  onFocusHandled,
  onTaskNavigationMissing,
  onCloseOutline,
  onOutlineItemsChange,
  onOutlineActiveChange,
  onOutlineNavigationReady,
  onMarkdownReaderChange,
  onMarkdownDirtyChangeRef,
  insertDeferredImages,
  readDirtyMarkdown,
  flushMarkdownChange,
  clearMarkdownSyncTimer,
  resetMarkdownDirtyState,
  scheduleEditorSurfaceSync,
  syncSearchNavigation,
  syncActiveOutlineFromSelection,
  cancelOutlineSmoothScroll,
  setEditorStats,
  editorInstanceRef,
  editorScrollRef,
  documentRef,
  titleInputRef,
  initialContentRef,
  activeEditorNoteIdRef,
  syncFrameRef,
  syncStartedAtRef,
  syncOutlineDirtyRef,
  imeCleanupTimerRef,
  leakedCandidateRef,
  composingRef,
  outlineHeadingElementsRef,
  outlineSelectionSynchronizedRef,
  outlineFallbackSyncRef,
  typewriterModeRef,
  alignTypewriterRef,
  markdownOwnerRef,
}: UseEditorNoteLifecycleOptions) {
  const [backlinkCount, setBacklinkCount] = useState(0);
  const [deferredLoading, setDeferredLoading] = useState(false);
  const scheduleEditorSurfaceSyncRef = useRef(scheduleEditorSurfaceSync);
  scheduleEditorSurfaceSyncRef.current = scheduleEditorSurfaceSync;

  useLayoutEffect(() => {
    resizeTitleField(titleInputRef.current);
  }, [note.id, note.title, titleInputRef]);

  useEffect(() => {
    const field = titleInputRef.current;
    if (!field) return;
    let width: number | undefined;
    const observer = new ResizeObserver((entries) => {
      const nextWidth = entries[0]?.contentRect.width;
      if (nextWidth === undefined || nextWidth === width) return;
      width = nextWidth;
      resizeTitleField(field);
    });
    observer.observe(field);
    return () => observer.disconnect();
  }, [note.id, titleInputRef]);

  useEffect(() => {
    if (note.deletedAt || !note.id) {
      setBacklinkCount(0);
      return;
    }
    let active = true;
    const controller = new AbortController();
    setBacklinkCount(0);
    void api
      .getBacklinks(note.id, { signal: controller.signal })
      .then((response) => {
        if (active)
          setBacklinkCount(response.linkedReferences.length + response.unlinkedMentions.length);
      })
      .catch((reason) => {
        if (reason instanceof Error && reason.name === "AbortError") return;
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [note.id, note.deletedAt]);

  useEffect(() => {
    editorInstanceRef.current = editor;
    return () => {
      if (editorInstanceRef.current === editor) editorInstanceRef.current = null;
    };
  }, [editor, editorInstanceRef]);

  useEffect(() => {
    if (!editor) return;
    onMarkdownReaderChange?.((noteId) =>
      noteId === markdownOwnerRef.current.noteId ? readDirtyMarkdown(editor) : null,
    );
    return () => onMarkdownReaderChange?.(null);
  }, [editor, markdownOwnerRef, onMarkdownReaderChange, readDirtyMarkdown]);

  useEffect(() => {
    if (!editor) return;
    const handleTransaction = ({ editor: instance }: { editor: Editor }) => {
      syncSearchNavigation(instance);
    };
    const handleSelection = ({ editor: instance }: { editor: Editor }) => {
      const selectionSynchronized = syncActiveOutlineFromSelection(instance);
      outlineSelectionSynchronizedRef.current = selectionSynchronized;
      if (!selectionSynchronized) {
        outlineFallbackSyncRef.current?.();
      }
      if (typewriterModeRef.current) {
        alignTypewriterRef.current(instance);
      }
    };
    editor.on("transaction", handleTransaction);
    editor.on("selectionUpdate", handleSelection);
    syncSearchNavigation(editor);
    return () => {
      editor.off("transaction", handleTransaction);
      editor.off("selectionUpdate", handleSelection);
    };
  }, [
    alignTypewriterRef,
    editor,
    outlineFallbackSyncRef,
    outlineSelectionSynchronizedRef,
    syncActiveOutlineFromSelection,
    syncSearchNavigation,
    typewriterModeRef,
  ]);

  useEffect(() => {
    if (!editor) return;
    scheduleEditorSurfaceSyncRef.current(editor);
    return () => {
      if (syncFrameRef.current !== null) {
        window.clearTimeout(syncFrameRef.current);
      }
      syncFrameRef.current = null;
      syncStartedAtRef.current = null;
      syncOutlineDirtyRef.current = false;
      clearMarkdownSyncTimer();
      if (imeCleanupTimerRef.current !== null) clearTimeout(imeCleanupTimerRef.current);
      imeCleanupTimerRef.current = null;
      leakedCandidateRef.current = null;
      composingRef.current = false;
      outlineHeadingElementsRef.current.clear();
    };
  }, [clearMarkdownSyncTimer, editor]);

  useEffect(() => {
    if (!isLoading) {
      setDeferredLoading(false);
      return;
    }
    const timer = setTimeout(() => {
      setDeferredLoading(true);
    }, 150);
    return () => clearTimeout(timer);
  }, [isLoading]);

  useEffect(() => {
    if (editor && editor.isEditable !== bodyEditable) editor.setEditable(bodyEditable, false);
  }, [editor, bodyEditable]);

  const appliedReloadTokenRef = useRef(reloadToken);
  useEffect(() => {
    if (!editor) return;
    const switchedNote = activeEditorNoteIdRef.current !== note.id;
    if (!switchedNote && appliedReloadTokenRef.current === reloadToken) return;
    let enteringAnimation: Animation | null = null;
    onMarkdownDirtyChangeRef.current?.(activeEditorNoteIdRef.current, false);
    appliedReloadTokenRef.current = reloadToken;
    activeEditorNoteIdRef.current = note.id;
    onMarkdownDirtyChangeRef.current?.(note.id, false);
    if (imeCleanupTimerRef.current !== null) clearTimeout(imeCleanupTimerRef.current);
    imeCleanupTimerRef.current = null;
    leakedCandidateRef.current = null;
    composingRef.current = false;
    cancelOutlineSmoothScroll();
    onCloseOutline();
    onOutlineItemsChange([]);
    onOutlineActiveChange(null);
    onOutlineNavigationReady(null);
    outlineHeadingElementsRef.current.clear();
    outlineSelectionSynchronizedRef.current = false;
    setEditorStats(countEditorText(""));
    resetMarkdownDirtyState();
    initialContentRef.current = prepareMarkdownForEditor(contentMarkdown);
    replaceEditorMarkdown(editor, initialContentRef.current);
    editorScrollRef.current?.scrollTo({ top: 0, behavior: "auto" });
    if (switchedNote) {
      const doc = documentRef.current;
      if (doc && !doc.closest(".app-shell.layout-cards"))
        enteringAnimation = playEntranceAnimation(doc, "note-fade-in");
    }
    scheduleEditorSurfaceSyncRef.current(editor);
    return () => {
      onMarkdownDirtyChangeRef.current?.(note.id, false);
      enteringAnimation?.cancel();
    };
  }, [
    cancelOutlineSmoothScroll,
    contentMarkdown,
    editor,
    note.id,
    onCloseOutline,
    onOutlineActiveChange,
    onOutlineItemsChange,
    onOutlineNavigationReady,
    reloadToken,
  ]);

  useEffect(() => {
    if (!editor || editorLocked || note.deletedAt || !deferredImages?.length) return;
    // Tiptap mounts React node views synchronously when inserting images.
    const timer = setTimeout(() => {
      if (editor.isDestroyed) return;
      insertDeferredImages(note.id, (images) => {
        if (
          !editor.commands.insertContentAt(editor.state.doc.content.size, images, {
            updateSelection: false,
          })
        ) {
          return false;
        }
        flushMarkdownChange(editor);
        return true;
      });
    });
    return () => clearTimeout(timer);
  }, [
    deferredImages,
    editor,
    editorLocked,
    flushMarkdownChange,
    insertDeferredImages,
    note.deletedAt,
    note.id,
  ]);

  useEffect(() => {
    if (!editor || !focusRequested || isLoading || note.deletedAt) return;
    if (isMobileViewport) {
      onFocusHandled?.();
      return;
    }
    // Apply focus after the new note's content and editable state are ready.
    if (editor.commands.focus("start")) onFocusHandled?.();
  }, [
    editor,
    focusRequested,
    isLoading,
    isMobileViewport,
    note.id,
    note.deletedAt,
    onFocusHandled,
  ]);

  useEffect(() => {
    if (!editor || isLoading || !taskNavigation || taskNavigation.noteId !== note.id) return;
    const position = findTaskPosition(
      editor.state.doc,
      taskNavigation.ordinal,
      taskNavigation.text,
    );
    if (position === null) {
      onTaskNavigationMissing?.();
      return;
    }
    editor.view.dispatch(editor.state.tr.setMeta(taskNavigationPluginKey, position));
    const frame = requestAnimationFrame(() => {
      if (editor.isDestroyed) return;
      const node = editor.view.nodeDOM(position);
      if (!(node instanceof HTMLElement)) return;
      const behavior: ScrollBehavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth";
      node.scrollIntoView({ behavior, block: "center", inline: "nearest" });
    });
    const clearHighlight = () => {
      if (!editor.isDestroyed)
        editor.view.dispatch(editor.state.tr.setMeta(taskNavigationPluginKey, null));
    };
    const fadeTimer = window.setTimeout(() => {
      if (editor.isDestroyed) return;
      editor.view.dispatch(editor.state.tr.setMeta(taskNavigationPluginKey, { type: "fade" }));
    }, 3600);
    const clearTimer = window.setTimeout(clearHighlight, 3900);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(fadeTimer);
      window.clearTimeout(clearTimer);
      clearHighlight();
    };
  }, [editor, isLoading, note.id, onTaskNavigationMissing, taskNavigation]);

  useEffect(() => {
    if (isLoading) onCloseOutline();
  }, [isLoading, onCloseOutline]);

  return { backlinkCount, setBacklinkCount, deferredLoading };
}
