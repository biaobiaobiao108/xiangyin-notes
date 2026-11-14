import { useCallback, useEffect, useRef, useState } from "react";
import type { Notebook } from "../../shared/types";
import { api } from "../api";
import { errorMessage } from "./helpers";

type UseWorkspaceNotebookDataOptions = {
  trashOperationsRef: { current: Set<string> };
  emptyingTrashRef: { current: boolean };
  notifyError: (message: string) => void;
};

export function useWorkspaceNotebookData({
  trashOperationsRef,
  emptyingTrashRef,
  notifyError,
}: UseWorkspaceNotebookDataOptions) {
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const notebooksRequestRef = useRef(0);
  const reorderBusyRef = useRef(false);
  const [reorderingNotebooks, setReorderingNotebooks] = useState(false);

  const invalidateNotebookRequests = useCallback(() => {
    notebooksRequestRef.current += 1;
  }, []);

  useEffect(() => () => invalidateNotebookRequests(), [invalidateNotebookRequests]);

  const refreshNotebooks = useCallback(async () => {
    const requestId = ++notebooksRequestRef.current;
    try {
      const result = await api.listNotebooks();
      if (
        requestId === notebooksRequestRef.current &&
        !reorderBusyRef.current &&
        !trashOperationsRef.current.size &&
        !emptyingTrashRef.current
      ) {
        setNotebooks(result.notebooks);
      }
    } catch {
      // Keep the current list visible until the next request succeeds.
    }
  }, []);

  const handleReorderNotebooks = useCallback(
    async (ids: string[], expectedIds: string[]) => {
      if (reorderBusyRef.current) return;
      reorderBusyRef.current = true;
      setReorderingNotebooks(true);
      ++notebooksRequestRef.current;
      try {
        await api.reorderNotebooks(ids, expectedIds);
        setNotebooks((current) => {
          const rank = new Map(ids.map((id, index) => [id, index]));
          return [...current].sort((a, b) =>
            a.isSystem
              ? -1
              : b.isSystem
                ? 1
                : (rank.get(a.id) ?? ids.length) - (rank.get(b.id) ?? ids.length),
          );
        });
      } catch (error) {
        notifyError(errorMessage(error, "保存笔记本顺序失败，请重试"));
      } finally {
        reorderBusyRef.current = false;
        setReorderingNotebooks(false);
        void refreshNotebooks();
      }
    },
    [notifyError, refreshNotebooks],
  );

  return {
    notebooks,
    setNotebooks,
    reorderingNotebooks,
    refreshNotebooks,
    handleReorderNotebooks,
    invalidateNotebookRequests,
  };
}
