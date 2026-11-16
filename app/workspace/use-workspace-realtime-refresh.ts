import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { WorkspaceChangeMessage } from "../../shared/realtime";
import {
  accumulateRealtimeRefresh,
  emptyRealtimeRefreshPlan,
  type RealtimeRefreshPlan,
} from "./realtime-refresh";
import { useWorkspaceRealtime } from "./use-realtime";
type Ref<T> = { current: T };
type Setter<T> = Dispatch<SetStateAction<T>>;
export function useWorkspaceRealtimeRefresh({
  ready,
  pendingRealtimeRefreshRef,
  realtimeRefreshTimerRef,
  deferredQuery,
  memosOpen,
  tasksOpen,
  kanbanOpen,
  setMemoRefreshToken,
  setTaskRefreshToken,
  setKanbanRefreshToken,
  refreshNotebooks,
  reloadNotes,
  activeNoteIdRef,
  splitNoteIdRef,
  refreshSelectedNoteFromRemote,
  refreshSplitNoteFromRemote,
  patchNoteFromRemote,
}: {
  ready: boolean;
  pendingRealtimeRefreshRef: Ref<RealtimeRefreshPlan>;
  realtimeRefreshTimerRef: Ref<ReturnType<typeof setTimeout> | null>;
  deferredQuery: string;
  memosOpen: boolean;
  tasksOpen: boolean;
  kanbanOpen: boolean;
  setMemoRefreshToken: Setter<number>;
  setTaskRefreshToken: Setter<number>;
  setKanbanRefreshToken: Setter<number>;
  refreshNotebooks: () => Promise<void>;
  reloadNotes: () => void;
  activeNoteIdRef: Ref<string | null>;
  splitNoteIdRef: Ref<string | null>;
  refreshSelectedNoteFromRemote: (id: string) => Promise<void>;
  refreshSplitNoteFromRemote: (id: string) => Promise<void>;
  patchNoteFromRemote: (id: string) => Promise<void>;
}) {
  const handleRealtimeChange = useCallback(
    (message?: WorkspaceChangeMessage) => {
      accumulateRealtimeRefresh(
        pendingRealtimeRefreshRef.current,
        message,
        Boolean(deferredQuery.trim()),
      );
      if (realtimeRefreshTimerRef.current !== null) return;
      realtimeRefreshTimerRef.current = setTimeout(() => {
        realtimeRefreshTimerRef.current = null;
        const next = pendingRealtimeRefreshRef.current;
        pendingRealtimeRefreshRef.current = emptyRealtimeRefreshPlan();
        if (next.memos && memosOpen) setMemoRefreshToken((value) => value + 1);
        if (next.notes || next.noteIds.size || next.notebooks) {
          if (tasksOpen) setTaskRefreshToken((value) => value + 1);
          if (kanbanOpen) setKanbanRefreshToken((value) => value + 1);
        }
        if (next.notebooks) void refreshNotebooks();
        if (next.notes) {
          reloadNotes();
        }
        const activeId = activeNoteIdRef.current;
        if (activeId && (next.selected || next.noteIds.has(activeId)))
          void refreshSelectedNoteFromRemote(activeId);
        const currentSplitId = splitNoteIdRef.current;
        if (currentSplitId && (next.selected || next.noteIds.has(currentSplitId))) {
          void refreshSplitNoteFromRemote(currentSplitId);
        }
        for (const noteId of next.noteIds) {
          if (!next.notes && noteId !== activeId && noteId !== currentSplitId)
            void patchNoteFromRemote(noteId);
        }
      }, 50);
    },
    [
      deferredQuery,
      memosOpen,
      tasksOpen,
      kanbanOpen,
      patchNoteFromRemote,
      refreshNotebooks,
      refreshSelectedNoteFromRemote,
      refreshSplitNoteFromRemote,
      reloadNotes,
    ],
  );
  useWorkspaceRealtime({ ready, onChange: handleRealtimeChange });
}
