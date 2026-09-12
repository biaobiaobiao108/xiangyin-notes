import { api, ApiError } from "./api";
import { clearCachedData, clearOfflineData, deleteConflict, deleteLocalNote, deleteLocalNotebook, deleteMutation, getLocalSnapshot, getOfflineConflicts, getOfflineUser, getPendingMutations, getSyncCursor, putConflict, putLocalNote, putLocalNotebook, putMutation, setOfflineUser, setSyncCursor } from "./offline-store";
import type { SyncChange, SyncMutation, SyncPushResult } from "../shared/sync";
import type { Note, Notebook, User } from "../shared/types";

export type OfflineSyncState = {
  status: "idle" | "offline" | "syncing" | "synced" | "error" | "conflict";
  pendingCount: number;
  conflictCount: number;
  lastError: string | null;
};

type Listener = (state: OfflineSyncState) => void;

function now() {
  return Math.floor(Date.now() / 1000);
}

function localPreview(markdown: string) {
  return markdown.replace(/[`*_#[\]()>~-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 180);
}

function networkAvailable() {
  return typeof navigator === "undefined" || navigator.onLine;
}

function isNetworkFailure(reason: unknown) {
  return !(reason instanceof ApiError) || reason.status === 408 || reason.status >= 500;
}

function operationIdFor(mutations: SyncMutation[], entity: "note" | "notebook", entityId: string) {
  return mutations.find((mutation) => mutation.entity === entity && mutation.entityId === entityId)?.operationId ?? crypto.randomUUID();
}

function noteMutation(note: Note, operationId: string, options?: { allowRecreate?: boolean }): SyncMutation {
  return {
    operationId,
    entity: "note",
    action: "upsert",
    entityId: note.id,
    ...(options?.allowRecreate ? { allowRecreate: true } : {}),
    baseVersion: note.version,
    note: {
      title: note.title,
      contentMarkdown: note.contentMarkdown,
      notebookId: note.notebookId,
      isFavorite: note.isFavorite,
      deletedAt: note.deletedAt,
    },
  };
}

function notebookMutation(notebook: Notebook, operationId: string): SyncMutation {
  return {
    operationId,
    entity: "notebook",
    action: "upsert",
    entityId: notebook.id,
    baseUpdatedAt: notebook.updatedAt,
    notebook: { name: notebook.name, color: notebook.color },
  };
}

class OfflineSyncController {
  private user: User | null = null;
  private syncing = false;
  private sessionGeneration = 0;
  private syncToken = 0;
  private syncAbortController: AbortController | null = null;
  private listeners = new Set<Listener>();
  private state: OfflineSyncState = { status: "idle", pendingCount: 0, conflictCount: 0, lastError: null };
  private listenersInstalled = false;

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    listener(this.state);
    this.installListeners();
    return () => { this.listeners.delete(listener); };
  }

  getState() {
    return this.state;
  }

  private emit(partial: Partial<OfflineSyncState>) {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) listener(this.state);
  }

  private isCurrentSession(generation: number, userId: string) {
    return this.sessionGeneration === generation && this.user?.id === userId;
  }

  private invalidateSession() {
    this.sessionGeneration += 1;
    this.syncToken += 1;
    this.syncAbortController?.abort();
    this.syncAbortController = null;
    this.syncing = false;
  }

  private installListeners() {
    if (this.listenersInstalled || typeof window === "undefined") return;
    this.listenersInstalled = true;
    window.addEventListener("online", () => { void this.sync(); });
    window.addEventListener("offline", () => this.emit({ status: "offline" }));
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void this.sync(); });
  }

  async activate(user: User) {
    if (this.user?.id !== user.id) this.invalidateSession();
    this.user = user;
    const generation = this.sessionGeneration;
    await setOfflineUser(user);
    const local = await getLocalSnapshot();
    if (!this.isCurrentSession(generation, user.id)) return local;
    await this.refreshCounts(generation);
    if (networkAvailable()) void this.sync();
    else this.emit({ status: "offline" });
    return local;
  }

  async getLocalUser() {
    return await getOfflineUser();
  }

  async getLocalSnapshot() {
    return await getLocalSnapshot();
  }

  async cacheNote(note: Note) {
    await putLocalNote(note);
  }

  async cacheNotebook(notebook: Notebook) {
    await putLocalNotebook(notebook);
  }

  async clear() {
    this.invalidateSession();
    this.user = null;
    await clearOfflineData();
    this.emit({ status: "idle", pendingCount: 0, conflictCount: 0, lastError: null });
  }

  private async refreshCounts(generation = this.sessionGeneration) {
    const [mutations, conflicts] = await Promise.all([getPendingMutations(), getOfflineConflicts()]);
    if (generation !== this.sessionGeneration) return;
    this.emit({ pendingCount: mutations.length, conflictCount: conflicts.length, status: conflicts.length ? "conflict" : this.state.status });
  }

  private async queue(mutation: SyncMutation) {
    const generation = this.sessionGeneration;
    const userId = this.user?.id;
    if (!userId) return;
    const current = await getPendingMutations();
    if (!this.isCurrentSession(generation, userId)) return;
    for (const existing of current) {
      if (existing.entity === mutation.entity && existing.entityId === mutation.entityId) {
        if (!this.isCurrentSession(generation, userId)) return;
        await deleteMutation(existing.operationId);
      }
    }
    if (!this.isCurrentSession(generation, userId)) return;
    await putMutation(mutation);
    if (!this.isCurrentSession(generation, userId)) return;
    await this.refreshCounts(generation);
    if (!this.isCurrentSession(generation, userId)) return;
    if (networkAvailable()) void this.sync();
  }

  async saveNote(note: Note, options?: { keepalive?: boolean }) {
    const localNote = { ...note, preview: localPreview(note.contentMarkdown), updatedAt: now() };
    if (!networkAvailable()) {
      await putLocalNote(localNote);
      await this.queue(noteMutation(localNote, operationIdFor(await getPendingMutations(), "note", localNote.id)));
      return { note: localNote, offline: true };
    }
    try {
      const result = await api.updateNote(note.id, { version: note.version, title: note.title, contentMarkdown: note.contentMarkdown, notebookId: note.notebookId, isFavorite: note.isFavorite, deleted: Boolean(note.deletedAt) }, options);
      await putLocalNote(result.note);
      return { note: result.note, offline: false };
    } catch (reason) {
      if (!isNetworkFailure(reason)) {
        if (reason instanceof ApiError && reason.code === "VERSION_CONFLICT") {
          await putLocalNote(localNote);
          const current = reason.details?.error && typeof reason.details.error === "object" && "current" in reason.details.error
            ? reason.details.error.current
            : null;
          const server = current && typeof current === "object" && "contentMarkdown" in current ? current as Note : null;
          const conflicts = await getOfflineConflicts();
          if (!conflicts.some((conflict) => conflict.noteId === note.id)) await putConflict({ id: crypto.randomUUID(), noteId: note.id, local: localNote, server, createdAt: now() });
        }
        throw reason;
      }
      await putLocalNote(localNote);
      await this.queue(noteMutation(localNote, operationIdFor(await getPendingMutations(), "note", localNote.id)));
      return { note: localNote, offline: true };
    }
  }

  async createNote(payload: { id?: string; title?: string; contentMarkdown?: string; notebookId?: string }, notebook?: Notebook) {
    const clientId = payload.id ?? crypto.randomUUID();
    const requestPayload = { ...payload, id: clientId };
    if (networkAvailable()) {
      try {
        const result = await api.createNote(requestPayload);
        await putLocalNote(result.note);
        return { note: result.note, offline: false };
      } catch (reason) {
        if (!isNetworkFailure(reason)) throw reason;
      }
    }
    if (!notebook && !payload.notebookId) throw new Error("offline-notebook-required");
    const timestamp = now();
    const note: Note = {
      id: clientId,
      title: payload.title ?? "未命名笔记",
      contentMarkdown: payload.contentMarkdown ?? "",
      preview: localPreview(payload.contentMarkdown ?? ""),
      notebookId: payload.notebookId ?? notebook!.id,
      notebookName: notebook?.name ?? "收件箱",
      isFavorite: false,
      deletedAt: null,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await putLocalNote(note);
    await this.queue(noteMutation(note, operationIdFor(await getPendingMutations(), "note", note.id)));
    return { note, offline: true };
  }

  async saveNotebook(notebook: Notebook, isNew: boolean) {
    const localNotebook = isNew ? notebook : { ...notebook, updatedAt: now() };
    if (!networkAvailable()) {
      await putLocalNotebook(localNotebook);
      await this.queue(notebookMutation(notebook, operationIdFor(await getPendingMutations(), "notebook", notebook.id)));
      return { notebook: localNotebook, offline: true };
    }
    try {
      const result = isNew
        ? await api.createNotebook({ name: notebook.name, color: notebook.color })
        : await api.updateNotebook(notebook.id, { name: notebook.name, color: notebook.color });
      if (isNew && result.notebook.id !== notebook.id) await deleteLocalNotebook(notebook.id);
      await putLocalNotebook(result.notebook);
      return { notebook: result.notebook, offline: false };
    } catch (reason) {
      if (!isNetworkFailure(reason)) throw reason;
      await putLocalNotebook(localNotebook);
      await this.queue(notebookMutation(notebook, operationIdFor(await getPendingMutations(), "notebook", notebook.id)));
      return { notebook: localNotebook, offline: true };
    }
  }

  async deleteNotebook(notebook: Notebook, inbox: Notebook) {
    if (networkAvailable()) {
      try {
        await api.deleteNotebook(notebook.id);
        await deleteLocalNotebook(notebook.id);
        return { offline: false };
      } catch (reason) {
        if (!isNetworkFailure(reason)) throw reason;
      }
    }
    const local = await getLocalSnapshot();
    for (const note of local.notes.filter((item) => item.notebookId === notebook.id)) {
      const moved = { ...note, notebookId: inbox.id, notebookName: inbox.name, updatedAt: now(), version: note.version };
      await putLocalNote(moved);
      await this.queue(noteMutation(moved, operationIdFor(local.mutations, "note", moved.id)));
    }
    await deleteLocalNotebook(notebook.id);
    await this.queue({ operationId: operationIdFor(local.mutations, "notebook", notebook.id), entity: "notebook", action: "delete", entityId: notebook.id, baseUpdatedAt: notebook.updatedAt });
    return { offline: true };
  }

  async permanentlyDeleteNote(note: Note) {
    if (networkAvailable()) {
      try {
        await api.deleteNote(note.id);
        await deleteLocalNote(note.id);
        return { offline: false };
      } catch (reason) {
        if (!isNetworkFailure(reason)) throw reason;
      }
    }
    await deleteLocalNote(note.id);
    const current = await getPendingMutations();
    await this.queue({ operationId: operationIdFor(current, "note", note.id), entity: "note", action: "delete", entityId: note.id, baseVersion: note.version });
    return { offline: true };
  }

  private async applyChange(change: SyncChange, generation = this.sessionGeneration, userId = this.user?.id) {
    if (!userId || !this.isCurrentSession(generation, userId)) return;
    if (change.entity === "note") {
      if ((await getOfflineConflicts()).some((conflict) => conflict.noteId === change.entityId)) return;
      if (!this.isCurrentSession(generation, userId)) return;
      if (change.operation === "delete") await deleteLocalNote(change.entityId);
      else if (change.payload && "contentMarkdown" in change.payload) await putLocalNote(change.payload);
    } else if (change.operation === "delete") {
      await deleteLocalNotebook(change.entityId);
    } else if (change.payload && "updatedAt" in change.payload) {
      await putLocalNotebook(change.payload as Notebook);
    }
  }

  private async handlePushResult(result: SyncPushResult, mutation: SyncMutation, generation: number, userId: string) {
    if (!this.isCurrentSession(generation, userId)) return;
    if (result.status === "applied") {
      await deleteMutation(mutation.operationId);
      if (!this.isCurrentSession(generation, userId)) return;
      if (result.note) await putLocalNote(result.note);
      else if (result.notebook) await putLocalNotebook(result.notebook);
      else if (mutation.entity === "note") await deleteLocalNote(mutation.entityId);
      else await deleteLocalNotebook(mutation.entityId);
    } else if (result.status === "conflict" && mutation.entity === "note" && mutation.note) {
      const local = await getLocalSnapshot();
      if (!this.isCurrentSession(generation, userId)) return;
      const localNote = local.notes.find((note) => note.id === mutation.entityId);
      const serverNote = result.current && "contentMarkdown" in result.current ? result.current : null;
      if (localNote) await putConflict({ id: crypto.randomUUID(), noteId: mutation.entityId, local: localNote, server: serverNote, createdAt: now() });
      if (!this.isCurrentSession(generation, userId)) return;
      await deleteMutation(mutation.operationId);
    } else {
      await deleteMutation(mutation.operationId);
      if (!this.isCurrentSession(generation, userId)) return;
      this.emit({ lastError: result.message ?? "同步操作被拒绝" });
    }
  }

  async sync() {
    if (this.syncing || !this.user) return;
    if (!networkAvailable()) { this.emit({ status: "offline" }); return; }
    const userId = this.user.id;
    const generation = this.sessionGeneration;
    const token = ++this.syncToken;
    const abortController = new AbortController();
    this.syncAbortController = abortController;
    this.syncing = true;
    this.emit({ status: "syncing", lastError: null });
    try {
      let mutations = await getPendingMutations();
      while (mutations.length) {
        if (!this.isCurrentSession(generation, userId) || token !== this.syncToken) return;
        const batch = mutations.slice(0, 25);
        const response = await api.syncPush(batch, { signal: abortController.signal });
        if (!this.isCurrentSession(generation, userId) || token !== this.syncToken) return;
        for (const result of response.results) {
          const mutation = batch.find((item) => item.operationId === result.operationId);
          if (mutation) await this.handlePushResult(result, mutation, generation, userId);
        }
        mutations = await getPendingMutations();
      }

      let cursor = await getSyncCursor();
      const firstPage = await api.syncPull({ cursor, limit: 100 }, { signal: abortController.signal });
      if (!this.isCurrentSession(generation, userId) || token !== this.syncToken) return;
      if (firstPage.mode === "snapshot") {
        await clearCachedData();
        let offset = 0;
        let page = firstPage;
        const snapshotCursor = page.snapshotCursor ?? page.cursor;
        let more = true;
        while (more) {
          if (!this.isCurrentSession(generation, userId) || token !== this.syncToken) return;
          const conflicts = await getOfflineConflicts();
          for (const note of page.notes) {
            if (!this.isCurrentSession(generation, userId) || token !== this.syncToken) return;
            if (!conflicts.some((conflict) => conflict.noteId === note.id)) await putLocalNote(note);
          }
          for (const notebook of page.notebooks) {
            if (!this.isCurrentSession(generation, userId) || token !== this.syncToken) return;
            await putLocalNotebook(notebook);
          }
          offset += page.notes.length;
          more = page.hasMore;
          if (more) {
            page = await api.syncPull({ cursor: 0, offset, snapshotCursor, limit: 100 }, { signal: abortController.signal });
            if (!this.isCurrentSession(generation, userId) || token !== this.syncToken) return;
          }
        }
        cursor = snapshotCursor;
        await setSyncCursor(cursor);
        if (!this.isCurrentSession(generation, userId) || token !== this.syncToken) return;
      }
      let moreChanges = true;
      let changePage = firstPage.mode === "changes" ? firstPage : null;
      while (moreChanges) {
        if (!this.isCurrentSession(generation, userId) || token !== this.syncToken) return;
        const page = changePage ?? await api.syncPull({ cursor, limit: 100 }, { signal: abortController.signal });
        if (!this.isCurrentSession(generation, userId) || token !== this.syncToken) return;
        for (const change of page.changes) await this.applyChange(change, generation, userId);
        if (!this.isCurrentSession(generation, userId) || token !== this.syncToken) return;
        cursor = page.cursor;
        await setSyncCursor(cursor);
        if (!this.isCurrentSession(generation, userId) || token !== this.syncToken) return;
        moreChanges = page.hasMore && page.changes.length > 0;
        changePage = null;
      }
      await this.refreshCounts(generation);
      if (!this.isCurrentSession(generation, userId) || token !== this.syncToken) return;
      this.emit({ status: this.state.conflictCount ? "conflict" : "synced" });
    } catch (reason) {
      if (!this.isCurrentSession(generation, userId) || token !== this.syncToken || (reason instanceof DOMException && reason.name === "AbortError")) return;
      if (reason instanceof ApiError && reason.status === 401) this.emit({ status: "error", lastError: "登录状态已过期" });
      else if (!networkAvailable() || isNetworkFailure(reason)) this.emit({ status: "offline" });
      else this.emit({ status: "error", lastError: reason instanceof Error ? reason.message : "同步失败" });
    } finally {
      if (token === this.syncToken) {
        this.syncing = false;
        if (this.syncAbortController === abortController) this.syncAbortController = null;
      }
    }
  }

  async resolveConflict(conflictId: string, resolution: "server" | "local", local?: Note) {
    const conflicts = await getOfflineConflicts();
    const conflict = conflicts.find((item) => item.id === conflictId);
    if (!conflict) return;
    if (resolution === "server") {
      if (conflict.server) await putLocalNote(conflict.server);
      else await deleteLocalNote(conflict.noteId);
    }
    else if (local) {
      const baseVersion = conflict.server?.version ?? local.version;
      await putLocalNote({ ...local, version: baseVersion });
      await this.queue(noteMutation({ ...local, version: baseVersion }, crypto.randomUUID(), { allowRecreate: !conflict.server }));
    }
    await deleteConflict(conflictId);
    await this.refreshCounts();
    if (networkAvailable()) void this.sync();
  }
}

export const offlineSync = new OfflineSyncController();
