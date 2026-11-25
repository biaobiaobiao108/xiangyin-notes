import { lazy, Suspense, type Dispatch, type SetStateAction } from "react";
import type {
  KanbanPlacement,
  KanbanStatus,
  Note,
  NoteSummary,
  NoteView,
  Notebook,
  TaskSummary,
} from "../../shared/types";
import type { KanbanColumnData } from "./kanban-panel";
import { MobileNotebookHome } from "./mobile-panels";
import { NoteLoadingState } from "./panels";
import {
  shouldShowKanbanPanel,
  shouldShowMemoPage,
  shouldShowTasksPanel,
  type MobilePage,
} from "./use-mobile-navigation";

const LazyMemoPage = lazy(() =>
  import("../memos/memo-page").then(({ MemoPage }) => ({ default: MemoPage })),
);

const LazyTasksPanel = lazy(() =>
  import("./tasks-panel").then(({ TasksPanel }) => ({ default: TasksPanel })),
);

const LazyKanbanPanel = lazy(() =>
  import("./kanban-panel").then(({ KanbanPanel }) => ({ default: KanbanPanel })),
);

export type WorkspaceCollectionsProps = {
  isMobileViewport: boolean;
  mobilePage: MobilePage;
  memosOpen: boolean;
  tasksOpen: boolean;
  kanbanOpen: boolean;
  view: NoteView;
  notebooks: Notebook[];
  notebookId: string | undefined;
  reorderingNotebooks: boolean;
  notes: NoteSummary[];
  tasks: TaskSummary[];
  tasksTotal: number;
  hasMoreTasks: boolean;
  tasksMoreLoading: boolean;
  tasksMoreError: string | null;
  taskNotebookId: string;
  taskStatus: "open" | "done" | "all";
  tasksLoading: boolean;
  busyTasks: ReadonlyMap<string, number>;
  tasksError: string | null;
  kanbanColumns: Record<KanbanStatus, KanbanColumnData>;
  kanbanLoading: boolean;
  onReorderNotebooks: (ids: string[], expectedIds: string[]) => Promise<void>;
  onSelectView: (view: NoteView) => void;
  onSelectNotebook: (id: string) => void;
  onCreateNotebook: () => void;
  onEditNotebook: (notebook: Notebook) => void;
  onDeleteNotebook: (notebook: Notebook) => void;
  onLogout: () => void;
  onOpenTasks: () => void;
  onOpenMemos: () => void;
  onOpenKanban: () => void;
  onBackMobilePage: () => void;
  onMemoConverted: (note: Note) => void;
  onRetryTasks: () => void;
  onTaskNotebookChange: Dispatch<SetStateAction<string>>;
  onTaskStatusChange: Dispatch<SetStateAction<"open" | "done" | "all">>;
  onSelectTask: (task: TaskSummary) => void;
  onToggleTask: (task: TaskSummary) => void;
  onLoadMoreTasks: () => void;
  onOpenKanbanNote: (noteId: string) => void;
  onCreateKanbanNote: (status: KanbanStatus) => void;
  onAddExistingKanbanNote: (noteId: string, status: KanbanStatus) => void;
  onMoveKanbanCard: (
    noteId: string,
    targetStatus: KanbanStatus,
    placement: KanbanPlacement,
  ) => void;
  onTrashKanbanCard: (noteId: string) => void;
  onLoadMoreKanbanColumn: (status: KanbanStatus) => void;
  onToggleFavoriteKanbanCard: (target: NoteSummary) => void;
};

/** Renders standalone collection surfaces: mobile home, memos, tasks, and kanban. */
export function WorkspaceCollections({
  isMobileViewport,
  mobilePage,
  memosOpen,
  tasksOpen,
  kanbanOpen,
  view,
  notebooks,
  notebookId,
  reorderingNotebooks,
  notes,
  tasks,
  tasksTotal,
  hasMoreTasks,
  tasksMoreLoading,
  tasksMoreError,
  taskNotebookId,
  taskStatus,
  tasksLoading,
  busyTasks,
  tasksError,
  kanbanColumns,
  kanbanLoading,
  onReorderNotebooks,
  onSelectView,
  onSelectNotebook,
  onCreateNotebook,
  onEditNotebook,
  onDeleteNotebook,
  onLogout,
  onOpenTasks,
  onOpenMemos,
  onOpenKanban,
  onBackMobilePage,
  onMemoConverted,
  onRetryTasks,
  onTaskNotebookChange,
  onTaskStatusChange,
  onSelectTask,
  onToggleTask,
  onLoadMoreTasks,
  onOpenKanbanNote,
  onCreateKanbanNote,
  onAddExistingKanbanNote,
  onMoveKanbanCard,
  onTrashKanbanCard,
  onLoadMoreKanbanColumn,
  onToggleFavoriteKanbanCard,
}: WorkspaceCollectionsProps) {
  return (
    <>
      {isMobileViewport && (
        <div
          className="mobile-home-region"
          hidden={mobilePage !== "home" || tasksOpen || kanbanOpen || memosOpen}
          inert={mobilePage !== "home" || tasksOpen || kanbanOpen || memosOpen}
        >
          <MobileNotebookHome
            onReorderNotebooks={onReorderNotebooks}
            reorderingNotebooks={reorderingNotebooks}
            view={view}
            setView={onSelectView}
            notebooks={notebooks}
            notebookId={notebookId}
            setNotebookId={onSelectNotebook}
            onCreateNotebook={onCreateNotebook}
            onEditNotebook={onEditNotebook}
            onDeleteNotebook={onDeleteNotebook}
            onLogout={onLogout}
            onOpenTasks={onOpenTasks}
            onOpenMemo={onOpenMemos}
            onOpenKanban={onOpenKanban}
            active={mobilePage === "home"}
          />
        </div>
      )}
      {shouldShowMemoPage(memosOpen, isMobileViewport, mobilePage) && (
        <Suspense fallback={<NoteLoadingState />}>
          <LazyMemoPage
            isMobileViewport={isMobileViewport}
            onBack={isMobileViewport ? onBackMobilePage : undefined}
            onConverted={onMemoConverted}
          />
        </Suspense>
      )}
      {shouldShowTasksPanel(tasksOpen, isMobileViewport, mobilePage) && (
        <Suspense fallback={<NoteLoadingState panel="任务" />}>
          <LazyTasksPanel
            tasks={tasks}
            total={tasksTotal}
            hasMore={hasMoreTasks}
            loadingMore={tasksMoreLoading}
            loadMoreError={tasksMoreError}
            notebooks={notebooks}
            notebookId={taskNotebookId}
            status={taskStatus}
            loading={tasksLoading}
            busyTasks={busyTasks}
            error={tasksError}
            onRetry={onRetryTasks}
            onNotebookChange={onTaskNotebookChange}
            onStatusChange={onTaskStatusChange}
            onSelectTask={onSelectTask}
            onToggleTask={onToggleTask}
            onLoadMore={onLoadMoreTasks}
            onBack={isMobileViewport ? onBackMobilePage : undefined}
          />
        </Suspense>
      )}
      {shouldShowKanbanPanel(kanbanOpen, isMobileViewport, mobilePage) && (
        <Suspense fallback={<NoteLoadingState panel="看板" />}>
          <LazyKanbanPanel
            columns={kanbanColumns}
            loading={kanbanLoading}
            onOpenNote={onOpenKanbanNote}
            onCreateNoteInColumn={onCreateKanbanNote}
            onAddExistingNote={onAddExistingKanbanNote}
            onMoveCard={onMoveKanbanCard}
            onTrashCard={onTrashKanbanCard}
            onLoadMoreColumn={onLoadMoreKanbanColumn}
            onToggleFavorite={onToggleFavoriteKanbanCard}
            onBack={isMobileViewport ? onBackMobilePage : undefined}
            isMobileViewport={isMobileViewport}
            availableNotes={notes}
          />
        </Suspense>
      )}
    </>
  );
}
