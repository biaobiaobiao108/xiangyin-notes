import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { CircleAlert, ImageDown, Star, Trash2, Undo2, X } from "lucide-react";
import { type ImageAssetSummary, type Note, type NoteSummary } from "../shared/types";
import { api } from "./api";
import { BrandMark } from "./brand-mark";
import { SearchHighlightExtension } from "./editor-search";
import {
  countEditorText,
  getOutlineStructureKey,
  type EditorStats,
  type OutlineItem,
} from "./editor-metrics";
import { type EditorTextBlockStatsCache, type EditorTextStatsSnapshot } from "./editor-text-stats";
import { EditorHeader, type EditorSaveState as SaveState } from "./editor/editor-header";
import { transactionMayChangeOutline } from "./editor/outline-change";
import { scrollNoteNavigation } from "./editor/document-navigation";
import { replaceEditorMarkdown } from "./editor/document-content";
import {
  findTaskPosition,
  TaskNavigationExtension,
  taskNavigationPluginKey,
} from "./editor/task-navigation";
import { FloatingScrollbar } from "./floating-scrollbar";
import { editorCoreExtensionOptions } from "./editor/editor-config";
import { createCommonEditorExtensions } from "./editor/common-extensions";
import { EditorFloatingTools } from "./editor/editor-panels";
import { ImageNode } from "./editor/image-node";
import { ImageUploadPositions } from "./editor/image-upload-position";
import { BacklinksDialog } from "./editor/backlinks-panel";
import { WikiLinkNode } from "./editor/wiki-link-node";
import {
  WikiLinkSuggestionExtension,
  type WikiLinkTitleSearch,
} from "./editor/wiki-link-suggestion";
import { CalloutNode } from "./editor/callout-node";
import { SlashCommandExtension } from "./editor/slash-command-menu";
import { TableScrollbars } from "./editor/table-scrollbars";
import { playEntranceAnimation } from "./animation";
import { CardOutline } from "./editor/card-outline";
import { MobileEditorFooter, MobileEditorOutline } from "./editor/mobile-editor-controls";
import { useMobileCaret } from "./editor/use-mobile-caret";
import { useEditorCaretScroll } from "./editor/use-editor-caret-scroll";
import {
  getOutlineHeadingElements,
  useEditorOutlineNavigation,
} from "./editor/use-editor-outline-navigation";
import { useEditorSurfaceSync } from "./editor/use-editor-surface-sync";
import { useEditorProps } from "./editor/use-editor-props";
import { prepareMarkdownForEditor } from "./editor/prepare-markdown";
import { BlockDragHandle } from "./editor/block-drag-handle";
import { useEditorContextMenu } from "./editor/use-editor-context-menu";
import { NoteAnnotation, NoteHighlight } from "./editor/highlight-annotation";
import { useEditorAnnotations } from "./editor/annotation-overlay";
import { useScrollEdges } from "./workspace/use-scroll-edges";
import { AutoReadingHUD } from "./editor/auto-reading-hud";
import { useEditorSearch } from "./editor/use-editor-search";
import { useEditorImageUpload } from "./editor/use-editor-image-upload";
import "./editor/mobile-editor.css";

type EditorWithMarkdown = Editor & { getMarkdown: () => string };

const OUTLINE_HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6";
const EDITOR_SYNC_DEBOUNCE_MS = 180;
const EDITOR_SYNC_MAX_WAIT_MS = 720;

function resizeTitleField(field: HTMLTextAreaElement | null) {
  if (!field) return;
  field.style.height = "auto";
  field.style.height = `${field.scrollHeight}px`;
}

export function NoteEditor({
  note,
  contentMarkdown = note.contentMarkdown,
  searchQuery = "",
  searchNavigationToken = 0,
  replaceRequest = null,
  onReplaceRequestHandled,
  taskNavigation = null,
  onTaskNavigationMissing,
  saveState,
  isLoading = false,
  loadingLabel = "正在打开笔记…",
  reloadToken = 0,
  focusRequested = false,
  trashBusy = false,
  onFocusHandled,
  onChange,
  onSaveNow,
  onReloadNote,
  onExportImage,
  onToggleFavorite,
  onMoveToTrash,
  onRestore,
  onPermanentDelete,
  onOpenList,
  onBackToCards,
  onBackToKanban,
  onUploadImage,
  isMobileViewport = false,
  mobileBackLabel = "笔记列表",
  focusMode = false,
  onClearSearch,
  autoReadingMode = false,
  onToggleAutoReadingMode,
  onExitAutoReadingMode,
  typewriterMode = false,
  outlineOpen,
  outlineItems,
  activeOutlineId,
  onToggleOutline,
  onCloseOutline,
  onOutlineItemsChange,
  onOutlineActiveChange,
  onOutlineNavigationReady,
  availableNotes = [],
  onNavigateWikiLink,
  onCreateAndLinkNote,
  onSearchWikiLinkTitles,
  onNavigateToNote,
  onMarkdownReaderChange,
  onMarkdownDirtyChange,
  onToggleSplit,
  isSplitActive = false,
  onCloseSplit,
  isActivePane,
  onActivatePane,
}: {
  note: Note;
  contentMarkdown?: string;
  searchQuery?: string;
  searchNavigationToken?: number;
  replaceRequest?: { noteId: string; token: number; query: string } | null;
  onReplaceRequestHandled?: (token: number) => void;
  taskNavigation?: { noteId: string; ordinal: number; text: string; token: number } | null;
  onTaskNavigationMissing?: () => void;
  saveState: SaveState;
  isLoading?: boolean;
  loadingLabel?: string;
  reloadToken?: number;
  focusRequested?: boolean;
  trashBusy?: boolean;
  onFocusHandled?: () => void;
  onChange: (noteId: string, patch: { title?: string; contentMarkdown?: string }) => void;
  onSaveNow: () => void;
  onReloadNote: () => void;
  onExportImage: () => void;
  onToggleFavorite: () => void;
  onMoveToTrash: () => void;
  onRestore: () => void;
  onPermanentDelete?: () => void;
  onOpenList?: () => void;
  onBackToCards?: () => void;
  onBackToKanban?: () => void;
  onUploadImage?: (
    file: File,
    dimensions: { width: number; height: number },
  ) => Promise<{ asset: ImageAssetSummary }>;
  isMobileViewport?: boolean;
  mobileBackLabel?: string;
  focusMode?: boolean;
  autoReadingMode?: boolean;
  onToggleAutoReadingMode?: () => void;
  onExitAutoReadingMode?: () => void;
  onClearSearch?: () => void;
  typewriterMode?: boolean;
  outlineOpen: boolean;
  outlineItems: OutlineItem[];
  activeOutlineId?: string | null;
  onToggleOutline: () => void;
  onCloseOutline: () => void;
  onOutlineItemsChange: (items: OutlineItem[]) => void;
  onOutlineActiveChange: (id: string | null) => void;
  onOutlineNavigationReady: (navigate: ((id: string) => void) | null) => void;
  availableNotes?: NoteSummary[];
  onNavigateWikiLink?: (targetTitle: string) => void;
  onCreateAndLinkNote?: (title: string) => void;
  onSearchWikiLinkTitles?: WikiLinkTitleSearch;
  onNavigateToNote?: (id: string) => void;
  onMarkdownReaderChange?: (reader: ((noteId: string) => string | null) | null) => void;
  onMarkdownDirtyChange?: (noteId: string, isDirty: boolean) => void;
  onToggleSplit?: () => void;
  isSplitActive?: boolean;
  onCloseSplit?: () => void;
  isActivePane?: boolean;
  onActivatePane?: () => void;
}) {
  const editorScrollRef = useRef<HTMLDivElement>(null);
  const mobileViewportRef = useRef(isMobileViewport);
  mobileViewportRef.current = isMobileViewport;
  const mobileCaretScrollRef = useRef<() => void>(() => undefined);
  const documentRef = useRef<HTMLDivElement>(null);
  const titleInputRef = useRef<HTMLTextAreaElement>(null);
  const editorInstanceRef = useRef<Editor | null>(null);
  const outlineTriggerRef = useRef<HTMLButtonElement>(null);
  const syncFrameRef = useRef<number | null>(null);
  const syncStartedAtRef = useRef<number | null>(null);
  const syncOutlineDirtyRef = useRef(false);
  const markdownSyncFrameRef = useRef<number | null>(null);
  const markdownSyncStartedAtRef = useRef<number | null>(null);
  const markdownDirtyRef = useRef(false);
  const serializedMarkdownRef = useRef<{ doc: ProseMirrorNode; markdown: string } | null>(null);
  const editorTextBlockStatsRef = useRef<EditorTextBlockStatsCache>(
    new WeakMap<ProseMirrorNode, EditorStats>(),
  );
  const markdownOwnerRef = useRef({ noteId: note.id, reloadToken });
  const composingRef = useRef(false);
  const leakedCandidateRef = useRef<{
    key: string;
    blockStartPos: number;
    emptyAtStart: boolean;
  } | null>(null);
  const imeCleanupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeEditorNoteIdRef = useRef(note.id);
  const initialContentRef = useRef<string | null>(null);
  if (initialContentRef.current === null) {
    initialContentRef.current = prepareMarkdownForEditor(contentMarkdown);
  }

  const isPastingRef = useRef(false);
  const smoothScrollToHeadRef = useRef<(view: Editor["view"]) => void>(() => undefined);
  const outlineScrollAnimRef = useRef<number | null>(null);
  const programmaticOutlineScrollIdRef = useRef<string | null>(null);
  const cancelOutlineSmoothScroll = useCallback(() => {
    if (outlineScrollAnimRef.current !== null) {
      cancelAnimationFrame(outlineScrollAnimRef.current);
      outlineScrollAnimRef.current = null;
    }
    programmaticOutlineScrollIdRef.current = null;
  }, []);
  const onChangeRef = useRef(onChange);
  const onMarkdownDirtyChangeRef = useRef(onMarkdownDirtyChange);
  const surfaceSyncRef = useRef<
    (instance: Editor, outlineMayHaveChanged?: boolean, transaction?: Transaction) => void
  >(() => undefined);
  const [editorStats, setEditorStats] = useState<EditorStats>(() => countEditorText(""));
  const editorScrollEdges = useScrollEdges(editorScrollRef, [
    note.id,
    note.updatedAt,
    editorStats.characterCount,
  ]);
  const editorTextStatsSnapshotRef = useRef<EditorTextStatsSnapshot | null>(null);
  const [deferredLoading, setDeferredLoading] = useState(false);
  const loadingLocked = isLoading || deferredLoading;
  const bodyEditable = !note.deletedAt && !trashBusy && !autoReadingMode;
  const editorLocked = loadingLocked || trashBusy || autoReadingMode;
  const {
    imageFileInputRef,
    imageUploadMessageRef,
    imageUploadMessageId,
    uploadImageFilesRef,
    imageUploadState,
    imageUploadMessage,
    clearImageUploadMessage,
  } = useEditorImageUpload({
    editorInstanceRef,
    noteId: note.id,
    reloadToken,
    deleted: Boolean(note.deletedAt),
    locked: editorLocked,
    onUploadImage,
  });
  const typewriterModeRef = useRef(typewriterMode);
  const typewriterAnimRef = useRef<number | null>(null);
  const typewriterTargetRef = useRef<number | null>(null);
  const outlineFallbackSyncRef = useRef<(() => void) | null>(null);
  const outlineHeadingElementsRef = useRef(new Map<string, HTMLElement>());
  const outlineItemsRef = useRef(outlineItems);
  const outlineSelectionSynchronizedRef = useRef(false);
  const outlineStructureKey = getOutlineStructureKey(outlineItems);

  useLayoutEffect(() => {
    resizeTitleField(titleInputRef.current);
  }, [note.id, note.title]);

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
  }, [note.id]);

  const availableNotesRef = useRef(availableNotes);
  const onNavigateWikiLinkRef = useRef(onNavigateWikiLink);
  const onCreateAndLinkNoteRef = useRef(onCreateAndLinkNote);
  const onSearchWikiLinkTitlesRef = useRef(onSearchWikiLinkTitles);
  const onToggleAnnotationRef = useRef<(id: string) => void>(() => undefined);
  const onClearAnnotationRef = useRef<() => void>(() => undefined);

  // 最新值与回调统一在 effect 中写入 ref，避免渲染阶段直接赋值在并发渲染下产生非幂等副作用。
  useEffect(() => {
    markdownOwnerRef.current.noteId = note.id;
    markdownOwnerRef.current.reloadToken = reloadToken;
    onChangeRef.current = onChange;
    onMarkdownDirtyChangeRef.current = onMarkdownDirtyChange;
    typewriterModeRef.current = typewriterMode;
    outlineItemsRef.current = outlineItems;
    availableNotesRef.current = availableNotes;
    onNavigateWikiLinkRef.current = onNavigateWikiLink;
    onCreateAndLinkNoteRef.current = onCreateAndLinkNote;
    onSearchWikiLinkTitlesRef.current = onSearchWikiLinkTitles;
  });

  const [backlinkCount, setBacklinkCount] = useState(0);
  const [backlinksOpen, setBacklinksOpen] = useState(false);

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

  const scheduleEditorSurfaceSync = useEditorSurfaceSync({
    editorTextStatsSnapshotRef,
    editorTextBlockStatsRef,
    setEditorStats,
    outlineHeadingElementsRef,
    onOutlineItemsChange,
    syncOutlineDirtyRef,
    syncFrameRef,
    syncStartedAtRef,
    composingRef,
  });

  const extensions = useMemo(
    () => [
      ...createCommonEditorExtensions({ placeholder: "从一句话开始……" }),
      NoteHighlight,
      NoteAnnotation,
      TaskNavigationExtension,
      CalloutNode,
      ImageNode,
      ImageUploadPositions,
      WikiLinkNode,
      SlashCommandExtension.configure({ onPickImage: () => imageFileInputRef.current?.click() }),
      WikiLinkSuggestionExtension.configure({
        getNotes: () => availableNotesRef.current,
        searchTitles: (query, signal) =>
          onSearchWikiLinkTitlesRef.current?.(query, signal) ??
          Promise.resolve({ matches: [], exactMatch: false }),
        onCreateNote: (title) => onCreateAndLinkNoteRef.current?.(title),
      }),
      SearchHighlightExtension,
    ],
    [],
  );

  const { smoothScrollToHead, alignTypewriter } = useEditorCaretScroll({
    mobileViewportRef,
    mobileCaretScrollRef,
    editorScrollRef,
    typewriterModeRef,
    typewriterAnimRef,
    typewriterTargetRef,
  });
  smoothScrollToHeadRef.current = smoothScrollToHead;
  const alignTypewriterRef = useRef(alignTypewriter);
  alignTypewriterRef.current = alignTypewriter;

  const editorProps = useEditorProps({
    mobileViewportRef,
    onNavigateWikiLinkRef,
    onToggleAnnotationRef,
    onClearAnnotationRef,
    uploadImageFilesRef,
    editorInstanceRef,
    isPastingRef,
    smoothScrollToHeadRef,
    typewriterModeRef,
    alignTypewriterRef,
    mobileCaretScrollRef,
    composingRef,
    leakedCandidateRef,
    imeCleanupTimerRef,
    surfaceSyncRef,
  });
  surfaceSyncRef.current = scheduleEditorSurfaceSync;

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
      if (markdownSyncFrameRef.current !== null) {
        window.clearTimeout(markdownSyncFrameRef.current);
        markdownSyncFrameRef.current = null;
      }
      markdownSyncStartedAtRef.current = null;
      const instance = source ?? editorInstanceRef.current;
      const markdown = instance ? readDirtyMarkdown(instance) : null;
      if (markdown === null) return;
      serializedMarkdownRef.current = null;
      markdownDirtyRef.current = false;
      const { noteId } = markdownOwnerRef.current;
      onMarkdownDirtyChangeRef.current?.(noteId, false);
      onChangeRef.current(noteId, { contentMarkdown: markdown });
    },
    [readDirtyMarkdown],
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
    [flushMarkdownChange],
  );

  const editor = useEditor({
    editable: bodyEditable,
    extensions,
    coreExtensionOptions: editorCoreExtensionOptions,
    content: initialContentRef.current,
    contentType: "markdown",
    editorProps: {
      ...editorProps,
      attributes: { ...editorProps.attributes, "aria-label": "笔记正文" },
    },
    onUpdate: ({ editor: instance, transaction }) => {
      // The trailing-node plugin can append an empty paragraph on a selection-only update.
      if (transaction.docChanged) scheduleMarkdownChange(instance);
      if (typewriterModeRef.current && !instance.view.composing && !composingRef.current) {
        alignTypewriterRef.current(instance);
      }
      if (instance.view.composing || composingRef.current) return;
      surfaceSyncRef.current(instance, transactionMayChangeOutline(transaction), transaction);
    },
  });

  useLayoutEffect(() => {
    if (!editor) return;
    return () => {
      // Dispose before EditorContent clears its node views and redraws the outgoing document.
      try {
        flushMarkdownChange(editor);
      } finally {
        editor.destroy();
      }
    };
  }, [editor, flushMarkdownChange]);

  mobileCaretScrollRef.current = useMobileCaret(
    editor,
    editorScrollRef,
    titleInputRef,
    isMobileViewport,
  );

  const search = useEditorSearch({
    editor,
    noteId: note.id,
    title: note.title,
    searchQuery,
    searchNavigationToken,
    reloadToken,
    replaceRequest,
    onReplaceRequestHandled,
    isLoading,
    editorLocked,
    isMobileViewport,
    editorScrollRef,
    titleInputRef,
    onClearSearch,
  });
  const {
    searchNavigation,
    replaceOpen,
    replaceQuery,
    replacementText,
    setReplaceQuery,
    setReplacementText,
    syncSearchNavigation,
    moveSearchMatch,
    replaceCurrent,
    replaceAll,
    closeReplace,
    toggleReplace,
  } = search;

  const handleSaveNow = useCallback(() => {
    flushMarkdownChange();
    onSaveNow();
  }, [flushMarkdownChange, onSaveNow]);

  const syncActiveOutlineFromSelection = useCallback(
    (instance: Editor) => {
      const root = editorScrollRef.current;
      const items = outlineItemsRef.current;
      if (!root || items.length === 0) return false;

      const { $from } = instance.state.selection;
      let previousHeadingElement: HTMLElement | null = null;
      let previousHeadingIndex = -1;
      for (let depth = $from.depth; depth > 0; depth -= 1) {
        if ($from.node(depth).type.name !== "heading") continue;
        const headingDom = instance.view.nodeDOM($from.before(depth));
        const headingElement =
          headingDom instanceof HTMLElement
            ? headingDom.closest<HTMLElement>(OUTLINE_HEADING_SELECTOR)
            : null;
        if (headingElement?.textContent?.trim()) previousHeadingElement = headingElement;
        break;
      }
      if (!previousHeadingElement) {
        let low = 0;
        let high = items.length - 1;
        try {
          while (low <= high) {
            const middle = Math.floor((low + high) / 2);
            const element = outlineHeadingElementsRef.current.get(items[middle].id);
            if (!element || !root.contains(element)) return false;
            if (instance.view.posAtDOM(element, 0) <= $from.pos) {
              previousHeadingElement = element;
              previousHeadingIndex = middle;
              low = middle + 1;
            } else {
              high = middle - 1;
            }
          }
        } catch {
          return false;
        }
      }
      if (!previousHeadingElement || !root.contains(previousHeadingElement)) return false;
      const item =
        previousHeadingIndex >= 0
          ? items[previousHeadingIndex]
          : (items.find(
              (candidate) =>
                outlineHeadingElementsRef.current.get(candidate.id) === previousHeadingElement,
            ) ?? items[getOutlineHeadingElements(root).indexOf(previousHeadingElement)]);
      if (!item) return false;
      onOutlineActiveChange(item.id);
      return true;
    },
    [onOutlineActiveChange],
  );

  useEffect(() => {
    editorInstanceRef.current = editor;
    return () => {
      if (editorInstanceRef.current === editor) editorInstanceRef.current = null;
    };
  }, [editor]);

  useEffect(() => {
    if (!editor) return;
    onMarkdownReaderChange?.((noteId) =>
      noteId === markdownOwnerRef.current.noteId ? readDirtyMarkdown(editor) : null,
    );
    return () => onMarkdownReaderChange?.(null);
  }, [editor, onMarkdownReaderChange, readDirtyMarkdown]);

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
  }, [editor, syncActiveOutlineFromSelection, syncSearchNavigation]);

  useEffect(() => {
    if (typewriterMode && editorInstanceRef.current?.view.hasFocus()) {
      alignTypewriterRef.current(editorInstanceRef.current);
    } else if (!typewriterMode) {
      if (typewriterAnimRef.current !== null) {
        cancelAnimationFrame(typewriterAnimRef.current);
        typewriterAnimRef.current = null;
        typewriterTargetRef.current = null;
      }
    }
  }, [typewriterMode]);

  useEffect(() => {
    const scrollContainer = editorScrollRef.current;
    if (!scrollContainer) return;
    const onManualScroll = () => {
      if (typewriterAnimRef.current !== null) {
        cancelAnimationFrame(typewriterAnimRef.current);
        typewriterAnimRef.current = null;
        typewriterTargetRef.current = null;
      }
    };
    scrollContainer.addEventListener("wheel", onManualScroll, { passive: true });
    scrollContainer.addEventListener("touchmove", onManualScroll, { passive: true });
    return () => {
      scrollContainer.removeEventListener("wheel", onManualScroll);
      scrollContainer.removeEventListener("touchmove", onManualScroll);
    };
  }, []);

  useEffect(() => {
    if (typewriterAnimRef.current !== null) {
      cancelAnimationFrame(typewriterAnimRef.current);
      typewriterAnimRef.current = null;
      typewriterTargetRef.current = null;
    }
  }, [note.id]);

  useEffect(
    () => () => {
      if (typewriterAnimRef.current !== null) {
        cancelAnimationFrame(typewriterAnimRef.current);
        typewriterAnimRef.current = null;
        typewriterTargetRef.current = null;
      }
    },
    [],
  );

  useEffect(() => {
    if (!editor) return;
    scheduleEditorSurfaceSync(editor);
    return () => {
      if (syncFrameRef.current !== null) {
        window.clearTimeout(syncFrameRef.current);
      }
      syncFrameRef.current = null;
      syncStartedAtRef.current = null;
      syncOutlineDirtyRef.current = false;
      if (markdownSyncFrameRef.current !== null) window.clearTimeout(markdownSyncFrameRef.current);
      markdownSyncFrameRef.current = null;
      markdownSyncStartedAtRef.current = null;
      if (imeCleanupTimerRef.current !== null) clearTimeout(imeCleanupTimerRef.current);
      imeCleanupTimerRef.current = null;
      leakedCandidateRef.current = null;
      composingRef.current = false;
      outlineHeadingElementsRef.current.clear();
    };
  }, [editor]);

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
    serializedMarkdownRef.current = null;
    markdownDirtyRef.current = false;
    if (markdownSyncFrameRef.current !== null) window.clearTimeout(markdownSyncFrameRef.current);
    markdownSyncFrameRef.current = null;
    markdownSyncStartedAtRef.current = null;
    initialContentRef.current = prepareMarkdownForEditor(contentMarkdown);
    replaceEditorMarkdown(editor, initialContentRef.current);
    editorScrollRef.current?.scrollTo({ top: 0, behavior: "auto" });
    if (switchedNote) {
      const doc = documentRef.current;
      if (doc && !doc.closest(".app-shell.layout-cards"))
        enteringAnimation = playEntranceAnimation(doc, "note-fade-in");
    }
    scheduleEditorSurfaceSync(editor);
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

  const scrollToOutlineItem = useEditorOutlineNavigation({
    editor,
    editorScrollRef,
    outlineFallbackSyncRef,
    outlineItemsRef,
    outlineHeadingElementsRef,
    outlineSelectionSynchronizedRef,
    programmaticOutlineScrollIdRef,
    outlineScrollAnimRef,
    outlineItems,
    outlineStructureKey,
    cancelOutlineSmoothScroll,
    onOutlineActiveChange,
  });

  useEffect(() => {
    onOutlineNavigationReady(scrollToOutlineItem);
    return () => onOutlineNavigationReady(null);
  }, [onOutlineNavigationReady, scrollToOutlineItem]);

  const saveLabel =
    saveState === "saving"
      ? "保存中"
      : saveState === "conflict"
        ? "检测到版本冲突，点击重新载入"
        : saveState === "error"
          ? "保存失败，点击重试"
          : "已保存";
  const annotations = useEditorAnnotations({
    editor,
    noteId: note.id,
    contentVersion: note.version,
    locked: editorLocked,
    deleted: Boolean(note.deletedAt),
    scrollRef: editorScrollRef,
    layoutMode: onBackToCards ? "cards" : "three-column",
    mobile: isMobileViewport,
  });
  onToggleAnnotationRef.current = annotations.toggleExpanded;
  onClearAnnotationRef.current = annotations.clearActive;
  const contextMenu = useEditorContextMenu({
    editor,
    noteId: note.id,
    locked: editorLocked,
    deleted: Boolean(note.deletedAt),
    onTitleChange: (title) => onChange(note.id, { title }),
    onAddAnnotation: annotations.openCreate,
    onEditAnnotation: annotations.startEdit,
    onDeleteAnnotation: annotations.deleteAnnotations,
    noteActions: [
      { label: "导出图片", icon: ImageDown, disabled: editorLocked, onSelect: onExportImage },
      ...(note.deletedAt
        ? [{ label: "恢复笔记", icon: Undo2, disabled: editorLocked, onSelect: onRestore }]
        : [
            {
              label: note.isFavorite ? "取消收藏" : "收藏笔记",
              icon: Star,
              disabled: editorLocked,
              onSelect: onToggleFavorite,
            },
            {
              label: "移入回收站",
              icon: Trash2,
              separator: true,
              danger: true,
              disabled: editorLocked,
              onSelect: onMoveToTrash,
            },
          ]),
    ],
  });
  return (
    <section
      className={`editor-panel ${deferredLoading ? "is-loading" : ""} ${focusMode ? "is-focus-mode" : ""} ${autoReadingMode ? "is-auto-reading-mode" : ""} ${isMobileViewport ? "is-mobile-editor" : ""} ${isActivePane ? "is-active-pane" : ""}`}
      aria-label="笔记编辑器"
      aria-busy={isLoading || deferredLoading || trashBusy}
      onPointerDown={onActivatePane}
      onFocusCapture={onActivatePane}
      onContextMenu={contextMenu.onContextMenu}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
          const target = event.target;
          if (target instanceof HTMLElement && !target.closest("dialog, [role='menu']")) {
            const rect = target.getBoundingClientRect();
            if (
              !target.dispatchEvent(
                new MouseEvent("contextmenu", {
                  bubbles: true,
                  cancelable: true,
                  clientX: rect.left + 12,
                  clientY: rect.top + 12,
                }),
              )
            )
              event.preventDefault();
          }
        }
        if ((event.ctrlKey || event.metaKey) && event.key === "s") {
          event.preventDefault();
          handleSaveNow();
        }
      }}
    >
      <EditorHeader
        isMobileViewport={isMobileViewport}
        note={note}
        mobileBackLabel={mobileBackLabel}
        editorLocked={editorLocked}
        trashBusy={trashBusy}
        backlinkCount={backlinkCount}
        backlinksOpen={backlinksOpen}
        saveState={saveState}
        saveLabel={saveLabel}
        imageUploadState={imageUploadState}
        imageUploadMessage={imageUploadMessage}
        imageFileInputRef={imageFileInputRef}
        uploadImageFilesRef={uploadImageFilesRef}
        focusMode={focusMode}
        autoReadingMode={autoReadingMode}
        isSplitActive={isSplitActive}
        onUploadImage={onUploadImage}
        onCloseSplit={onCloseSplit}
        onToggleSplit={onToggleSplit}
        onBackToKanban={onBackToKanban}
        onBackToCards={onBackToCards}
        onOpenList={onOpenList}
        onNavigateToNote={onNavigateToNote}
        onOpenBacklinks={() => setBacklinksOpen(true)}
        onToggleFavorite={onToggleFavorite}
        onMoveToTrash={onMoveToTrash}
        onRestore={onRestore}
        onPermanentDelete={onPermanentDelete}
        onToggleAutoReadingMode={onToggleAutoReadingMode}
        onExportImage={onExportImage}
        onSaveNow={handleSaveNow}
        onReloadNote={onReloadNote}
      />
      {imageUploadMessage && (
        <div className="editor-upload-notice toast toast--error">
          <CircleAlert className="notice-icon" size={18} aria-hidden="true" />
          <div className="editor-upload-notice-body">
            <div
              id={imageUploadMessageId}
              ref={imageUploadMessageRef}
              className="notice-copy editor-upload-notice-copy floating-scrollbar-target"
              role="alert"
              aria-atomic="true"
            >
              {imageUploadMessage}
            </div>
            <FloatingScrollbar
              scrollTargetRef={imageUploadMessageRef}
              controlsId={imageUploadMessageId}
              ariaLabel="图片上传提示滚动条"
              placement="right"
            />
          </div>
          <button
            type="button"
            className="notice-dismiss"
            aria-label="关闭图片上传提示"
            onClick={clearImageUploadMessage}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {isMobileViewport && onUploadImage && !note.deletedAt && (
        <input
          ref={imageFileInputRef}
          className="visually-hidden"
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          multiple
          tabIndex={-1}
          aria-label="选择要上传的图片文件"
          onChange={(event) => {
            uploadImageFilesRef.current(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
        />
      )}
      <div
        className={`editor-scroll-shell${editorScrollEdges.before ? " has-scroll-before" : ""}${editorScrollEdges.after ? " has-scroll-after" : ""}`}
      >
        <div
          id="editor-scroll-region"
          className={`editor-scroll floating-scrollbar-target ${typewriterMode ? "is-typewriter-mode" : ""} ${autoReadingMode ? "is-auto-reading" : ""}`}
          ref={editorScrollRef}
          onClick={(event) => {
            const target = event.target as HTMLElement | null;
            if (
              !target?.closest(".annotation-card, .note-annotation, [role='dialog'], [role='menu']")
            ) {
              onClearAnnotationRef.current();
            }
          }}
          onKeyDownCapture={(event) => {
            const target = event.target;
            if (!(target instanceof HTMLElement) || editor?.view.composing || composingRef.current)
              return;
            if (target.closest("input, textarea, button, select, [role='dialog'], [role='menu']"))
              return;
            // 在 ProseMirror 处理前滚动整篇笔记，保留正文光标与选区。
            if (["Home", "End", "PageUp", "PageDown"].includes(event.key)) {
              const behavior: ScrollBehavior = window.matchMedia("(prefers-reduced-motion: reduce)")
                .matches
                ? "auto"
                : "smooth";
              if (scrollNoteNavigation(event.nativeEvent, event.currentTarget, behavior)) {
                event.stopPropagation();
                if (typewriterAnimRef.current !== null)
                  cancelAnimationFrame(typewriterAnimRef.current);
                typewriterAnimRef.current = null;
                typewriterTargetRef.current = null;
              }
            }
          }}
        >
          <div
            className="editor-document editor-document--entering"
            ref={documentRef}
            onAnimationEnd={() =>
              documentRef.current?.classList.remove("editor-document--entering")
            }
          >
            {note.deletedAt && (
              <div className="trashed-banner" role="status">
                <span>此笔记已在回收站中，恢复后可继续编辑。</span>
                <button
                  className="text-button"
                  type="button"
                  onClick={onRestore}
                  disabled={editorLocked || trashBusy}
                >
                  立即恢复
                </button>
              </div>
            )}
            <textarea
              ref={titleInputRef}
              className="note-title-input"
              rows={1}
              value={note.title}
              maxLength={200}
              readOnly={Boolean(note.deletedAt) || editorLocked}
              onChange={(event) => onChange(note.id, { title: event.target.value })}
              onBlur={() => {
                const trimmed = note.title.trim();
                if (trimmed !== note.title) onChange(note.id, { title: trimmed });
              }}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.nativeEvent.isComposing &&
                  event.keyCode !== 229
                ) {
                  event.preventDefault();
                  editor?.commands.focus("start");
                }
              }}
              aria-label="笔记标题"
              placeholder="未命名笔记"
            />
            <h1 className="visually-hidden">{note.title.trim() || "未命名笔记"}</h1>
            {/* 临时加载锁通过 inert 阻止交互，避免 Safari 因 contenteditable 变化重排整篇正文。 */}
            <EditorContent editor={editor} inert={loadingLocked} />
            <BlockDragHandle
              editor={editor}
              containerRef={documentRef}
              scrollRef={editorScrollRef}
              disabled={editorLocked || isMobileViewport || Boolean(note.deletedAt)}
            />
            <TableScrollbars rootRef={documentRef} />
            {annotations.overlay}
          </div>
        </div>
        <FloatingScrollbar
          scrollTargetRef={editorScrollRef}
          contentRef={documentRef}
          controlsId="editor-scroll-region"
          ariaLabel="编辑器滚动条"
          placement="right"
        />
        {autoReadingMode && (
          <AutoReadingHUD scrollTargetRef={editorScrollRef} onExit={onExitAutoReadingMode} />
        )}
      </div>
      {deferredLoading && (
        <div
          className="editor-switch-overlay editor-switch-overlay--visible"
          role="status"
          aria-live="polite"
        >
          <div className="editor-switch-card">
            <BrandMark className="editor-switch-mark" />
            <div className="editor-switch-lines" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <strong>{loadingLabel}</strong>
          </div>
        </div>
      )}
      <EditorFloatingTools
        editor={editor}
        outlineTriggerRef={outlineTriggerRef}
        outlineOpen={outlineOpen}
        editorStats={editorStats}
        onToggleOutline={onToggleOutline}
        hideOutlineTrigger={focusMode || isMobileViewport}
        searchNavigation={searchNavigation}
        searchQuery={searchQuery}
        replaceOpen={replaceOpen}
        replaceQuery={replaceQuery}
        replacementText={replacementText}
        replaceMatchNavigation={searchNavigation}
        onToggleReplace={toggleReplace}
        onChangeReplaceQuery={setReplaceQuery}
        onChangeReplacementText={setReplacementText}
        onMoveReplaceMatch={moveSearchMatch}
        onReplaceCurrent={replaceCurrent}
        onReplaceAll={replaceAll}
        onCloseReplace={closeReplace}
        deferredLoading={editorLocked}
        onMoveSearchMatch={moveSearchMatch}
        onClearSearch={onClearSearch}
      />
      {isMobileViewport && (
        <MobileEditorFooter
          stats={editorStats}
          outlineOpen={outlineOpen}
          outlineTriggerRef={outlineTriggerRef}
          locked={editorLocked}
          onToggleOutline={onToggleOutline}
        />
      )}
      {contextMenu.menu}
      {!note.deletedAt && onNavigateToNote && (
        <BacklinksDialog
          open={backlinksOpen}
          onClose={() => setBacklinksOpen(false)}
          noteId={note.id}
          noteTitle={note.title}
          onNavigateToNote={onNavigateToNote}
          onBacklinkCountChange={setBacklinkCount}
        />
      )}
      {isMobileViewport && !autoReadingMode && outlineOpen && (
        <MobileEditorOutline
          items={outlineItems}
          activeId={activeOutlineId ?? null}
          onNavigate={scrollToOutlineItem}
          onClose={onCloseOutline}
        />
      )}
      {!isMobileViewport &&
        !autoReadingMode &&
        (focusMode || ((onBackToCards || onBackToKanban) && outlineOpen)) && (
          <CardOutline
            key={note.id}
            outlineItems={outlineItems}
            activeOutlineId={activeOutlineId ?? null}
            onNavigate={scrollToOutlineItem}
            onClose={onCloseOutline}
          />
        )}
      {annotations.composer}
    </section>
  );
}
