import type { JSONContent } from "@tiptap/core";
import { lazy, memo, Suspense, type MutableRefObject, type RefObject } from "react";
import type { ImageAssetSummary, Note, NoteSummary, NoteView } from "../../shared/types";
import { api } from "../api";
import type { OutlineItem } from "../editor-metrics";
import { EditorErrorFallback, ErrorBoundary } from "../error-boundary";
import { toNoteSummary } from "./helpers";
import { EmptyEditor, NoteLoadingState } from "./panels";
import { SplitResizer } from "./split-resizer";
import type { SaveState } from "./use-note-save-queue";

const LazyNoteEditor = lazy(() =>
  import("../editor").then(({ NoteEditor }) => ({ default: memo(NoteEditor) })),
);

type WorkspaceEditorPaneProps = {
  note: Note;
  contentMarkdown: string;
  availableNotes: NoteSummary[];
  onNavigateWikiLink: (targetTitle: string) => void;
  onCreateAndLinkNote: (title: string) => void;
  onNavigateToNote: (id: string) => void;
  searchQuery: string;
  replaceRequest: { noteId: string; token: number; query: string } | null;
  onReplaceRequestHandled: (token: number) => void;
  searchNavigationToken: number;
  taskNavigation: { noteId: string; ordinal: number; text: string; token: number } | null;
  onTaskNavigationMissing: () => void;
  onClearSearch?: () => void;
  onMarkdownReaderChange: (reader: ((noteId: string) => string | null) | null) => void;
  onMarkdownDirtyChange: (noteId: string, isDirty: boolean) => void;
  saveState: SaveState;
  isLoading: boolean;
  loadingLabel?: string;
  trashBusy: boolean;
  reloadToken: number;
  focusRequested: boolean;
  onFocusHandled: () => void;
  onChange: (noteId: string, patch: { title?: string; contentMarkdown?: string }) => void;
  onSaveNow: () => void;
  onReloadNote: () => void;
  onExportImage: () => void;
  onToggleFavorite: () => void;
  onMoveToTrash: () => void;
  onRestore: () => void;
  onPermanentDelete?: () => void;
  onOpenList: () => void;
  isMobileViewport: boolean;
  mobileBackLabel: string;
  onBackToKanban?: () => void;
  onBackToCards?: () => void;
  onUploadImage: (file: File) => Promise<{ asset: ImageAssetSummary }>;
  deferredImages?: readonly JSONContent[];
  onDeferImage: (noteId: string, image: JSONContent) => void;
  onBackgroundImageError: (filename: string) => void;
  insertDeferredImages: (noteId: string, insert: (images: JSONContent[]) => boolean) => void;
  focusMode: boolean;
  autoReadingMode?: boolean;
  onToggleAutoReadingMode?: () => void;
  onExitAutoReadingMode?: () => void;
  typewriterMode: boolean;
  outlineOpen: boolean;
  outlineItems: OutlineItem[];
  activeOutlineId?: string | null;
  onToggleOutline: () => void;
  onCloseOutline: () => void;
  onOutlineItemsChange: (items: OutlineItem[]) => void;
  onOutlineActiveChange: (id: string | null) => void;
  onOutlineNavigationReady: (navigate: ((id: string) => void) | null) => void;
  onToggleSplit?: () => void;
  isSplitActive?: boolean;
  onCloseSplit?: () => void;
  isActivePane?: boolean;
  onActivatePane?: () => void;
};

function WorkspaceEditorPane(props: WorkspaceEditorPaneProps) {
  return (
    <ErrorBoundary
      key={props.note.id}
      fallback={(error, reset) => <EditorErrorFallback error={error} reset={reset} />}
    >
      <Suspense fallback={<NoteLoadingState />}>
        <LazyNoteEditor {...props} onSearchWikiLinkTitles={api.searchWikiNoteTitles} />
      </Suspense>
    </ErrorBoundary>
  );
}

export type WorkspaceEditorAreaProps = {
  editorRegionRef: RefObject<HTMLElement | null>;
  editorContentInert: boolean;
  mountEditor: boolean;
  renderedNote: Note | null;
  renderedNoteContent: string;
  splitRenderedNote: Note | null;
  splitRenderedNoteContent: string;
  splitNoteId: string | null;
  isMobileViewport: boolean;
  isSplitEditor: boolean;
  splitRatio: number;
  setSplitRatio: (ratio: number) => void;
  activePane: "primary" | "secondary";
  setActivePane: (pane: "primary" | "secondary") => void;
  notes: NoteSummary[];
  handleNavigateWikiLinkPrimary: (targetTitle: string) => void;
  handleNavigateWikiLinkSplit: (targetTitle: string) => void;
  handleCreateAndLinkNote: (title: string) => void;
  selectNote: (id: string | null) => void;
  openInSplit: (id: string) => void;
  resultSearch: { id: string; query: string; token: number } | null;
  inNoteSearchQuery: string;
  replaceRequest: { noteId: string; token: number; query: string } | null;
  handleReplaceRequestHandled: (token: number) => void;
  taskNavigation: { noteId: string; ordinal: number; text: string; token: number } | null;
  handleTaskNavigationMissing: () => void;
  handleClearInNoteSearch: () => void;
  registerEditorMarkdownReader: (reader: ((noteId: string) => string | null) | null) => void;
  registerEditorMarkdownDirty: (noteId: string, isDirty: boolean) => void;
  splitMarkdownReaderRef: MutableRefObject<((noteId: string) => string | null) | null>;
  splitMarkdownDirtyNoteRef: MutableRefObject<string | null>;
  saveState: SaveState;
  splitSaveState: SaveState;
  isNoteLoading: boolean;
  splitIsNoteLoading: boolean;
  creatingNote: boolean;
  busyTasks: ReadonlyMap<string, number>;
  emptyingTrash: boolean;
  pendingTrashCount: number;
  trashOperationsRef: MutableRefObject<Set<string>>;
  noteReloadToken: number;
  splitNoteReloadToken: number;
  editorFocusNoteId: string | null;
  splitEditorFocusNoteId: string | null;
  commandOpen: boolean;
  handleEditorFocus: () => void;
  handleSplitEditorFocus: () => void;
  onNoteChange: (noteId: string, patch: { title?: string; contentMarkdown?: string }) => void;
  onSplitNoteChange: (noteId: string, patch: { title?: string; contentMarkdown?: string }) => void;
  requestDraftRecovery: (noteId: string) => void;
  saveNoteNow: (noteId?: string) => void;
  requestConflictReload: () => void;
  requestSplitConflictReload: (noteId: string) => void;
  handleExportImage: () => void;
  toggleFavorite: () => void;
  handleToggleFavoriteNote: (target: NoteSummary) => Promise<void>;
  moveToTrash: () => void;
  restoreFromTrash: () => void;
  permanentDeleteNote: () => void;
  handleSplitMoveToTrash: () => void;
  handleSplitRestore: () => void;
  handleSplitPermanentDelete: () => void;
  handleOpenList: () => void;
  mobileBackLabel: string;
  onBackToKanban?: () => void;
  onBackToCards?: () => void;
  handleUploadImage: (file: File) => Promise<{ asset: ImageAssetSummary }>;
  deferredImages: ReadonlyMap<string, JSONContent[]>;
  onDeferImage: (noteId: string, image: JSONContent) => void;
  onBackgroundImageError: (filename: string) => void;
  insertDeferredImages: (noteId: string, insert: (images: JSONContent[]) => boolean) => void;
  focusMode: boolean;
  autoReadingMode: boolean;
  toggleAutoReadingMode: () => void;
  exitAutoReadingMode: () => void;
  typewriterMode: boolean;
  outlineOpen: boolean;
  outlineItems: OutlineItem[];
  activeOutlineId: string | null;
  splitOutlineItems: OutlineItem[];
  splitActiveOutlineId: string | null;
  toggleOutline: () => void;
  closeOutline: () => void;
  handleOutlineItemsChange: (items: OutlineItem[]) => void;
  handleOutlineActiveChange: (id: string | null) => void;
  handleOutlineNavigationReady: (navigate: ((id: string) => void) | null) => void;
  handleSplitOutlineItemsChange: (items: OutlineItem[]) => void;
  handleSplitOutlineActiveChange: (id: string | null) => void;
  handleSplitOutlineNavigationReady: (navigate: ((id: string) => void) | null) => void;
  handleToggleSplit?: () => void;
  closeSplit: () => void;
  view: NoteView;
  handleNewNote: () => void;
  listTransitionToken: number;
};

export function WorkspaceEditorArea({
  editorRegionRef,
  editorContentInert,
  mountEditor,
  renderedNote,
  renderedNoteContent,
  splitRenderedNote,
  splitRenderedNoteContent,
  splitNoteId,
  isMobileViewport,
  isSplitEditor,
  splitRatio,
  setSplitRatio,
  activePane,
  setActivePane,
  notes,
  handleNavigateWikiLinkPrimary,
  handleNavigateWikiLinkSplit,
  handleCreateAndLinkNote,
  selectNote,
  openInSplit,
  resultSearch,
  inNoteSearchQuery,
  replaceRequest,
  handleReplaceRequestHandled,
  taskNavigation,
  handleTaskNavigationMissing,
  handleClearInNoteSearch,
  registerEditorMarkdownReader,
  registerEditorMarkdownDirty,
  splitMarkdownReaderRef,
  splitMarkdownDirtyNoteRef,
  saveState,
  splitSaveState,
  isNoteLoading,
  splitIsNoteLoading,
  creatingNote,
  busyTasks,
  emptyingTrash,
  pendingTrashCount,
  trashOperationsRef,
  noteReloadToken,
  splitNoteReloadToken,
  editorFocusNoteId,
  splitEditorFocusNoteId,
  commandOpen,
  handleEditorFocus,
  handleSplitEditorFocus,
  onNoteChange,
  onSplitNoteChange,
  requestDraftRecovery,
  saveNoteNow,
  requestConflictReload,
  requestSplitConflictReload,
  handleExportImage,
  toggleFavorite,
  handleToggleFavoriteNote,
  moveToTrash,
  restoreFromTrash,
  permanentDeleteNote,
  handleSplitMoveToTrash,
  handleSplitRestore,
  handleSplitPermanentDelete,
  handleOpenList,
  mobileBackLabel,
  onBackToKanban,
  onBackToCards,
  handleUploadImage,
  deferredImages,
  onDeferImage,
  onBackgroundImageError,
  insertDeferredImages,
  focusMode,
  autoReadingMode,
  toggleAutoReadingMode,
  exitAutoReadingMode,
  typewriterMode,
  outlineOpen,
  outlineItems,
  activeOutlineId,
  splitOutlineItems,
  splitActiveOutlineId,
  toggleOutline,
  closeOutline,
  handleOutlineItemsChange,
  handleOutlineActiveChange,
  handleOutlineNavigationReady,
  handleSplitOutlineItemsChange,
  handleSplitOutlineActiveChange,
  handleSplitOutlineNavigationReady,
  handleToggleSplit,
  closeSplit,
  view,
  handleNewNote,
  listTransitionToken,
}: WorkspaceEditorAreaProps) {
  const primaryEditor =
    mountEditor && renderedNote ? (
      <WorkspaceEditorPane
        note={renderedNote}
        contentMarkdown={renderedNoteContent}
        availableNotes={notes}
        onNavigateWikiLink={handleNavigateWikiLinkPrimary}
        onCreateAndLinkNote={handleCreateAndLinkNote}
        onNavigateToNote={selectNote}
        searchQuery={resultSearch?.id === renderedNote.id ? resultSearch.query : inNoteSearchQuery}
        replaceRequest={replaceRequest?.noteId === renderedNote.id ? replaceRequest : null}
        onReplaceRequestHandled={handleReplaceRequestHandled}
        searchNavigationToken={resultSearch?.id === renderedNote.id ? resultSearch.token : 0}
        taskNavigation={taskNavigation?.noteId === renderedNote.id ? taskNavigation : null}
        onTaskNavigationMissing={handleTaskNavigationMissing}
        onClearSearch={
          inNoteSearchQuery || resultSearch?.id === renderedNote.id
            ? handleClearInNoteSearch
            : undefined
        }
        onMarkdownReaderChange={registerEditorMarkdownReader}
        onMarkdownDirtyChange={registerEditorMarkdownDirty}
        saveState={saveState}
        isLoading={isNoteLoading || creatingNote || busyTasks.has(renderedNote.id)}
        loadingLabel={
          creatingNote
            ? "正在新建笔记…"
            : busyTasks.has(renderedNote.id)
              ? "正在更新任务…"
              : undefined
        }
        trashBusy={
          emptyingTrash ||
          (pendingTrashCount > 0 && trashOperationsRef.current.has(renderedNote.id))
        }
        reloadToken={noteReloadToken}
        focusRequested={editorFocusNoteId === renderedNote.id && !commandOpen}
        onFocusHandled={handleEditorFocus}
        onChange={onNoteChange}
        onSaveNow={
          saveState === "missing" ? () => requestDraftRecovery(renderedNote.id) : saveNoteNow
        }
        onReloadNote={requestConflictReload}
        onExportImage={handleExportImage}
        onToggleFavorite={toggleFavorite}
        onMoveToTrash={moveToTrash}
        onRestore={restoreFromTrash}
        onPermanentDelete={permanentDeleteNote}
        onOpenList={handleOpenList}
        isMobileViewport={isSplitEditor ? false : isMobileViewport}
        mobileBackLabel={mobileBackLabel}
        onBackToKanban={onBackToKanban}
        onBackToCards={onBackToCards}
        onUploadImage={handleUploadImage}
        deferredImages={deferredImages.get(renderedNote.id)}
        onDeferImage={onDeferImage}
        onBackgroundImageError={onBackgroundImageError}
        insertDeferredImages={insertDeferredImages}
        focusMode={focusMode}
        autoReadingMode={isSplitEditor ? false : autoReadingMode}
        onToggleAutoReadingMode={toggleAutoReadingMode}
        onExitAutoReadingMode={exitAutoReadingMode}
        typewriterMode={typewriterMode}
        outlineOpen={outlineOpen && (!isSplitEditor || activePane === "primary")}
        outlineItems={outlineItems}
        activeOutlineId={activeOutlineId}
        onToggleOutline={() => {
          if (isSplitEditor) setActivePane("primary");
          toggleOutline();
        }}
        onCloseOutline={closeOutline}
        onOutlineItemsChange={handleOutlineItemsChange}
        onOutlineActiveChange={handleOutlineActiveChange}
        onOutlineNavigationReady={handleOutlineNavigationReady}
        onToggleSplit={handleToggleSplit}
        isSplitActive={isSplitEditor}
        isActivePane={isSplitEditor ? activePane === "primary" : undefined}
        onActivatePane={isSplitEditor ? () => setActivePane("primary") : undefined}
      />
    ) : null;

  const emptyFallback = (
    <EmptyEditor
      isTrash={view === "trash"}
      onNewNote={handleNewNote}
      creatingNote={creatingNote}
      onOpenList={handleOpenList}
      transitionToken={listTransitionToken}
    />
  );

  return (
    <main
      ref={editorRegionRef}
      className={`editor-region ${splitNoteId && !isMobileViewport ? "is-split" : ""}`}
      tabIndex={-1}
      aria-hidden={editorContentInert || undefined}
      inert={editorContentInert}
    >
      {splitNoteId && !isMobileViewport ? (
        <>
          <div className="split-pane split-pane-primary" style={{ flex: `${splitRatio} 1 0%` }}>
            {primaryEditor ?? (isNoteLoading ? <NoteLoadingState /> : emptyFallback)}
          </div>
          <SplitResizer
            splitRatio={splitRatio}
            onSplitRatioChange={setSplitRatio}
            containerRef={editorRegionRef}
          />
          <div
            className="split-pane split-pane-secondary"
            style={{ flex: `${1 - splitRatio} 1 0%` }}
          >
            {splitRenderedNote ? (
              <WorkspaceEditorPane
                note={splitRenderedNote}
                contentMarkdown={splitRenderedNoteContent}
                availableNotes={notes}
                onNavigateWikiLink={handleNavigateWikiLinkSplit}
                onCreateAndLinkNote={handleCreateAndLinkNote}
                onNavigateToNote={(id) => openInSplit(id)}
                searchQuery={resultSearch?.id === splitRenderedNote.id ? resultSearch.query : ""}
                replaceRequest={
                  replaceRequest?.noteId === splitRenderedNote.id ? replaceRequest : null
                }
                onReplaceRequestHandled={handleReplaceRequestHandled}
                searchNavigationToken={
                  resultSearch?.id === splitRenderedNote.id ? resultSearch.token : 0
                }
                taskNavigation={
                  taskNavigation?.noteId === splitRenderedNote.id ? taskNavigation : null
                }
                onTaskNavigationMissing={handleTaskNavigationMissing}
                onClearSearch={
                  resultSearch?.id === splitRenderedNote.id ? handleClearInNoteSearch : undefined
                }
                onMarkdownReaderChange={(reader) => {
                  splitMarkdownReaderRef.current = reader;
                }}
                onMarkdownDirtyChange={(noteId, isDirty) => {
                  if (isDirty) splitMarkdownDirtyNoteRef.current = noteId;
                  else if (splitMarkdownDirtyNoteRef.current === noteId)
                    splitMarkdownDirtyNoteRef.current = null;
                }}
                saveState={splitSaveState}
                isLoading={
                  splitIsNoteLoading || creatingNote || busyTasks.has(splitRenderedNote.id)
                }
                loadingLabel={
                  creatingNote
                    ? "正在新建笔记…"
                    : busyTasks.has(splitRenderedNote.id)
                      ? "正在更新任务…"
                      : undefined
                }
                trashBusy={
                  emptyingTrash ||
                  (pendingTrashCount > 0 && trashOperationsRef.current.has(splitRenderedNote.id))
                }
                reloadToken={splitNoteReloadToken}
                focusRequested={splitEditorFocusNoteId === splitRenderedNote.id && !commandOpen}
                onFocusHandled={handleSplitEditorFocus}
                onChange={onSplitNoteChange}
                onSaveNow={() =>
                  splitSaveState === "missing"
                    ? requestDraftRecovery(splitRenderedNote.id)
                    : saveNoteNow(splitRenderedNote.id)
                }
                onReloadNote={() => requestSplitConflictReload(splitRenderedNote.id)}
                onExportImage={handleExportImage}
                onToggleFavorite={() =>
                  void handleToggleFavoriteNote(toNoteSummary(splitRenderedNote))
                }
                onMoveToTrash={handleSplitMoveToTrash}
                onRestore={handleSplitRestore}
                onPermanentDelete={handleSplitPermanentDelete}
                onOpenList={handleOpenList}
                isMobileViewport={false}
                mobileBackLabel=""
                onUploadImage={handleUploadImage}
                deferredImages={deferredImages.get(splitRenderedNote.id)}
                onDeferImage={onDeferImage}
                onBackgroundImageError={onBackgroundImageError}
                insertDeferredImages={insertDeferredImages}
                focusMode={focusMode}
                typewriterMode={typewriterMode}
                outlineOpen={outlineOpen && activePane === "secondary"}
                outlineItems={splitOutlineItems}
                activeOutlineId={splitActiveOutlineId}
                onToggleOutline={() => {
                  setActivePane("secondary");
                  toggleOutline();
                }}
                onCloseOutline={closeOutline}
                onOutlineItemsChange={handleSplitOutlineItemsChange}
                onOutlineActiveChange={handleSplitOutlineActiveChange}
                onOutlineNavigationReady={handleSplitOutlineNavigationReady}
                onCloseSplit={closeSplit}
                isActivePane={activePane === "secondary"}
                onActivatePane={() => setActivePane("secondary")}
              />
            ) : splitIsNoteLoading ? (
              <NoteLoadingState />
            ) : null}
          </div>
        </>
      ) : (
        (primaryEditor ?? (isNoteLoading ? <NoteLoadingState /> : emptyFallback))
      )}
    </main>
  );
}
