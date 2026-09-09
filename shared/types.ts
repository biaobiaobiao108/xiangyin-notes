export type NoteView = "all" | "inbox" | "favorites" | "shared" | "trash";

export type User = {
  id: string;
  username: string;
};

export type Notebook = {
  id: string;
  name: string;
  color: string;
  isSystem: boolean;
  count: number;
};

export type NoteSummary = {
  id: string;
  title: string;
  preview: string;
  notebookId: string;
  notebookName: string;
  isFavorite: boolean;
  deletedAt: number | null;
  version: number;
  updatedAt: number;
};

export type Note = NoteSummary & {
  contentMarkdown: string;
  createdAt: number;
};

export type Share = {
  id: string;
  noteId: string;
  expiresAt: number;
  revokedAt: number | null;
  createdAt: number;
  url?: string;
};

export type ShareSnapshot = {
  schemaVersion: 1;
  title: string;
  contentMarkdown: string;
  createdAt: number;
  expiresAt: number;
};

export type ApiErrorPayload = {
  error: {
    code: string;
    message: string;
    fields?: Record<string, string>;
  };
};
