import { ApiError, api } from "../api";
import type { Note } from "../../shared/types";

type Ref<T> = { current: T };

export type SelectedNoteSyncOptions = {
  selectedRef: Ref<Note | null>;
  activeNoteIdRef: Ref<string | null>;
  noteAbortRef: Ref<AbortController | null>;
  noteLoadRequestRef: Ref<number>;
  hasPendingWork: (noteId: string) => boolean;
  onUpdated: (note: Note) => void;
  onConflict: () => void;
  onUnauthorized: () => void;
  onNotFound: (noteId: string) => void;
  onError: () => void;
};

// A save may advance the selected note during either the network read or draft
// recovery. Both loading and remote refresh must keep the newest local snapshot.
export function latestSelectedNoteSnapshot(remote: Note, current: Note | null): Note {
  return current?.id === remote.id && current.version >= remote.version ? current : remote;
}

export async function refreshSelectedNote(noteId: string, options: SelectedNoteSyncOptions) {
  const { selectedRef, activeNoteIdRef, noteAbortRef, noteLoadRequestRef } = options;
  if (selectedRef.current?.id !== noteId) return;

  noteAbortRef.current?.abort();
  const controller = new AbortController();
  noteAbortRef.current = controller;
  const requestId = ++noteLoadRequestRef.current;
  try {
    const result = await api.getNote(noteId, { signal: controller.signal });
    const current = selectedRef.current;
    if (requestId !== noteLoadRequestRef.current || activeNoteIdRef.current !== noteId || current?.id !== noteId) return;
    // A local save can finish while this request is in flight. Compare against
    // the current version, and never reload an older or already-applied snapshot.
    if (latestSelectedNoteSnapshot(result.note, current) === current) return;
    if (options.hasPendingWork(noteId)) {
      options.onConflict();
      return;
    }
    selectedRef.current = result.note;
    options.onUpdated(result.note);
  } catch (reason) {
    if (reason instanceof Error && reason.name === "AbortError") return;
    if (reason instanceof ApiError && reason.status === 401) {
      options.onUnauthorized();
      return;
    }
    if (reason instanceof ApiError && reason.status === 404 && activeNoteIdRef.current === noteId) {
      options.onNotFound(noteId);
      return;
    }
    options.onError();
  } finally {
    if (noteAbortRef.current === controller) noteAbortRef.current = null;
  }
}
