import type {
  ApiErrorPayload,
  ImageAssetSummary,
  Note,
  NoteSort,
  NoteSummary,
  NoteView,
  Notebook,
  User,
  NoteBacklinksResponse,
  TaskSummary,
  KanbanCard,
  KanbanCardsResponse,
  KanbanStatus,
} from "../shared/types";
import { createUuid } from "./uuid";

export class ApiError extends Error {
  status: number;
  code: string;
  details?: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

type RequestOptions = Pick<RequestInit, "keepalive" | "signal">;
type UpdateNoteOptions = RequestOptions & { response?: "summary" };

export const realtimeClientId = createUuid();

async function request<T>(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("X-Xiangying-Client-Id", realtimeClientId);
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type"))
    headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...init, headers, credentials: "include" });
  const payload = (await response.json().catch(() => null)) as
    (ApiErrorPayload & Record<string, unknown>) | null;
  if (!response.ok) {
    const error = payload?.error;
    throw new ApiError(
      response.status,
      error?.code ?? "REQUEST_FAILED",
      error?.message ?? "请求失败",
      payload ?? undefined,
    );
  }
  return payload as T;
}

export const api = {
  bootstrap: () => request<{ configured: boolean }>("/api/bootstrap"),
  login: (payload: { username: string; password: string }) =>
    request<{ user: User }>("/api/auth/login", { method: "POST", body: JSON.stringify(payload) }),
  logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST" }),
  me: () => request<{ user: User }>("/api/me"),
  listNotes: (
    params: {
      view: NoteView;
      query?: string;
      notebookId?: string;
      sort?: NoteSort;
      cursor?: string;
      includeTotal?: boolean;
    },
    options?: RequestOptions,
  ) => {
    const search = new URLSearchParams({ view: params.view });
    if (params.query) search.set("query", params.query);
    if (params.notebookId) search.set("notebookId", params.notebookId);
    if (params.sort) search.set("sort", params.sort);
    if (params.cursor) search.set("cursor", params.cursor);
    if (params.includeTotal === false) search.set("includeTotal", "0");
    return request<{
      notes: NoteSummary[];
      total?: number;
      hasMore?: boolean;
      nextCursor?: string;
    }>(`/api/notes?${search.toString()}`, options);
  },
  getNote: (id: string, options?: RequestOptions) =>
    request<{ note: Note }>(`/api/notes/${id}`, options),
  getNoteSummary: (id: string, options?: RequestOptions) =>
    request<{ note: NoteSummary }>(`/api/notes/${id}?response=summary`, options),
  ensureWikiNote: (payload: { title: string; notebookId: string }) =>
    request<{ note: Note; created: boolean }>("/api/wiki-notes/ensure", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  searchWikiNoteTitles: (query: string, signal?: AbortSignal) => {
    const search = new URLSearchParams({ query });
    return request<{
      matches: Array<{ title: string; notebookName: string }>;
      exactMatch: boolean;
    }>(`/api/wiki-notes/suggestions?${search.toString()}`, { signal });
  },
  uploadAsset: (file: File) =>
    request<{ asset: ImageAssetSummary }>("/api/assets", {
      method: "POST",
      body: (() => {
        const formData = new FormData();
        formData.append("file", file, file.name);
        return formData;
      })(),
    }),
  createNote: (payload: {
    id?: string;
    title?: string;
    contentMarkdown?: string;
    notebookId?: string;
  }) => request<{ note: Note }>("/api/notes", { method: "POST", body: JSON.stringify(payload) }),
  updateNote: (
    id: string,
    payload: {
      version: number;
      title?: string;
      contentMarkdown?: string;
      notebookId?: string;
      isFavorite?: boolean;
      deleted?: boolean;
    },
    options?: UpdateNoteOptions,
  ) => {
    const { response: responseMode, ...requestOptions } = options ?? {};
    const path =
      responseMode === "summary" ? `/api/notes/${id}?response=summary` : `/api/notes/${id}`;
    return request<{ note: Note | NoteSummary }>(path, {
      method: "PATCH",
      body: JSON.stringify(payload),
      ...requestOptions,
    });
  },
  moveNotesToTrash: (notes: Array<{ id: string; version: number }>) =>
    request<{ ok: true; deletedIds: string[] }>("/api/notes/batch", {
      method: "PATCH",
      body: JSON.stringify({ notes }),
    }),
  restoreNotes: (notes: Array<{ id: string; version: number }>) =>
    request<{ ok: true; restoredIds: string[] }>("/api/notes/batch", {
      method: "PATCH",
      body: JSON.stringify({ notes, deleted: false }),
    }),
  deleteNote: (id: string, version: number) =>
    request<{ ok: true }>(`/api/notes/${id}`, {
      method: "DELETE",
      body: JSON.stringify({ version }),
    }),
  deleteNotes: (notes: Array<{ id: string; version: number }>) =>
    request<{ ok: true; deletedIds: string[] }>("/api/notes/batch", {
      method: "DELETE",
      body: JSON.stringify({ notes }),
    }),
  emptyTrash: () => request<{ ok: true; deletedCount: number }>("/api/trash", { method: "DELETE" }),
  listNotebooks: () => request<{ notebooks: Notebook[] }>("/api/notebooks"),
  listTasks: (
    params: {
      status: "open" | "done" | "all";
      notebookId?: string;
      limit?: number;
      cursor?: string;
    },
    options?: RequestOptions,
  ) => {
    const search = new URLSearchParams({ status: params.status });
    if (params.notebookId) search.set("notebookId", params.notebookId);
    if (params.limit !== undefined) search.set("limit", String(params.limit));
    if (params.cursor) search.set("cursor", params.cursor);
    return request<{
      tasks: TaskSummary[];
      total?: number;
      nextCursor: string | null;
    }>(`/api/tasks?${search.toString()}`, options);
  },
  toggleTask: (payload: {
    noteId: string;
    version: number;
    ordinal: number;
    text: string;
    completed: boolean;
  }) =>
    request<{ note: Note }>("/api/tasks/toggle", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  createNotebook: (payload: { name: string; color?: string; icon?: string }) =>
    request<{ notebook: Notebook }>("/api/notebooks", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  updateNotebook: (id: string, payload: { name?: string; color?: string; icon?: string }) =>
    request<{ notebook: Notebook }>(`/api/notebooks/${id}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  deleteNotebook: (id: string) =>
    request<{ ok: true }>(`/api/notebooks/${id}`, { method: "DELETE" }),
  getBacklinks: (noteId: string, options?: RequestOptions) =>
    request<NoteBacklinksResponse>(`/api/notes/${noteId}/backlinks`, options),
  linkMention: (
    targetNoteId: string,
    payload: {
      sourceNoteId: string;
      sourceVersion: number;
      matchStart: number;
      matchEnd: number;
      matchText: string;
    },
  ) =>
    request<{ ok: true }>(`/api/notes/${targetNoteId}/link-mention`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  listKanbanCards: (
    params?: { notebookId?: string; status?: KanbanStatus; limit?: number; cursor?: string },
    options?: RequestOptions,
  ) => {
    const search = new URLSearchParams();
    if (params?.notebookId) search.set("notebookId", params.notebookId);
    if (params?.status) search.set("status", params.status);
    if (params?.limit !== undefined) search.set("limit", String(params.limit));
    if (params?.cursor) search.set("cursor", params.cursor);
    const query = search.toString();
    return request<KanbanCardsResponse>(`/api/kanban${query ? `?${query}` : ""}`, options);
  },
  addKanbanCard: (payload: { noteId: string; status?: KanbanStatus; sortOrder?: number }) =>
    request<{ card: KanbanCard }>("/api/kanban/cards", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  updateKanbanCard: (noteId: string, payload: { status?: KanbanStatus; sortOrder?: number }) =>
    request<{ card: KanbanCard }>(`/api/kanban/cards/${noteId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  deleteKanbanCard: (noteId: string) =>
    request<{ ok: true; noteId: string }>(`/api/kanban/cards/${noteId}`, { method: "DELETE" }),
};
