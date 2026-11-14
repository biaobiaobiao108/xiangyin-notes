import type { MouseEvent as ReactMouseEvent, MutableRefObject } from "react";
import {
  ArrowUpRight,
  CheckCircle2,
  Clock,
  Inbox,
  Plus,
  Settings2,
  Star,
  Trash2,
  X,
} from "lucide-react";
import type { KanbanStatus, NoteSummary, NoteView, Notebook } from "../../shared/types";
import type { CreateNoteCommand } from "../command-parser";
import { textFieldMenuItems, type ContextMenuItem } from "../context-menu";
import { calculateTargetSortOrder } from "./kanban-drag";
import type { KanbanColumnData } from "./kanban-panel";
import { buildNoteContextMenuItems, buildWorkspaceMenuItems } from "./note-context-menu";
import type { NoteSwipeAction } from "./swipe-actions";
import { viewLabel } from "./helpers";

type ViewLayout = "three-column" | "cards";

type WorkspaceContextMenuOptions = {
  openWorkspaceMenu: (
    event: ReactMouseEvent<HTMLElement>,
    items: ContextMenuItem[],
    label?: string,
  ) => void;
  searchRef: MutableRefObject<HTMLInputElement | null>;
  changeQuery: (query: string) => void;
  openKanbanNote: (noteId: string) => void;
  handleToggleFavoriteKanbanCard: (note: NoteSummary) => void;
  kanbanColumnsRef: MutableRefObject<Record<KanbanStatus, KanbanColumnData>>;
  handleMoveKanbanCard: (
    noteId: string,
    status: KanbanStatus,
    sortOrder: number,
  ) => void | Promise<void>;
  handleRemoveKanbanCard: (noteId: string) => void;
  handleTrashKanbanCard: (noteId: string) => void;
  handleCreateNoteInKanbanColumn: (status: KanbanStatus) => void;
  notesRef: MutableRefObject<NoteSummary[]>;
  pendingTrashCount: number;
  emptyingTrash: boolean;
  view: NoteView;
  selectedNoteIds: ReadonlySet<string>;
  clearNoteSelection: () => void;
  viewLayout: ViewLayout;
  handleOpenCardNote: (noteId: string) => void;
  selectNote: (noteId: string) => void;
  isMobileViewport: boolean;
  openInSplit: (noteId: string) => void;
  handleToggleCardSelection: (noteId: string, modifiers: { ctrlKey: boolean }) => void;
  handleNoteSwipeAction: (note: NoteSummary, action: NoteSwipeAction) => void;
  restoreSelectedNotes: () => void;
  deleteSelectedNotes: () => void;
  handleToggleFavoriteNote: (note: NoteSummary) => void;
  handleAddExistingNoteToKanban: (noteId: string, status: KanbanStatus) => void;
  notebooks: Notebook[];
  selectNotebook: (notebookId: string) => void;
  createNoteInNotebook: (input: CreateNoteCommand) => void;
  handleEditNotebook: (notebook: Notebook) => void;
  handleDeleteNotebook: (notebook: Notebook) => void;
  sidebarCollapsed: boolean;
  handleNewInboxNote: () => void;
  handleCreateNotebook: () => void;
  selectView: (view: NoteView) => void;
  handleCollapseSidebar: () => void;
  closeOutline: () => void;
  query: string;
  totalNotes: number;
  handleNewNote: () => void;
  toggleViewLayout: () => void;
  handleClearQuery: () => void;
  emptyTrash: () => void;
};

export function createWorkspaceContextMenuHandler({
  openWorkspaceMenu,
  searchRef,
  changeQuery,
  openKanbanNote,
  handleToggleFavoriteKanbanCard,
  kanbanColumnsRef,
  handleMoveKanbanCard,
  handleRemoveKanbanCard,
  handleTrashKanbanCard,
  handleCreateNoteInKanbanColumn,
  notesRef,
  pendingTrashCount,
  emptyingTrash,
  view,
  selectedNoteIds,
  clearNoteSelection,
  viewLayout,
  handleOpenCardNote,
  selectNote,
  isMobileViewport,
  openInSplit,
  handleToggleCardSelection,
  handleNoteSwipeAction,
  restoreSelectedNotes,
  deleteSelectedNotes,
  handleToggleFavoriteNote,
  handleAddExistingNoteToKanban,
  notebooks,
  selectNotebook,
  createNoteInNotebook,
  handleEditNotebook,
  handleDeleteNotebook,
  sidebarCollapsed,
  handleNewInboxNote,
  handleCreateNotebook,
  selectView,
  handleCollapseSidebar,
  closeOutline,
  query,
  totalNotes,
  handleNewNote,
  toggleViewLayout,
  handleClearQuery,
  emptyTrash,
}: WorkspaceContextMenuOptions) {
  return (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target === searchRef.current) {
      openWorkspaceMenu(event, textFieldMenuItems(target, changeQuery), "搜索文本");
      return;
    }
    if (
      !(target instanceof Element) ||
      target.closest("dialog, input, textarea, [contenteditable='true'], .editor-panel, .memo-page")
    )
      return;
    if (target.closest(".tasks-panel")) {
      event.preventDefault();
      return;
    }
    if (target.closest(".kanban-panel")) {
      const noteId = target.closest<HTMLElement>("[data-kanban-note-id]")?.dataset.kanbanNoteId;
      const kanbanCard = noteId
        ? (["inbox", "doing", "done"] as const)
            .flatMap((status) => kanbanColumnsRef.current[status].cards)
            .find((card) => card.noteId === noteId)
        : undefined;
      if (kanbanCard) {
        const items: ContextMenuItem[] = [
          {
            label: "打开笔记",
            icon: ArrowUpRight,
            onSelect: () => openKanbanNote(kanbanCard.noteId),
          },
          {
            label: kanbanCard.note.isFavorite ? "取消收藏" : "收藏笔记",
            icon: Star,
            onSelect: () => handleToggleFavoriteKanbanCard(kanbanCard.note),
          },
          ...(
            [
              { id: "inbox", title: "收集箱", icon: Inbox },
              { id: "doing", title: "进行中", icon: Clock },
              { id: "done", title: "已完成", icon: CheckCircle2 },
            ] as const
          )
            .filter((column) => column.id !== kanbanCard.status)
            .map((column) => ({
              label: `移到${column.title}`,
              icon: column.icon,
              onSelect: () => {
                const cards = kanbanColumnsRef.current[column.id].cards;
                void handleMoveKanbanCard(
                  kanbanCard.noteId,
                  column.id,
                  calculateTargetSortOrder(cards, 0, kanbanCard.noteId),
                );
              },
            })),
          {
            label: "从看板移出",
            icon: X,
            separator: true,
            onSelect: () => handleRemoveKanbanCard(kanbanCard.noteId),
          },
          {
            label: "移入回收站",
            icon: Trash2,
            danger: true,
            separator: true,
            onSelect: () => handleTrashKanbanCard(kanbanCard.noteId),
          },
        ];
        openWorkspaceMenu(event, items, kanbanCard.note.title.trim() || "未命名笔记");
        if (!event.defaultPrevented) event.preventDefault();
        return;
      }

      const columnElement = target.closest<HTMLElement>("[data-kanban-status]");
      const status = columnElement?.dataset.kanbanStatus as KanbanStatus | undefined;
      if (status === "inbox" || status === "doing" || status === "done") {
        const title = { inbox: "收集箱", doing: "进行中", done: "已完成" }[status];
        openWorkspaceMenu(
          event,
          [
            {
              label: `在${title}新建笔记`,
              icon: Plus,
              onSelect: () => handleCreateNoteInKanbanColumn(status),
            },
          ],
          `${title}列`,
        );
        if (!event.defaultPrevented) event.preventDefault();
        return;
      }

      openWorkspaceMenu(
        event,
        [
          {
            label: "在收集箱新建笔记",
            icon: Plus,
            onSelect: () => handleCreateNoteInKanbanColumn("inbox"),
          },
        ],
        "看板",
      );
      if (!event.defaultPrevented) event.preventDefault();
      return;
    }
    const noteId = target.closest<HTMLElement>("[data-note-id]")?.dataset.noteId;
    const targetNote = noteId ? notesRef.current.find((note) => note.id === noteId) : undefined;
    if (targetNote) {
      const busy = pendingTrashCount > 0 || emptyingTrash;
      openWorkspaceMenu(
        event,
        buildNoteContextMenuItems({
          note: targetNote,
          view,
          selectedIds: selectedNoteIds,
          busy,
          actions: {
            clearSelection: clearNoteSelection,
            openNote: (note) => {
              if (viewLayout === "cards") handleOpenCardNote(note.id);
              else selectNote(note.id);
            },
            openInSplit:
              !isMobileViewport && viewLayout === "cards"
                ? (note) => openInSplit(note.id)
                : undefined,
            toggleSelection: (noteId) => handleToggleCardSelection(noteId, { ctrlKey: true }),
            swipeAction: handleNoteSwipeAction,
            restoreSelected: restoreSelectedNotes,
            deleteSelected: deleteSelectedNotes,
            toggleFavorite: handleToggleFavoriteNote,
            addToKanban: (note, status) => {
              void handleAddExistingNoteToKanban(note.id, status);
            },
          },
        }),
        targetNote.title || "未命名笔记",
      );
      return;
    }
    const targetNotebookId = target.closest<HTMLElement>("[data-notebook-id]")?.dataset.notebookId;
    const targetNotebook = notebooks.find((notebook) => notebook.id === targetNotebookId);
    if (targetNotebook) {
      openWorkspaceMenu(
        event,
        [
          {
            label: "打开笔记本",
            icon: ArrowUpRight,
            onSelect: () => selectNotebook(targetNotebook.id),
          },
          {
            label: "在此新建笔记",
            icon: Plus,
            onSelect: () =>
              createNoteInNotebook({
                notebookId: targetNotebook.id,
                notebookName: targetNotebook.name,
                title: "未命名笔记",
              }),
          },
          {
            label: "笔记本设置",
            icon: Settings2,
            separator: true,
            onSelect: () => handleEditNotebook(targetNotebook),
          },
          ...(!targetNotebook.isSystem
            ? [
                {
                  label: "删除笔记本",
                  icon: Trash2,
                  danger: true,
                  separator: true,
                  onSelect: () => handleDeleteNotebook(targetNotebook),
                },
              ]
            : []),
        ],
        targetNotebook.name,
      );
      return;
    }
    if (target.closest(".sidebar")) {
      const targetView = target.closest<HTMLElement>("[data-note-view]")?.dataset.noteView as
        NoteView | undefined;
      const items: ContextMenuItem[] = [];
      if (targetView)
        items.push({
          label: `打开${viewLabel(targetView)}`,
          icon: ArrowUpRight,
          onSelect: () => selectView(targetView),
        });
      items.push(
        { label: "新建笔记", icon: Plus, onSelect: handleNewInboxNote },
        { label: "新建笔记本", icon: Plus, onSelect: handleCreateNotebook },
        {
          label: sidebarCollapsed ? "展开侧栏" : "收起侧栏",
          icon: Settings2,
          separator: true,
          onSelect: handleCollapseSidebar,
        },
      );
      openWorkspaceMenu(event, items, "导航");
      return;
    }
    if (target.closest(".note-list-panel, .note-card-grid-panel, .empty-editor")) {
      if (target.closest(".note-outline-panel")) {
        openWorkspaceMenu(
          event,
          [{ label: "关闭大纲", icon: X, onSelect: closeOutline }],
          "笔记大纲",
        );
        return;
      }
      openWorkspaceMenu(
        event,
        buildWorkspaceMenuItems({
          view,
          viewLayout,
          canToggleLayout: !isMobileViewport,
          query,
          hasSelection: selectedNoteIds.size > 0,
          totalNotes,
          busy: pendingTrashCount > 0 || emptyingTrash,
          actions: {
            newNote: handleNewNote,
            toggleLayout: toggleViewLayout,
            clearQuery: handleClearQuery,
            clearSelection: clearNoteSelection,
            emptyTrash,
          },
        }),
        "笔记工作区",
      );
    }
  };
}
