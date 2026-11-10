import { useCallback, useEffect, useRef, useState } from "react";
import type { KanbanStatus } from "../../shared/types";
import { api } from "../api";
import type { KanbanColumnData } from "./kanban-panel";

const KANBAN_PAGE_SIZE = 30;

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

export function useWorkspaceKanbanData(
  kanbanOpen: boolean,
  notifyError: (message: string) => void,
) {
  const [kanbanColumns, setKanbanColumns] = useState<Record<KanbanStatus, KanbanColumnData>>({
    inbox: emptyColumn(),
    doing: emptyColumn(),
    done: emptyColumn(),
  });
  const kanbanColumnsRef = useRef(kanbanColumns);
  kanbanColumnsRef.current = kanbanColumns;
  const [kanbanLoading, setKanbanLoading] = useState(false);
  const [kanbanRefreshToken, setKanbanRefreshToken] = useState(0);

  useEffect(() => {
    if (!kanbanOpen) return;
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
        if (controller.signal.aborted) return;
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
    return () => controller.abort();
  }, [kanbanOpen, kanbanRefreshToken, notifyError]);

  const loadMoreKanbanColumn = useCallback(
    async (status: KanbanStatus) => {
      const column = kanbanColumnsRef.current[status];
      if (!column || column.isLoadingMore || !column.hasMore || !column.nextCursor) return;

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

        setKanbanColumns((previous) => {
          const currentColumn = previous[status];
          const existingIds = new Set(currentColumn.cards.map((card) => card.noteId));
          const newCards = result.cards.filter((card) => !existingIds.has(card.noteId));
          return {
            ...previous,
            [status]: {
              ...currentColumn,
              cards: [...currentColumn.cards, ...newCards],
              total: result.total,
              hasMore: result.hasMore,
              nextCursor: result.nextCursor,
              isLoadingMore: false,
              loadMoreError: null,
            },
          };
        });
      } catch {
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

  return {
    kanbanColumns,
    setKanbanColumns,
    kanbanColumnsRef,
    kanbanLoading,
    kanbanRefreshToken,
    setKanbanRefreshToken,
    loadMoreKanbanColumn,
  };
}
