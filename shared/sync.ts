import type { Note, Notebook } from "./types";

export type SyncEntity = "note" | "notebook";
export type SyncChangeOperation = "upsert" | "delete";

export type SyncChange = {
  sequence: number;
  entity: SyncEntity;
  entityId: string;
  operation: SyncChangeOperation;
  payload: Note | Notebook | null;
};

export type SyncMutation = {
  operationId: string;
  entity: SyncEntity;
  action: "upsert" | "delete";
  entityId: string;
  /** Only set when the user explicitly resolves a delete-vs-edit conflict by restoring the note. */
  allowRecreate?: boolean;
  baseVersion?: number;
  baseUpdatedAt?: number;
  note?: {
    title: string;
    contentMarkdown: string;
    notebookId: string;
    isFavorite: boolean;
    deletedAt: number | null;
  };
  notebook?: {
    name: string;
    color: string;
  };
};

export type SyncPushResult = {
  operationId: string;
  status: "applied" | "conflict" | "rejected";
  note?: Note;
  notebook?: Notebook;
  current?: Note | Notebook | null;
  message?: string;
};

export type SyncPullResponse = {
  mode: "snapshot" | "changes";
  cursor: number;
  snapshotCursor?: number;
  offset?: number;
  hasMore: boolean;
  notes: Note[];
  notebooks: Notebook[];
  changes: SyncChange[];
};

export type SyncPushResponse = {
  results: SyncPushResult[];
};
