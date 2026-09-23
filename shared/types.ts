export type NoteView = "all" | "inbox" | "favorites" | "shared" | "trash";

export type NoteSort = "updated" | "created" | "title";

export type ImageAssetSummary = {
  id: string;
  url: string;
  originalName: string;
  mimeType: string;
  byteSize: number;
  width: number;
  height: number;
  createdAt: number;
};

export type User = {
  id: string;
  username: string;
};

export type Notebook = {
  id: string;
  name: string;
  color: string;
  icon: string;
  isSystem: boolean;
  count: number;
  updatedAt: number;
};

export type NoteSummary = {
  id: string;
  title: string;
  preview: string;
  tags: string[];
  thumbnail: ImageAssetSummary | null;
  notebookId: string;
  notebookName: string;
  isFavorite: boolean;
  deletedAt: number | null;
  version: number;
  createdAt: number;
  updatedAt: number;
};

export type Note = NoteSummary & {
  contentMarkdown: string;
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

export type NoteLinkSummary = {
  id: string;
  sourceNoteId: string;
  sourceNoteTitle: string;
  sourceNotebookName: string;
  targetTitle: string;
  targetNoteId: string | null;
  snippet: string;
  updatedAt: number;
};

export type UnlinkedMention = {
  sourceNoteId: string;
  sourceNoteTitle: string;
  sourceNotebookName: string;
  snippet: string;
  matchIndex: number;
  matchText: string;
  sourceVersion: number;
  updatedAt: number;
};

export type NoteBacklinksResponse = {
  linkedReferences: NoteLinkSummary[];
  unlinkedMentions: UnlinkedMention[];
  truncated: boolean;
};
