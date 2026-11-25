import { lazy, Suspense, type ReactNode } from "react";
import type { Note, NoteSummary, Notebook } from "../../shared/types";
import { CommandMenu, type CommandId } from "../command-menu";
import type { CreateNoteCommand } from "../command-parser";
import type { ImageExportSnapshot } from "../image-export/render";
import type { PwaState } from "../pwa";
import type { ThemePreference } from "../theme";
import { ConfirmDialog, NotebookDialog, type ConfirmRequest } from "./dialogs";
import { SplitNoteDialog } from "./split-note-dialog";
import { SystemNotices } from "./system-notices";
import type { Notice, NoticePauseSource } from "./use-notices";
import type { ViewLayout } from "./use-workspace-preferences";

const LazyImageExportDialog = lazy(() =>
  import("../image-export/dialog").then(({ ImageExportDialog }) => ({
    default: ImageExportDialog,
  })),
);

export type WorkspaceDialogsProps = {
  isMobileViewport: boolean;
  commandOpen: boolean;
  commandInitialQuery: string;
  commandNoteReady: boolean;
  renderedNote: Note | null;
  notebooks: Notebook[];
  focusMode: boolean;
  autoReadingMode: boolean;
  splitNoteId: string | null;
  typewriterMode: boolean;
  viewLayout: ViewLayout;
  pwaState: PwaState;
  themePreference: ThemePreference;
  imageExportSnapshot: ImageExportSnapshot | null;
  editingNotebook: Notebook | null | undefined;
  confirmRequest: ConfirmRequest | null;
  splitPickerOpen: boolean;
  notes: NoteSummary[];
  selectedId: string | null;
  notice: Notice | null;
  offline: boolean;
  workspaceMenu: ReactNode;
  onCloseCommandMenu: () => void;
  onCommand: (id: CommandId) => void;
  onCreateNoteInNotebook: (command: CreateNoteCommand) => void;
  onMoveCurrentNoteToNotebook: (notebookId: string) => void;
  onSearchInCurrentNote: (query: string) => void;
  onReplaceInCurrentNote: () => void;
  onSearchGlobal: (query: string) => void;
  onCloseImageExport: () => void;
  onCloseNotebookDialog: () => void;
  onSaveNotebookDraft: (draft: { name: string; color: string; icon: string }) => Promise<Notebook>;
  onSavedNotebook: (notebook: Notebook) => void;
  onRequestDeleteNotebook: (target: Notebook) => void;
  onCloseConfirm: () => void;
  onCloseSplitPicker: () => void;
  onSelectSplitNote: (noteId: string) => void;
  onDismissNotice: () => void;
  onPauseNotice: (paused: boolean, source: NoticePauseSource) => void;
};

/** Renders workspace command palette, modal dialogs, notices, and context menu overlays. */
export function WorkspaceDialogs({
  isMobileViewport,
  commandOpen,
  commandInitialQuery,
  commandNoteReady,
  renderedNote,
  notebooks,
  focusMode,
  autoReadingMode,
  splitNoteId,
  typewriterMode,
  viewLayout,
  pwaState,
  themePreference,
  imageExportSnapshot,
  editingNotebook,
  confirmRequest,
  splitPickerOpen,
  notes,
  selectedId,
  notice,
  offline,
  workspaceMenu,
  onCloseCommandMenu,
  onCommand,
  onCreateNoteInNotebook,
  onMoveCurrentNoteToNotebook,
  onSearchInCurrentNote,
  onReplaceInCurrentNote,
  onSearchGlobal,
  onCloseImageExport,
  onCloseNotebookDialog,
  onSaveNotebookDraft,
  onSavedNotebook,
  onRequestDeleteNotebook,
  onCloseConfirm,
  onCloseSplitPicker,
  onSelectSplitNote,
  onDismissNotice,
  onPauseNotice,
}: WorkspaceDialogsProps) {
  return (
    <>
      <CommandMenu
        isMobileViewport={isMobileViewport}
        open={commandOpen}
        onClose={onCloseCommandMenu}
        onCommand={onCommand}
        onCreateNoteInNotebook={onCreateNoteInNotebook}
        canRestore={Boolean(commandNoteReady && renderedNote?.deletedAt)}
        canMoveToTrash={Boolean(commandNoteReady && renderedNote && !renderedNote.deletedAt)}
        notebooks={notebooks}
        currentNotebookId={renderedNote?.notebookId}
        onMoveNoteToNotebook={onMoveCurrentNoteToNotebook}
        focusMode={focusMode}
        autoReadingMode={autoReadingMode}
        canAutoRead={!splitNoteId}
        typewriterMode={typewriterMode}
        viewLayout={isMobileViewport ? "three-column" : viewLayout}
        isSplitActive={Boolean(splitNoteId && !isMobileViewport)}
        canInstallApp={pwaState.canInstall}
        showIosInstallHint={pwaState.showIosInstallHint}
        standalone={pwaState.standalone}
        hasSelectedNote={commandNoteReady}
        onSearchInCurrentNote={onSearchInCurrentNote}
        onReplaceInCurrentNote={onReplaceInCurrentNote}
        onSearchGlobal={onSearchGlobal}
        initialQuery={commandInitialQuery}
        themePreference={themePreference}
      />

      {imageExportSnapshot && (
        <Suspense fallback={null}>
          <LazyImageExportDialog snapshot={imageExportSnapshot} onClose={onCloseImageExport} />
        </Suspense>
      )}
      {editingNotebook !== undefined && (
        <NotebookDialog
          key={editingNotebook?.id ?? "new"}
          notebook={editingNotebook}
          onClose={onCloseNotebookDialog}
          onSave={onSaveNotebookDraft}
          onSaved={onSavedNotebook}
          onRequestDelete={onRequestDeleteNotebook}
        />
      )}
      {confirmRequest && (
        <ConfirmDialog key={confirmRequest.id} request={confirmRequest} onClose={onCloseConfirm} />
      )}
      <SplitNoteDialog
        open={splitPickerOpen}
        onClose={onCloseSplitPicker}
        onSelectNote={onSelectSplitNote}
        notes={notes}
        excludeNoteId={selectedId}
      />
      <SystemNotices
        notice={notice}
        offline={offline}
        onDismiss={onDismissNotice}
        onPause={onPauseNotice}
      />
      {workspaceMenu}
    </>
  );
}
