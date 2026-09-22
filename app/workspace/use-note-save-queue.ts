import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../api";
import type { Note, NoteSummary } from "../../shared/types";
import { clearDraftRecovery, writeDraftRecovery } from "./draft-recovery";
import { errorMessage, toNoteDraft, toNoteSummary, type NoteDraft } from "./helpers";

const KEEPALIVE_BODY_MAX_BYTES = 48 * 1024;
const ALL_SAVE_FIELDS = ["title", "contentMarkdown", "notebookId", "isFavorite", "deleted"] as const;
type SaveField = typeof ALL_SAVE_FIELDS[number];

export type SaveState = "idle" | "saving" | "saved" | "conflict" | "error";

export type UseNoteSaveQueueOptions = {
  selectedRef: React.MutableRefObject<Note | null>;
  notesRef: React.MutableRefObject<NoteSummary[]>;
  activeNoteIdRef: React.MutableRefObject<string | null>;
  trashOperationsRef: React.MutableRefObject<Set<string>>;
  replaceList: (notes: NoteSummary[]) => void;
  setSelectedNote: React.Dispatch<React.SetStateAction<Note | null>>;
  setToast: (toast: string) => void;
};

export function useNoteSaveQueue(options: UseNoteSaveQueueOptions) {
  const {
    selectedRef,
    notesRef,
    activeNoteIdRef,
    trashOperationsRef,
    replaceList,
    setSelectedNote,
    setToast,
  } = options;

  const [saveState, setSaveState] = useState<SaveState>("idle");
  const saveTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const draftRecoveryTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const pendingSavesRef = useRef(new Map<string, NoteDraft>());
  const pendingFieldsRef = useRef(new Map<string, Set<SaveField>>());
  const inFlightSavesRef = useRef(new Map<string, Promise<void>>());
  const failedSavesRef = useRef(new Map<string, unknown>());

  const hasUnsavedWork = useCallback(() => {
    return pendingSavesRef.current.size > 0 || failedSavesRef.current.size > 0;
  }, []);

  const runSave = useCallback(async (noteId: string, keepalive = false) => {
    const running = inFlightSavesRef.current.get(noteId);
    if (running) return running;

    const task = (async () => {
      let fieldsForRequest: Set<SaveField> | null = null;
      try {
        while (pendingSavesRef.current.has(noteId)) {
          const draft = pendingSavesRef.current.get(noteId)!;
          const base = selectedRef.current?.id === noteId
            ? selectedRef.current
            : notesRef.current.find((note) => note.id === noteId);
          if (!base) throw new Error("note-not-loaded");

          const fields = pendingFieldsRef.current.get(noteId) ?? new Set<SaveField>(ALL_SAVE_FIELDS);
          pendingFieldsRef.current.delete(noteId);
          fieldsForRequest = fields;
          const payload: { version: number; title?: string; contentMarkdown?: string; notebookId?: string; isFavorite?: boolean; deleted?: boolean } = {
            version: base.version,
          };
          if (fields.has("title")) payload.title = draft.title;
          if (fields.has("contentMarkdown")) payload.contentMarkdown = draft.contentMarkdown;
          if (fields.has("notebookId")) payload.notebookId = draft.notebookId;
          if (fields.has("isFavorite")) payload.isFavorite = draft.isFavorite;
          if (fields.has("deleted")) payload.deleted = Boolean(draft.deletedAt);

          const keepaliveRequest = keepalive && new TextEncoder().encode(JSON.stringify(payload)).byteLength <= KEEPALIVE_BODY_MAX_BYTES;
          const result = await api.updateNote(noteId, payload, { keepalive: keepaliveRequest, response: "summary" });
          const savedNote: Note = "contentMarkdown" in result.note
            ? result.note
            : { ...base, ...result.note, contentMarkdown: draft.contentMarkdown };
          const savedSummary = toNoteSummary(savedNote);

          const latest = pendingSavesRef.current.get(noteId);
          const next = latest && latest !== draft ? { ...savedNote, ...latest, version: savedNote.version } : undefined;

          if (next) pendingSavesRef.current.set(noteId, next);
          else pendingSavesRef.current.delete(noteId);

          const recoveryTimer = draftRecoveryTimersRef.current.get(noteId);
          if (recoveryTimer) clearTimeout(recoveryTimer);
          draftRecoveryTimersRef.current.delete(noteId);

          if (next) writeDraftRecovery(next);
          else clearDraftRecovery(noteId);

          failedSavesRef.current.delete(noteId);
          const nextSummary = next ? toNoteSummary(next) : undefined;
          replaceList(notesRef.current.map((note) => (note.id === noteId ? { ...note, ...savedSummary, ...nextSummary } : note)));

          if (activeNoteIdRef.current === noteId) {
            selectedRef.current = next ?? savedNote;
            setSelectedNote(selectedRef.current);
            setSaveState(next ? "saving" : "saved");
          }
        }
      } catch (reason) {
        if (fieldsForRequest) {
          const pendingFields = pendingFieldsRef.current.get(noteId) ?? new Set<SaveField>();
          for (const field of fieldsForRequest) pendingFields.add(field);
          pendingFieldsRef.current.set(noteId, pendingFields);
        }
        failedSavesRef.current.set(noteId, reason);
        const conflict = reason instanceof ApiError && reason.code === "VERSION_CONFLICT";
        if (activeNoteIdRef.current === noteId) setSaveState(conflict ? "conflict" : "error");
        if (!trashOperationsRef.current.has(noteId)) {
          setToast(conflict ? "这篇笔记已在别处更新，请重新载入" : errorMessage(reason, "保存失败，请检查网络后重试"));
        }
        throw reason;
      }
    })();

    inFlightSavesRef.current.set(noteId, task);
    try {
      await task;
    } finally {
      if (inFlightSavesRef.current.get(noteId) === task) inFlightSavesRef.current.delete(noteId);
    }
  }, [activeNoteIdRef, notesRef, replaceList, selectedRef, setSelectedNote, setToast, trashOperationsRef]);

  const persist = useCallback((draft: Note | NoteDraft, changedFields?: SaveField[]) => {
    const pendingDraft = toNoteDraft(draft);
    pendingSavesRef.current.set(pendingDraft.id, pendingDraft);
    const fields = pendingFieldsRef.current.get(pendingDraft.id) ?? new Set<SaveField>();
    for (const field of changedFields ?? ALL_SAVE_FIELDS) fields.add(field);
    pendingFieldsRef.current.set(pendingDraft.id, fields);
    if (activeNoteIdRef.current === pendingDraft.id) setSaveState("saving");

    const existingRecoveryTimer = draftRecoveryTimersRef.current.get(pendingDraft.id);
    if (existingRecoveryTimer) clearTimeout(existingRecoveryTimer);
    const recoveryTimer = setTimeout(() => {
      draftRecoveryTimersRef.current.delete(pendingDraft.id);
      const latestDraft = pendingSavesRef.current.get(pendingDraft.id);
      if (latestDraft) writeDraftRecovery(latestDraft);
    }, 1200);
    draftRecoveryTimersRef.current.set(pendingDraft.id, recoveryTimer);

    const existingTimer = saveTimersRef.current.get(pendingDraft.id);
    if (existingTimer) clearTimeout(existingTimer);
    const timer = setTimeout(() => {
      saveTimersRef.current.delete(pendingDraft.id);
      const requestDraft = pendingSavesRef.current.get(pendingDraft.id);
      if (!requestDraft) return;
      void runSave(pendingDraft.id).catch(() => undefined);
    }, 800);
    saveTimersRef.current.set(pendingDraft.id, timer);
  }, [activeNoteIdRef, runSave]);

  const saveNoteNow = useCallback(() => {
    const current = selectedRef.current;
    const pending = current ? pendingSavesRef.current.get(current.id) : undefined;
    if (!current || !pending) return;
    const timer = saveTimersRef.current.get(current.id);
    if (timer) clearTimeout(timer);
    saveTimersRef.current.delete(current.id);
    setSaveState("saving");
    void runSave(current.id).catch(() => undefined);
  }, [runSave, selectedRef]);

  const flushPendingSaves = useCallback(async (mode: "now" | "keepalive") => {
    if (mode === "keepalive") {
      for (const draft of pendingSavesRef.current.values()) writeDraftRecovery(draft);
    }
    const ids = [...pendingSavesRef.current.keys()];
    if (!ids.length) return;
    await Promise.all(
      ids.map(async (id) => {
        const timer = saveTimersRef.current.get(id);
        if (timer) clearTimeout(timer);
        saveTimersRef.current.delete(id);
        const draft = pendingSavesRef.current.get(id);
        if (!draft) return;
        if (failedSavesRef.current.has(id)) return;
        await runSave(id, mode === "keepalive").catch(() => undefined);
      }),
    );
  }, [runSave]);

  const retryFailedSaves = useCallback(async () => {
    const ids = [...failedSavesRef.current.entries()]
      .filter(([, reason]) => !(reason instanceof ApiError && reason.code === "VERSION_CONFLICT"))
      .map(([id]) => id)
      .filter((id) => pendingSavesRef.current.has(id));
    await Promise.all(ids.map((id) => runSave(id).catch(() => undefined)));
  }, [runSave]);

  const clearPendingForNote = useCallback((noteId: string) => {
    const timer = saveTimersRef.current.get(noteId);
    if (timer) clearTimeout(timer);
    saveTimersRef.current.delete(noteId);

    const recoveryTimer = draftRecoveryTimersRef.current.get(noteId);
    if (recoveryTimer) clearTimeout(recoveryTimer);
    draftRecoveryTimersRef.current.delete(noteId);

    pendingSavesRef.current.delete(noteId);
    pendingFieldsRef.current.delete(noteId);
    failedSavesRef.current.delete(noteId);
    clearDraftRecovery(noteId);
  }, []);

  const cancelSaveTimer = useCallback((noteId: string) => {
    const timer = saveTimersRef.current.get(noteId);
    if (timer) clearTimeout(timer);
    saveTimersRef.current.delete(noteId);
  }, []);

  const saveImmediately = useCallback(async (draft: Note | NoteDraft, keepalive = false, changedFields?: SaveField[]) => {
    const pendingDraft = toNoteDraft(draft);
    cancelSaveTimer(pendingDraft.id);
    pendingSavesRef.current.set(pendingDraft.id, pendingDraft);
    const fields = pendingFieldsRef.current.get(pendingDraft.id) ?? new Set<SaveField>();
    for (const field of changedFields ?? ALL_SAVE_FIELDS) fields.add(field);
    pendingFieldsRef.current.set(pendingDraft.id, fields);
    if (activeNoteIdRef.current === pendingDraft.id) setSaveState("saving");
    return runSave(pendingDraft.id, keepalive);
  }, [activeNoteIdRef, cancelSaveTimer, runSave]);

  // Listen for beforeunload warning
  useEffect(() => {
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedWork()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [hasUnsavedWork]);

  // Flush when page hidden or unloading
  useEffect(() => {
    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") void flushPendingSaves("keepalive");
    };
    const flushWhenUnloading = () => {
      void flushPendingSaves("keepalive");
    };
    document.addEventListener("visibilitychange", flushWhenHidden);
    window.addEventListener("pagehide", flushWhenUnloading);
    return () => {
      document.removeEventListener("visibilitychange", flushWhenHidden);
      window.removeEventListener("pagehide", flushWhenUnloading);
    };
  }, [flushPendingSaves]);

  // Retry failed saves when coming back online
  useEffect(() => {
    const retryWhenOnline = () => {
      void retryFailedSaves();
    };
    window.addEventListener("online", retryWhenOnline);
    return () => window.removeEventListener("online", retryWhenOnline);
  }, [retryFailedSaves]);

  // Flush and cleanup timers on unmount
  useEffect(() => () => {
    for (const draft of pendingSavesRef.current.values()) writeDraftRecovery(draft);
    void flushPendingSaves("keepalive");
    for (const timer of saveTimersRef.current.values()) clearTimeout(timer);
    saveTimersRef.current.clear();
    for (const timer of draftRecoveryTimersRef.current.values()) clearTimeout(timer);
    draftRecoveryTimersRef.current.clear();
  }, [flushPendingSaves]);

  return {
    saveState,
    setSaveState,
    pendingSavesRef,
    failedSavesRef,
    persist,
    runSave,
    saveImmediately,
    saveNoteNow,
    cancelSaveTimer,
    flushPendingSaves,
    retryFailedSaves,
    hasUnsavedWork,
    clearPendingForNote,
  };
}
