import { useCallback, useEffect, useRef, useState } from "react";
import type {
  KanbanCard,
  KanbanPlacement,
  KanbanStatus,
  NoteSummary,
  Notebook,
} from "../../shared/types";
import { api, ApiError } from "../api";
import type { KanbanColumnData } from "./kanban-panel";

const KANBAN_PAGE_SIZE = 30;

function compareKanbanCards(left: KanbanCard, right: KanbanCard) {
  return (
    left.sortOrder - right.sortOrder ||
    right.updatedAt - left.updatedAt ||
    Number(left.noteId > right.noteId) - Number(left.noteId < right.noteId)
  );
}

function emptyColumn(): KanbanColumnData {
  return {
    cards: [],
    total: 0,
    hasMore: false,
    nextCursor: null,
    isLoadingMore: false,
    loadMoreError: null,
  };
}

type UseWorkspaceKanbanDataOptions = {
  kanbanOpen: boolean;
  notebooks: Notebook[];
  notifyError: (message: string) => void;
  notifyInfo: (message: string) => void;
  refreshNotebooks: () => Promise<unknown>;
  onTrashCard: (note: NoteSummary) => Promise<void>;
  onToggleFavoriteNote: (note: NoteSummary) => Promise<void>;
};

export function useWorkspaceKanbanData({
  kanbanOpen,
  notebooks,
  notifyError,
  notifyInfo,
  refreshNotebooks,
  onTrashCard,
  onToggleFavoriteNote,
}: UseWorkspaceKanbanDataOptions) {
  const [kanbanColumns, setKanbanColumns] = useState<Record<KanbanStatus, KanbanColumnData>>({
    inbox: emptyColumn(),
    doing: emptyColumn(),
    done: emptyColumn(),
  });
  const kanbanColumnsRef = useRef(kanbanColumns);
  kanbanColumnsRef.current = kanbanColumns;
  const [kanbanLoading, setKanbanLoading] = useState(false);
  const [kanbanRefreshToken, setKanbanRefreshToken] = useState(0);
  const requestGenerationRef = useRef(0);

  useEffect(() => {
    if (!kanbanOpen) return;
    const generation = ++requestGenerationRef.current;
    const controller = new AbortController();
    setKanbanLoading(true);
    const statuses: KanbanStatus[] = ["inbox", "doing", "done"];
    Promise.all(
      statuses.map((status) =>
        api.listKanbanCards(
          {
            status,
            limit: KANBAN_PAGE_SIZE,
          },
          { signal: controller.signal },
        ),
      ),
    )
      .then(([inboxRes, doingRes, doneRes]) => {
        if (controller.signal.aborted || generation !== requestGenerationRef.current) return;
        setKanbanColumns({
          inbox: {
            cards: inboxRes.cards,
            total: inboxRes.total,
            hasMore: inboxRes.hasMore,
            nextCursor: inboxRes.nextCursor,
            isLoadingMore: false,
            loadMoreError: null,
          },
          doing: {
            cards: doingRes.cards,
            total: doingRes.total,
            hasMore: doingRes.hasMore,
            nextCursor: doingRes.nextCursor,
            isLoadingMore: false,
            loadMoreError: null,
          },
          done: {
            cards: doneRes.cards,
            total: doneRes.total,
            hasMore: doneRes.hasMore,
            nextCursor: doneRes.nextCursor,
            isLoadingMore: false,
            loadMoreError: null,
          },
        });
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === "AbortError") return;
        if (controller.signal.aborted) return;
        notifyError("加载看板数据失败，请重试");
      })
      .finally(() => {
        if (!controller.signal.aborted) setKanbanLoading(false);
      });
    return () => {
      requestGenerationRef.current++;
      controller.abort();
    };
  }, [kanbanOpen, kanbanRefreshToken, notifyError]);

  const loadMoreKanbanColumn = useCallback(
    async (status: KanbanStatus) => {
      const column = kanbanColumnsRef.current[status];
      if (!column || column.isLoadingMore || !column.hasMore || !column.nextCursor) return;
      const generation = requestGenerationRef.current;

      setKanbanColumns((previous) => ({
        ...previous,
        [status]: {
          ...previous[status],
          isLoadingMore: true,
          loadMoreError: null,
        },
      }));

      try {
        const result = await api.listKanbanCards({
          status,
          limit: KANBAN_PAGE_SIZE,
          cursor: column.nextCursor,
        });
        if (generation !== requestGenerationRef.current) return;

        setKanbanColumns((previous) => {
          const currentColumn = previous[status];
          const existingIds = new Set(currentColumn.cards.map((card) => card.noteId));
          const newCards = result.cards.filter((card) => !existingIds.has(card.noteId));
          return {
            ...previous,
            [status]: {
              ...currentColumn,
              cards: [...currentColumn.cards, ...newCards].sort(compareKanbanCards),
              total: result.total,
              hasMore: result.hasMore,
              nextCursor: result.nextCursor,
              isLoadingMore: false,
              loadMoreError: null,
            },
          };
        });
      } catch {
        if (generation !== requestGenerationRef.current) return;
        notifyError(
          `加载更多${status === "inbox" ? "收集箱" : status === "doing" ? "进行中" : "已完成"}卡片失败`,
        );
        setKanbanColumns((previous) => ({
          ...previous,
          [status]: {
            ...previous[status],
            isLoadingMore: false,
            loadMoreError: "加载失败",
          },
        }));
      }
    },
    [notifyError],
  );

  const handleMoveCard = useCallback(
    async (noteId: string, targetStatus: KanbanStatus, placement: KanbanPlacement) => {
      const card = Object.values(kanbanColumnsRef.current)
        .flatMap((column) => column.cards)
        .find((card) => card.noteId === noteId);
      if (!card) {
        notifyError("卡片状态已变化，请刷新后重试");
        setKanbanRefreshToken((value) => value + 1);
        return;
      }

      const sourceStatus = card.status;
      const generation = requestGenerationRef.current;
      try {
        const result = await api.updateKanbanCard(noteId, {
          status: targetStatus,
          expectedUpdatedAt: card.updatedAt,
          ...placement,
        });
        const columns = kanbanColumnsRef.current;
        if (
          result.reordered ||
          generation !== requestGenerationRef.current ||
          columns[sourceStatus].isLoadingMore ||
          columns[targetStatus].isLoadingMore
        ) {
          setKanbanRefreshToken((value) => value + 1);
          return;
        }
        setKanbanColumns((previous) => {
          const source = previous[sourceStatus];
          const current = source.cards.find((item) => item.noteId === noteId);
          if (current?.updatedAt !== card.updatedAt) return previous;

          const destination = previous[targetStatus];
          const destinationCards = destination.cards.filter((item) => item.noteId !== noteId);
          const cards = [...destinationCards, result.card].sort(compareKanbanCards);
          if (sourceStatus === targetStatus) {
            return { ...previous, [targetStatus]: { ...destination, cards } };
          }
          return {
            ...previous,
            [sourceStatus]: {
              ...source,
              cards: source.cards.filter((item) => item.noteId !== noteId),
              total: Math.max(0, source.total - 1),
            },
            [targetStatus]: { ...destination, cards, total: destination.total + 1 },
          };
        });
      } catch (error) {
        const conflict = error instanceof ApiError && error.status === 409;
        notifyError(conflict ? "卡片或排序位置已变化，正在刷新看板" : "更新卡片状态失败");
        setKanbanRefreshToken((value) => value + 1);
      }
    },
    [notifyError],
  );

  const handleRemoveCard = useCallback(
    async (noteId: string) => {
      const card = Object.values(kanbanColumnsRef.current)
        .flatMap((column) => column.cards)
        .find((item) => item.noteId === noteId);
      if (!card) return;
      setKanbanColumns((previous) => {
        let changed = false;
        const next = { ...previous };
        for (const status of ["inbox", "doing", "done"] as const) {
          if (next[status].cards.some((card) => card.noteId === noteId)) {
            next[status] = {
              ...next[status],
              cards: next[status].cards.filter((card) => card.noteId !== noteId),
              total: Math.max(0, next[status].total - 1),
            };
            changed = true;
          }
        }
        return changed ? next : previous;
      });
      try {
        await api.deleteKanbanCard(noteId, card.updatedAt);
        notifyInfo("已从看板移出");
      } catch {
        notifyError("移出卡片失败");
        setKanbanRefreshToken((value) => value + 1);
      }
    },
    [notifyError, notifyInfo],
  );

  const handleTrashCard = useCallback(
    async (noteId: string) => {
      const card = (["inbox", "doing", "done"] as const)
        .flatMap((status) => kanbanColumnsRef.current[status].cards)
        .find((candidate) => candidate.noteId === noteId);
      if (!card) return;

      setKanbanColumns((previous) => {
        let changed = false;
        const next = { ...previous };
        for (const status of ["inbox", "doing", "done"] as const) {
          if (next[status].cards.some((card) => card.noteId === noteId)) {
            next[status] = {
              ...next[status],
              cards: next[status].cards.filter((card) => card.noteId !== noteId),
              total: Math.max(0, next[status].total - 1),
            };
            changed = true;
          }
        }
        return changed ? next : previous;
      });
      try {
        await onTrashCard(card.note);
        notifyInfo("已移入回收站");
      } catch {
        notifyError("移入回收站失败，请重试");
        setKanbanRefreshToken((value) => value + 1);
      }
    },
    [notifyError, notifyInfo, onTrashCard],
  );

  const handleCreateNoteInColumn = useCallback(
    async (status: KanbanStatus) => {
      const targetNotebookId = (notebooks.find((notebook) => notebook.isSystem) ?? notebooks[0])
        ?.id;
      if (!targetNotebookId) {
        notifyError("未找到可用笔记本");
        return;
      }
      try {
        await api.createNote({
          notebookId: targetNotebookId,
          title: "未命名笔记",
          contentMarkdown: "",
          kanbanStatus: status,
        });
        setKanbanRefreshToken((value) => value + 1);
        void refreshNotebooks();
        notifyInfo("已新建笔记并加入看板");
      } catch {
        notifyError("新建卡片失败");
      }
    },
    [notebooks, notifyError, notifyInfo, refreshNotebooks],
  );

  const handleAddExistingNote = useCallback(
    async (noteId: string, status: KanbanStatus) => {
      try {
        await api.addKanbanCard({ noteId, status });
        setKanbanRefreshToken((value) => value + 1);
        notifyInfo("已添加到看板");
      } catch {
        notifyError("添加到看板失败");
      }
    },
    [notifyError, notifyInfo],
  );

  const handleToggleFavoriteCard = useCallback(
    async (target: NoteSummary) => {
      await onToggleFavoriteNote(target);
      setKanbanRefreshToken((value) => value + 1);
    },
    [onToggleFavoriteNote],
  );

  return {
    kanbanColumns,
    setKanbanColumns,
    kanbanColumnsRef,
    kanbanLoading,
    kanbanRefreshToken,
    setKanbanRefreshToken,
    loadMoreKanbanColumn,
    handleMoveCard,
    handleRemoveCard,
    handleTrashCard,
    handleCreateNoteInColumn,
    handleAddExistingNote,
    handleToggleFavoriteCard,
  };
}
