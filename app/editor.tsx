import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor, JSONContent } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { ImageDown, Star, Trash2, Undo2 } from "lucide-react";
import { type ImageAssetSummary, type Note, type NoteSummary } from "../shared/types";
import { dispatchKeyboardContextMenu } from "./context-menu";
import { SearchHighlightExtension } from "./editor-search";
import {
  countEditorText,
  getOutlineStructureKey,
  type EditorStats,
  type OutlineItem,
} from "./editor-metrics";
import { type EditorTextBlockStatsCache, type EditorTextStatsSnapshot } from "./editor-text-stats";
import { EditorHeader } from "./editor/editor-header";
import { EditorSwitchOverlay, EditorUploadNotice } from "./editor/editor-overlays";
import type { SaveState } from "./workspace/use-note-save-queue";
import { transactionMayChangeOutline } from "./editor/outline-change";
import { scrollNoteNavigation } from "./editor/document-navigation";
import { TaskNavigationExtension } from "./editor/task-navigation";
import { FloatingScrollbar } from "./floating-scrollbar";
import { editorCoreExtensionOptions } from "./editor/editor-config";
import { createCommonEditorExtensions } from "./editor/common-extensions";
import { EditorFloatingTools } from "./editor/editor-panels";
import { ImageNode } from "./editor/image-node";
import { ImageUploadPositions } from "./editor/image-upload-position";
import { BacklinksDialog } from "./editor/backlinks-panel";
import { EditableWikiLinkNode, useWikiLinkTitles, WikiLinkTitles } from "./editor/wiki-link-node";
import {
  WikiLinkSuggestionExtension,
  type WikiLinkTitleSearch,
} from "./editor/wiki-link-suggestion";
import { CalloutNode } from "./editor/callout-node";
import { SlashCommandExtension } from "./editor/slash-command-menu";
import { TableScrollbars } from "./editor/table-scrollbars";
import { CardOutline } from "./editor/card-outline";
import { MobileEditorFooter, MobileEditorOutline } from "./editor/mobile-editor-controls";
import { useMobileCaret } from "./editor/use-mobile-caret";
import { useEditorCaretScroll } from "./editor/use-editor-caret-scroll";
import {
  syncEditorActiveOutline,
  useEditorOutlineNavigation,
} from "./editor/use-editor-outline-navigation";
import { useEditorSurfaceSync } from "./editor/use-editor-surface-sync";
import { useEditorMarkdownSync } from "./editor/use-editor-markdown-sync";
import { useEditorTypewriter } from "./editor/use-editor-typewriter";
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
import { useEditorNoteLifecycle } from "./editor/use-editor-note-lifecycle";
import "./editor/mobile-editor.css";

const NO_AVAILABLE_NOTES: NoteSummary[] = [];

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
  onDeferImage,
  onBackgroundImageError,
  deferredImages,
  insertDeferredImages,
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
  availableNotes = NO_AVAILABLE_NOTES,
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
  onDeferImage: (noteId: string, image: JSONContent) => void;
  onBackgroundImageError: (filename: string) => void;
  deferredImages?: readonly JSONContent[];
  insertDeferredImages: (noteId: string, insert: (images: JSONContent[]) => boolean) => void;
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
  onNavigateWikiLink?: (id: string) => void;
  onCreateAndLinkNote?: (title: string) => Promise<{ id: string; title: string } | null>;
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
  const bodyEditable = !note.deletedAt && !trashBusy && !autoReadingMode;
  const [backlinksOpen, setBacklinksOpen] = useState(false);
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
    locked: isLoading || trashBusy || autoReadingMode,
    onUploadImage,
    onDeferImage,
    onBackgroundImageError,
  });
  const typewriterModeRef = useRef(typewriterMode);
  const typewriterAnimRef = useRef<number | null>(null);
  const typewriterTargetRef = useRef<number | null>(null);
  const outlineFallbackSyncRef = useRef<(() => void) | null>(null);
  const outlineHeadingElementsRef = useRef(new Map<string, HTMLElement>());
  const outlineItemsRef = useRef(outlineItems);
  const outlineSelectionSynchronizedRef = useRef(false);
  const outlineStructureKey = getOutlineStructureKey(outlineItems);

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
      EditableWikiLinkNode,
      SlashCommandExtension.configure({ onPickImage: () => imageFileInputRef.current?.click() }),
      WikiLinkSuggestionExtension.configure({
        getNotes: () => availableNotesRef.current,
        searchTitles: (query, signal) =>
          onSearchWikiLinkTitlesRef.current?.(query, signal) ??
          Promise.resolve({ matches: [], exactMatch: false }),
        onCreateNote: (title) => onCreateAndLinkNoteRef.current?.(title) ?? Promise.resolve(null),
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
  const { alignTypewriterRef, cancelTypewriterAnimation } = useEditorTypewriter({
    noteId: note.id,
    typewriterMode,
    editorScrollRef,
    editorInstanceRef,
    typewriterModeRef,
    typewriterAnimRef,
    typewriterTargetRef,
    alignTypewriter,
  });

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

  const {
    readDirtyMarkdown,
    flushMarkdownChange,
    scheduleMarkdownChange,
    clearMarkdownSyncTimer,
    resetMarkdownDirtyState,
  } = useEditorMarkdownSync({
    editorInstanceRef,
    markdownOwnerRef,
    onChangeRef,
    onMarkdownDirtyChangeRef,
  });

  const editor = useEditor({
    injectCSS: false,
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
  const wikiLinkTitles = useWikiLinkTitles(editor, availableNotes);

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
    editorLocked: isLoading || trashBusy || autoReadingMode,
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
    (instance: Editor) =>
      syncEditorActiveOutline(
        instance,
        editorScrollRef.current,
        outlineItemsRef.current,
        outlineHeadingElementsRef.current,
        onOutlineActiveChange,
      ),
    [onOutlineActiveChange],
  );

  const { backlinkCount, setBacklinkCount, deferredLoading } = useEditorNoteLifecycle({
    editor,
    note,
    contentMarkdown,
    reloadToken,
    isLoading,
    bodyEditable,
    editorLocked: isLoading || trashBusy || autoReadingMode,
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
  });
  const loadingLocked = isLoading || deferredLoading;
  const editorLocked = loadingLocked || trashBusy || autoReadingMode;

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
        dispatchKeyboardContextMenu(event, "dialog, [role='menu']");
        if (
          !event.nativeEvent.isComposing &&
          event.keyCode !== 229 &&
          (event.ctrlKey || event.metaKey) &&
          event.key === "s"
        ) {
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
        <EditorUploadNotice
          message={imageUploadMessage}
          messageId={imageUploadMessageId}
          messageRef={imageUploadMessageRef}
          onDismiss={clearImageUploadMessage}
        />
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
        className={`editor-scroll-shell scroll-edge${editorScrollEdges.before ? " has-scroll-before" : ""}${editorScrollEdges.after ? " has-scroll-after" : ""}`}
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
                if (typewriterAnimRef.current !== null) cancelTypewriterAnimation();
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
            <WikiLinkTitles.Provider value={wikiLinkTitles}>
              <EditorContent editor={editor} inert={loadingLocked} />
            </WikiLinkTitles.Provider>
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
      {deferredLoading && <EditorSwitchOverlay label={loadingLabel} />}
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
