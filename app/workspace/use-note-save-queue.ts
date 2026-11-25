import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../api";
import type { Note, NoteSummary } from "../../shared/types";
import {
  clearDraftRecovery,
  noteMatchesDraft,
  rewrittenDraftTitle,
  writeDraftRecovery,
} from "./draft-recovery";
import { errorMessage, toNoteDraft, toNoteSummary, type NoteDraft } from "./helpers";
import { replaceWikiLinkTarget } from "../../shared/wiki-links";

const KEEPALIVE_BODY_MAX_BYTES = 48 * 1024;
const ALL_SAVE_FIELDS = [
  "title",
  "contentMarkdown",
  "notebookId",
  "isFavorite",
  "deleted",
] as const;
type SaveField = (typeof ALL_SAVE_FIELDS)[number];
type SaveAttempt = { draft: NoteDraft; fields: Set<SaveField> };

export type SaveState = "idle" | "saving" | "saved" | "conflict" | "missing" | "error";

class OfflineSaveError extends Error {
  constructor() {
    super("网络已断开，修改已保存在本地草稿");
    this.name = "OfflineSaveError";
  }
}

export function isMissingNoteError(reason: unknown): reason is ApiError {
  return reason instanceof ApiError && reason.status === 404 && reason.code === "NOTE_NOT_FOUND";
}

export function noteSaveFailureState(reason: unknown) {
  if (isMissingNoteError(reason)) return "missing";
  return reason instanceof ApiError && reason.code === "VERSION_CONFLICT" ? "conflict" : "error";
}

export type UseNoteSaveQueueOptions = {
  selectedRef: React.MutableRefObject<Note | null>;
  notesRef: React.MutableRefObject<NoteSummary[]>;
  activeNoteIdRef: React.MutableRefObject<string | null>;
  noteOpeningRef?: React.MutableRefObject<Promise<void> | null>;
  splitNoteOpeningRef?: React.MutableRefObject<Promise<void> | null>;
  trashOperationsRef: React.MutableRefObject<Set<string>>;
  flushEditorDraftRef: React.MutableRefObject<() => void>;
  replaceList: (notes: NoteSummary[]) => void;
  setSelectedNote: (note: Note | null) => void;
  setToast: (toast: string) => void;
  splitSelectedRef?: React.MutableRefObject<Note | null>;
  splitNoteIdRef?: React.MutableRefObject<string | null>;
  setSplitSelectedNote?: (note: Note | null) => void;
  setSplitSaveState?: (state: SaveState) => void;
  onSearchableFieldsSaved?: () => void;
  onRewrittenContent?: (noteId: string) => void;
  onLinkedNotesRewritten?: (noteId: string) => void;
};

export function useNoteSaveQueue(options: UseNoteSaveQueueOptions) {
  const {
    selectedRef,
    notesRef,
    activeNoteIdRef,
    noteOpeningRef,
    splitNoteOpeningRef,
    trashOperationsRef,
    flushEditorDraftRef,
    replaceList,
    setSelectedNote,
    setToast,
    splitSelectedRef,
    splitNoteIdRef,
    setSplitSelectedNote,
    setSplitSaveState,
    onSearchableFieldsSaved,
    onRewrittenContent,
    onLinkedNotesRewritten,
  } = options;

  const [saveState, setSaveState] = useState<SaveState>("idle");
  const saveTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const draftRecoveryTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const pendingSavesRef = useRef(new Map<string, NoteDraft>());
  const pendingFieldsRef = useRef(new Map<string, Set<SaveField>>());
  const inFlightSavesRef = useRef(new Map<string, Promise<number | undefined>>());
  const unconfirmedSavesRef = useRef(new Map<string, SaveAttempt>());
  const notebookMovesRef = useRef(new Map<string, Promise<unknown>>());
  const failedSavesRef = useRef(new Map<string, unknown>());

  const recordSaveFailure = useCallback(
    (noteId: string, reason: unknown) => {
      const previous = failedSavesRef.current.get(noteId);
      failedSavesRef.current.set(noteId, reason);
      const state = noteSaveFailureState(reason);
      if (activeNoteIdRef.current === noteId) setSaveState(state);
      if (splitSelectedRef?.current?.id === noteId) setSplitSaveState?.(state);
      if (state === "missing") {
        const draft = pendingSavesRef.current.get(noteId);
        if (draft) writeDraftRecovery(draft);
        if (isMissingNoteError(previous)) return;
      }
      if (!trashOperationsRef.current.has(noteId)) {
        setToast(
          state === "missing"
            ? "原笔记已删除，可以将本地草稿另存为新笔记"
            : state === "conflict"
              ? "这篇笔记已在别处更新，请重新载入"
              : errorMessage(reason, "保存失败，请检查网络后重试"),
        );
      }
    },
    [activeNoteIdRef, setSplitSaveState, setToast, splitSelectedRef, trashOperationsRef],
  );

  const markNoteMissing = useCallback(
    (noteId: string, reason: ApiError) => {
      flushEditorDraftRef.current();
      if (pendingSavesRef.current.has(noteId)) recordSaveFailure(noteId, reason);
    },
    [flushEditorDraftRef, recordSaveFailure],
  );

  const hasUnsavedWork = useCallback(
    (noteId?: string) => {
      flushEditorDraftRef.current();
      if (noteId) return pendingSavesRef.current.has(noteId) || failedSavesRef.current.has(noteId);
      return pendingSavesRef.current.size > 0 || failedSavesRef.current.size > 0;
    },
    [flushEditorDraftRef],
  );

  const runSave = useCallback(
    async (noteId: string, keepalive = false): Promise<number | undefined> => {
      const move = notebookMovesRef.current.get(noteId);
      if (move) await move.catch(() => undefined);
      const failure = failedSavesRef.current.get(noteId);
      if (isMissingNoteError(failure)) throw failure;
      const running = inFlightSavesRef.current.get(noteId);
      if (running) return running;

      const task = (async () => {
        let savedVersion: number | undefined;
        let searchableFieldsSaved = false;
        let attempt: SaveAttempt | undefined;
        let requestSent = false;
        try {
          while (pendingSavesRef.current.has(noteId)) {
            const unconfirmed = unconfirmedSavesRef.current.get(noteId);
            attempt = unconfirmed ?? {
              draft: pendingSavesRef.current.get(noteId)!,
              fields: pendingFieldsRef.current.get(noteId) ?? new Set<SaveField>(ALL_SAVE_FIELDS),
            };
            if (!unconfirmed) pendingFieldsRef.current.delete(noteId);
            const { draft, fields } = attempt;
            if (typeof navigator !== "undefined" && navigator.onLine === false) {
              requestSent = false;
              throw new OfflineSaveError();
            }
            const payload: Parameters<typeof api.updateNote>[1] = {
              version: draft.version,
            };
            if (fields.has("title")) payload.title = draft.title;
            if (fields.has("contentMarkdown")) payload.contentMarkdown = draft.contentMarkdown;
            if (fields.has("notebookId")) payload.notebookId = draft.notebookId;
            if (fields.has("isFavorite")) payload.isFavorite = draft.isFavorite;
            if (fields.has("deleted")) payload.deleted = Boolean(draft.deletedAt);

            const keepaliveRequest =
              keepalive &&
              new TextEncoder().encode(JSON.stringify(payload)).byteLength <=
                KEEPALIVE_BODY_MAX_BYTES;
            requestSent = true;
            const result = await api
              .updateNote(noteId, payload, { keepalive: keepaliveRequest, response: "summary" })
              .catch((reason: unknown): Awaited<ReturnType<typeof api.updateNote>> => {
                if (reason instanceof ApiError && reason.code === "VERSION_CONFLICT") {
                  const current = (reason.details?.error as { current?: Note } | undefined)
                    ?.current;
                  if (current) {
                    const previousTitle = unconfirmed
                      ? rewrittenDraftTitle(current, draft)
                      : undefined;
                    if (previousTitle)
                      return { note: current, previousTitle, linkedNotesRewritten: true };
                    if (noteMatchesDraft(current, draft)) {
                      const confirmedRename =
                        unconfirmed &&
                        fields.has("title") &&
                        draft.previousTitle !== undefined &&
                        draft.previousTitle !== current.title &&
                        current.version === draft.version + 1;
                      return { note: current, linkedNotesRewritten: Boolean(confirmedRename) };
                    }
                  }
                }
                throw reason;
              });
            if (!result?.note) throw new Error("保存响应缺少笔记");
            const failure = failedSavesRef.current.get(noteId);
            if (isMissingNoteError(failure)) throw failure;
            unconfirmedSavesRef.current.delete(noteId);
            attempt = undefined;
            if (result.previousTitle) flushEditorDraftRef.current();
            const savedNote: Note =
              "contentMarkdown" in result.note
                ? result.note
                : { ...result.note, contentMarkdown: draft.contentMarkdown };
            savedVersion = savedNote.version;
            searchableFieldsSaved ||= fields.has("title") || fields.has("contentMarkdown");
            const savedSummary = toNoteSummary(savedNote);

            const latest = pendingSavesRef.current.get(noteId);
            let next =
              latest && latest !== draft
                ? {
                    ...savedNote,
                    ...latest,
                    version: savedNote.version,
                    previousTitle: latest.title === savedNote.title ? undefined : savedNote.title,
                  }
                : undefined;
            if (next && result.previousTitle) {
              next = {
                ...next,
                contentMarkdown: replaceWikiLinkTarget(
                  next.contentMarkdown,
                  result.previousTitle,
                  savedNote.title,
                ).content,
              };
            }

            if (next) pendingSavesRef.current.set(noteId, next);
            else pendingSavesRef.current.delete(noteId);

            const recoveryTimer = draftRecoveryTimersRef.current.get(noteId);
            if (recoveryTimer) clearTimeout(recoveryTimer);
            draftRecoveryTimersRef.current.delete(noteId);

            if (next) writeDraftRecovery(next);
            else clearDraftRecovery(noteId);

            failedSavesRef.current.delete(noteId);
            const nextSummary = next ? toNoteSummary(next) : undefined;
            replaceList(
              notesRef.current.map((note) =>
                note.id === noteId ? { ...note, ...savedSummary, ...nextSummary } : note,
              ),
            );

            if (activeNoteIdRef.current === noteId) {
              selectedRef.current = next ?? savedNote;
              setSelectedNote(selectedRef.current);
              setSaveState(next ? "saving" : "saved");
            }
            if (splitSelectedRef && splitNoteIdRef?.current === noteId) {
              splitSelectedRef.current = next ?? savedNote;
              setSplitSelectedNote?.(splitSelectedRef.current);
              setSplitSaveState?.(next ? "saving" : "saved");
            }
            if (result.previousTitle) onRewrittenContent?.(noteId);
            if (result.linkedNotesRewritten) onLinkedNotesRewritten?.(noteId);
          }
          return savedVersion;
        } catch (reason) {
          if (!pendingSavesRef.current.has(noteId)) throw reason;
          const latestPending = pendingSavesRef.current.get(noteId);
          if (latestPending) {
            const recoveryTimer = draftRecoveryTimersRef.current.get(noteId);
            if (recoveryTimer) clearTimeout(recoveryTimer);
            draftRecoveryTimersRef.current.delete(noteId);
            writeDraftRecovery(latestPending);
          }
          const failure = failedSavesRef.current.get(noteId);
          const latestFailure = isMissingNoteError(failure) ? failure : reason;
          if (attempt) {
            if (
              requestSent &&
              (!(latestFailure instanceof ApiError) || latestFailure.status >= 500)
            ) {
              // Keep the exact request so a retry can confirm it before sending newer edits.
              unconfirmedSavesRef.current.set(noteId, attempt);
            } else {
              unconfirmedSavesRef.current.delete(noteId);
              const pendingFields = pendingFieldsRef.current.get(noteId) ?? new Set<SaveField>();
              for (const field of attempt.fields) pendingFields.add(field);
              pendingFieldsRef.current.set(noteId, pendingFields);
            }
          }
          recordSaveFailure(noteId, latestFailure);
          throw latestFailure;
        } finally {
          if (searchableFieldsSaved) onSearchableFieldsSaved?.();
        }
      })();

      inFlightSavesRef.current.set(noteId, task);
      try {
        return await task;
      } finally {
        if (inFlightSavesRef.current.get(noteId) === task) inFlightSavesRef.current.delete(noteId);
      }
    },
    [
      activeNoteIdRef,
      notesRef,
      replaceList,
      selectedRef,
      setSelectedNote,
      recordSaveFailure,
      splitSelectedRef,
      splitNoteIdRef,
      setSplitSelectedNote,
      setSplitSaveState,
      flushEditorDraftRef,
      onSearchableFieldsSaved,
      onRewrittenContent,
      onLinkedNotesRewritten,
    ],
  );

  const persist = useCallback(
    (draft: Note | NoteDraft, changedFields?: SaveField[], previousTitle?: string) => {
      const pendingDraft = toNoteDraft(draft);
      const pending = pendingSavesRef.current.get(pendingDraft.id);
      pendingDraft.previousTitle =
        pending?.previousTitle ?? pendingDraft.previousTitle ?? previousTitle;
      pendingSavesRef.current.set(pendingDraft.id, pendingDraft);
      const fields = pendingFieldsRef.current.get(pendingDraft.id) ?? new Set<SaveField>();
      for (const field of changedFields ?? ALL_SAVE_FIELDS) fields.add(field);
      pendingFieldsRef.current.set(pendingDraft.id, fields);
      const missing = isMissingNoteError(failedSavesRef.current.get(pendingDraft.id));
      if (!missing) {
        if (activeNoteIdRef.current === pendingDraft.id) setSaveState("saving");
        if (splitSelectedRef?.current?.id === pendingDraft.id) setSplitSaveState?.("saving");
      }

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
      if (missing) {
        saveTimersRef.current.delete(pendingDraft.id);
        return;
      }
      const timer = setTimeout(() => {
        saveTimersRef.current.delete(pendingDraft.id);
        const requestDraft = pendingSavesRef.current.get(pendingDraft.id);
        if (!requestDraft) return;
        void runSave(pendingDraft.id).catch(() => undefined);
      }, 800);
      saveTimersRef.current.set(pendingDraft.id, timer);
    },
    [activeNoteIdRef, runSave, setSplitSaveState, splitSelectedRef],
  );

  const saveNoteNow = useCallback(
    (noteId?: string) => {
      const targetId = noteId ?? selectedRef.current?.id;
      if (!targetId) return;
      const pending = pendingSavesRef.current.get(targetId);
      if (!pending || isMissingNoteError(failedSavesRef.current.get(targetId))) return;
      const timer = saveTimersRef.current.get(targetId);
      if (timer) clearTimeout(timer);
      saveTimersRef.current.delete(targetId);
      if (activeNoteIdRef.current === targetId) setSaveState("saving");
      if (splitSelectedRef?.current?.id === targetId) setSplitSaveState?.("saving");
      void runSave(targetId).catch(() => undefined);
    },
    [activeNoteIdRef, runSave, selectedRef, setSplitSaveState, splitSelectedRef],
  );

  const flushPendingSaves = useCallback(
    async (mode: "now" | "keepalive", noteId?: string) => {
      flushEditorDraftRef.current();
      if (mode === "keepalive") {
        for (const draft of pendingSavesRef.current.values()) writeDraftRecovery(draft);
      }
      const ids = noteId ? [noteId] : [...pendingSavesRef.current.keys()];
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
    },
    [flushEditorDraftRef, runSave],
  );

  const flushDraftRecoveries = useCallback(() => {
    flushEditorDraftRef.current();
    for (const [noteId, draft] of pendingSavesRef.current.entries()) {
      const recoveryTimer = draftRecoveryTimersRef.current.get(noteId);
      if (recoveryTimer) clearTimeout(recoveryTimer);
      draftRecoveryTimersRef.current.delete(noteId);
      writeDraftRecovery(draft);
    }
  }, [flushEditorDraftRef]);

  const retryFailedSaves = useCallback(async () => {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return 0;
    const ids = [...failedSavesRef.current.entries()]
      .filter(([, reason]) => noteSaveFailureState(reason) === "error")
      .map(([id]) => id)
      .filter((id) => pendingSavesRef.current.has(id));
    if (!ids.length) return 0;
    await Promise.all(ids.map((id) => runSave(id).catch(() => undefined)));
    return ids.length;
  }, [runSave]);

  const clearPendingForNote = useCallback((noteId: string, savedDraft?: NoteDraft) => {
    const timer = saveTimersRef.current.get(noteId);
    if (timer) clearTimeout(timer);
    saveTimersRef.current.delete(noteId);

    const recoveryTimer = draftRecoveryTimersRef.current.get(noteId);
    if (recoveryTimer) clearTimeout(recoveryTimer);
    draftRecoveryTimersRef.current.delete(noteId);

    pendingSavesRef.current.delete(noteId);
    pendingFieldsRef.current.delete(noteId);
    unconfirmedSavesRef.current.delete(noteId);
    failedSavesRef.current.delete(noteId);
    clearDraftRecovery(noteId, savedDraft);
  }, []);

  const cancelSaveTimer = useCallback((noteId: string) => {
    const timer = saveTimersRef.current.get(noteId);
    if (timer) clearTimeout(timer);
    saveTimersRef.current.delete(noteId);
  }, []);

  const saveImmediately = useCallback(
    async (draft: Note | NoteDraft, keepalive = false, changedFields?: SaveField[]) => {
      const pendingDraft = toNoteDraft(draft);
      pendingDraft.previousTitle ??= pendingSavesRef.current.get(pendingDraft.id)?.previousTitle;
      const failure = failedSavesRef.current.get(pendingDraft.id);
      if (isMissingNoteError(failure)) throw failure;
      cancelSaveTimer(pendingDraft.id);
      pendingSavesRef.current.set(pendingDraft.id, pendingDraft);
      const fields = pendingFieldsRef.current.get(pendingDraft.id) ?? new Set<SaveField>();
      for (const field of changedFields ?? ALL_SAVE_FIELDS) fields.add(field);
      pendingFieldsRef.current.set(pendingDraft.id, fields);
      if (activeNoteIdRef.current === pendingDraft.id) setSaveState("saving");
      return runSave(pendingDraft.id, keepalive);
    },
    [activeNoteIdRef, cancelSaveTimer, runSave],
  );

  const saveFavorite = useCallback(
    async (noteId: string, isFavorite: boolean) => {
      const localDraft = () =>
        pendingSavesRef.current.get(noteId) ??
        (selectedRef.current?.id === noteId ? selectedRef.current : undefined);
      let draft = localDraft();
      if (!draft) {
        const result = await api.getNote(noteId);
        // Edits or another save may have arrived while the note was loading.
        draft = localDraft() ?? result.note;
      }
      await saveImmediately({ ...draft, isFavorite }, false, ["isFavorite"]);
    },
    [saveImmediately, selectedRef],
  );

  const moveNoteToNotebook = useCallback(
    async (id: string, notebookId: string) => {
      const currentNote = () =>
        (selectedRef.current?.id === id ? selectedRef.current : undefined) ??
        (splitSelectedRef?.current?.id === id ? splitSelectedRef.current : undefined) ??
        notesRef.current.find((note) => note.id === id);
      const fallback = currentNote() ?? (await api.getNoteSummary(id)).note;
      if (activeNoteIdRef.current === id || splitNoteIdRef?.current === id)
        flushEditorDraftRef.current();
      const savedVersion = await runSave(id);

      const current = currentNote() ?? fallback;
      const version = savedVersion ?? current.version;
      if (current.deletedAt !== null || trashOperationsRef.current.has(id))
        throw new ApiError(409, "NOTE_MOVE_UNAVAILABLE", "这篇笔记当前无法移动");
      if (current.notebookId === notebookId) return false;

      const task = api
        .updateNote(id, { version, notebookId }, { response: "summary" })
        .then(async ({ note }) => {
          // A read already in flight may still return the previous notebook and version.
          await Promise.all([
            activeNoteIdRef.current === id ? noteOpeningRef?.current : null,
            splitNoteIdRef?.current === id ? splitNoteOpeningRef?.current : null,
          ]);
          const summary = "contentMarkdown" in note ? toNoteSummary(note) : note;
          const draft = pendingSavesRef.current.get(id);
          const localDraft = draft?.version === version ? draft : undefined;
          if (localDraft) {
            pendingSavesRef.current.set(id, {
              ...localDraft,
              notebookId: summary.notebookId,
              version: summary.version,
            });
          }
          const fields = pendingFieldsRef.current.get(id);
          const applySummary = <T extends NoteSummary>(local: T): T =>
            local.id === id && local.version < summary.version
              ? {
                  ...local,
                  ...summary,
                  ...(localDraft && fields?.has("title") ? { title: localDraft.title } : {}),
                  ...(localDraft && fields?.has("isFavorite")
                    ? { isFavorite: localDraft.isFavorite }
                    : {}),
                }
              : local;
          if (selectedRef.current?.id === id && activeNoteIdRef.current === id) {
            selectedRef.current = applySummary(selectedRef.current);
            setSelectedNote(selectedRef.current);
          }
          if (splitSelectedRef?.current?.id === id && splitNoteIdRef?.current === id) {
            splitSelectedRef.current = applySummary(splitSelectedRef.current);
            setSplitSelectedNote?.(splitSelectedRef.current);
          }
          replaceList(notesRef.current.map(applySummary));
        });
      notebookMovesRef.current.set(id, task);
      try {
        await task;
        return true;
      } finally {
        notebookMovesRef.current.delete(id);
      }
    },
    [
      activeNoteIdRef,
      flushEditorDraftRef,
      noteOpeningRef,
      notesRef,
      replaceList,
      runSave,
      selectedRef,
      setSelectedNote,
      setSplitSelectedNote,
      splitNoteIdRef,
      splitNoteOpeningRef,
      splitSelectedRef,
      trashOperationsRef,
    ],
  );

  const flushNotebookSaves = useCallback(
    async (notebookId: string) => {
      flushEditorDraftRef.current();
      const ids = [...pendingSavesRef.current.values()]
        .filter((draft) => draft.notebookId === notebookId)
        .map((draft) => draft.id);
      await Promise.all(ids.map((id) => runSave(id)));
    },
    [flushEditorDraftRef, runSave],
  );

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
  useEffect(
    () => () => {
      for (const draft of pendingSavesRef.current.values()) writeDraftRecovery(draft);
      void flushPendingSaves("keepalive");
      for (const timer of saveTimersRef.current.values()) clearTimeout(timer);
      saveTimersRef.current.clear();
      for (const timer of draftRecoveryTimersRef.current.values()) clearTimeout(timer);
      draftRecoveryTimersRef.current.clear();
    },
    [flushPendingSaves],
  );

  return {
    saveState,
    setSaveState,
    pendingSavesRef,
    failedSavesRef,
    persist,
    runSave,
    saveImmediately,
    saveFavorite,
    moveNoteToNotebook,
    flushNotebookSaves,
    saveNoteNow,
    cancelSaveTimer,
    flushPendingSaves,
    flushDraftRecoveries,
    retryFailedSaves,
    hasUnsavedWork,
    markNoteMissing,
    clearPendingForNote,
  };
}
