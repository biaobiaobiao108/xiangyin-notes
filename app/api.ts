import type { ApiErrorPayload, Note, NoteSummary, NoteView, Notebook, Share, User } from "../shared/types";

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

async function request<T>(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...init, headers, credentials: "include" });
  const payload = (await response.json().catch(() => null)) as (ApiErrorPayload & Record<string, unknown>) | null;
  if (!response.ok) {
    const error = payload?.error;
    throw new ApiError(response.status, error?.code ?? "REQUEST_FAILED", error?.message ?? "请求失败", payload ?? undefined);
  }
  return payload as T;
}

export const api = {
  bootstrap: () => request<{ configured: boolean }>("/api/bootstrap"),
  login: (payload: { username: string; password: string }) => request<{ user: User }>("/api/auth/login", { method: "POST", body: JSON.stringify(payload) }),
  logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST" }),
  me: () => request<{ user: User }>("/api/me"),
  listNotes: (params: { view: NoteView; query?: string; notebookId?: string }) => {
    const search = new URLSearchParams({ view: params.view });
    if (params.query) search.set("query", params.query);
    if (params.notebookId) search.set("notebookId", params.notebookId);
    return request<{ notes: NoteSummary[] }>(`/api/notes?${search.toString()}`);
  },
  getNote: (id: string) => request<{ note: Note }>(`/api/notes/${id}`),
  createNote: (payload: { title?: string; contentMarkdown?: string; notebookId?: string }) => request<{ note: Note }>("/api/notes", { method: "POST", body: JSON.stringify(payload) }),
  updateNote: (id: string, payload: { version: number; title?: string; contentMarkdown?: string; notebookId?: string; isFavorite?: boolean; deleted?: boolean }) => request<{ note: Note }>(`/api/notes/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  deleteNote: (id: string) => request<{ ok: true }>(`/api/notes/${id}`, { method: "DELETE" }),
  listNotebooks: () => request<{ notebooks: Notebook[] }>("/api/notebooks"),
  createNotebook: (payload: { name: string; color?: string }) => request<{ notebook: Notebook }>("/api/notebooks", { method: "POST", body: JSON.stringify(payload) }),
  updateNotebook: (id: string, payload: { name?: string; color?: string }) => request<{ notebook: Notebook }>(`/api/notebooks/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  deleteNotebook: (id: string) => request<{ ok: true }>(`/api/notebooks/${id}`, { method: "DELETE" }),
  listShares: (noteId: string) => request<{ shares: Share[] }>(`/api/notes/${noteId}/shares`),
  createShare: (noteId: string) => request<{ share: Share }>(`/api/notes/${noteId}/shares`, { method: "POST", body: JSON.stringify({}) }),
  revokeShare: (shareId: string) => request<{ ok: true }>(`/api/shares/${shareId}`, { method: "DELETE" }),
  getPublicShare: (token: string) => request<{ snapshot: { schemaVersion: 1; title: string; contentMarkdown: string; createdAt: number; expiresAt: number } }>(`/api/shares/${token}`),
};
