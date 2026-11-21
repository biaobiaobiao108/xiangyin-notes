import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Memo, MemoDayCount, MemoTagCount, Note } from "../../shared/types";
import { api, ApiError } from "../api";
import { createUuid } from "../uuid";
import {
  browserTimeZone,
  currentMonthKey,
  dayBounds,
  monthBounds,
  selectedDayCreateTime,
} from "./memo-date";
import { hasMemoEditDraft, readMemoEditDraft } from "./memo-edit-draft";

type MemoWorkspaceValue = {
  queryDraft: string;
  setQueryDraft: (query: string) => void;
  query: string;
  tag: string | null;
  setTag: (tag: string | null) => void;
  miniMonth: string;
  setMiniMonth: (month: string) => void;
  selectedDate: string | null;
  setSelectedDate: (date: string | null) => void;
  dayCounts: Record<string, number>;
  tagCounts: MemoTagCount[];
  facetsLoading: boolean;
  facetsError: string | null;
  memos: Memo[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  moreError: string | null;
  draft: string;
  setDraft: (markdown: string) => void;
  refresh: () => void;
  loadMore: () => Promise<void>;
  createMemo: (contentMarkdown: string, date?: string | null) => Promise<Memo>;
  updateMemo: (memo: Memo, contentMarkdown: string) => Promise<Memo>;
  deleteMemo: (memo: Memo) => Promise<void>;
  convertMemo: (memo: Memo) => Promise<Note>;
};

const MemoWorkspaceContext = createContext<MemoWorkspaceValue | null>(null);

function errorMessage(reason: unknown, fallback: string) {
  return reason instanceof ApiError && reason.message ? reason.message : fallback;
}

export function memoConflictCurrent(reason: unknown): Memo | null {
  if (!(reason instanceof ApiError) || reason.code !== "VERSION_CONFLICT") return null;
  const error = reason.details?.error as { current?: unknown } | undefined;
  const current = error?.current as Partial<Memo> | null | undefined;
  if (
    !current ||
    typeof current.id !== "string" ||
    typeof current.contentMarkdown !== "string" ||
    !Number.isSafeInteger(current.version) ||
    !Array.isArray(current.tags) ||
    typeof current.createdAt !== "number" ||
    typeof current.updatedAt !== "number"
  )
    return null;
  return current as Memo;
}

const MEMO_SUBMISSION_FORMAT = "xiangying.memo-submission.v1";

type MemoSubmission = {
  id: string;
  markdown: string;
  createdAt?: number;
};

function readDraft(key: string): { markdown: string; submission?: MemoSubmission } {
  let markdown: string;
  try {
    markdown = localStorage.getItem(key) ?? "";
  } catch {
    return { markdown: "" };
  }
  // Existing drafts are stored as plain Markdown.
  if (markdown.startsWith(`{"format":"${MEMO_SUBMISSION_FORMAT}",`)) {
    try {
      const record = JSON.parse(markdown) as Partial<MemoSubmission>;
      if (
        typeof record.id === "string" &&
        typeof record.markdown === "string" &&
        (record.createdAt === undefined || Number.isSafeInteger(record.createdAt))
      ) {
        return { markdown: record.markdown, submission: record as MemoSubmission };
      }
    } catch {
      return { markdown };
    }
  }
  return { markdown };
}

export function invalidateMemoListRequest(
  requestRef: { current: number },
  abortRef: { current: AbortController | null },
) {
  abortRef.current?.abort();
  abortRef.current = null;
  requestRef.current += 1;
}

export function mergeMemoPagePreservingLoadedItems(current: Memo[], firstPage: Memo[]) {
  const merged = new Map(current.map((memo) => [memo.id, memo]));
  for (const memo of firstPage) merged.set(memo.id, memo);
  return [...merged.values()].sort(
    (left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id),
  );
}

export function reconcileMemoListRefresh(
  current: Memo[],
  firstPage: Memo[],
  currentCursor: string | null,
  freshCursor: string | null,
  preserveLoadedPages: boolean,
) {
  if (!preserveLoadedPages || current.length <= firstPage.length)
    return { memos: firstPage, nextCursor: freshCursor };
  return {
    memos: mergeMemoPagePreservingLoadedItems(current, firstPage),
    nextCursor: currentCursor,
  };
}

export function MemoWorkspaceProvider({
  active,
  userKey,
  externalRevision,
  onUnauthorized,
  children,
}: {
  active: boolean;
  userKey: string;
  externalRevision: number;
  onUnauthorized: () => void;
  children: ReactNode;
}) {
  const [queryDraft, setQueryDraft] = useState("");
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  const [miniMonth, setMiniMonth] = useState(() => currentMonthKey());
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [dayCounts, setDayCounts] = useState<Record<string, number>>({});
  const [tagCounts, setTagCounts] = useState<MemoTagCount[]>([]);
  const [facetsLoading, setFacetsLoading] = useState(false);
  const [facetsError, setFacetsError] = useState<string | null>(null);
  const [memos, setMemos] = useState<Memo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [facetRefreshToken, setFacetRefreshToken] = useState(0);
  const draftKey = `xiangying:memo-draft:${userKey || "default"}`;
  const [draft, setDraftState] = useState(() => readDraft(draftKey).markdown);
  const draftRevisionRef = useRef(0);
  const submissionRef = useRef<MemoSubmission | undefined>(undefined);
  const listRequestRef = useRef(0);
  const facetRequestRef = useRef(0);
  const listAbortRef = useRef<AbortController | null>(null);
  const facetAbortRef = useRef<AbortController | null>(null);
  const loadMoreBusyRef = useRef(false);
  const listRequestPendingRef = useRef(false);
  const preserveLoadedPagesRef = useRef(false);
  const loadedListScopeRef = useRef("");
  const currentListScopeRef = useRef("");
  const memosRef = useRef<Memo[]>([]);
  const nextCursorRef = useRef<string | null>(nextCursor);
  const activeRef = useRef(active);
  activeRef.current = active;
  memosRef.current = memos;
  nextCursorRef.current = nextCursor;

  const unauthorized = useCallback(
    (reason: unknown) => {
      if (reason instanceof ApiError && reason.status === 401) onUnauthorized();
    },
    [onUnauthorized],
  );

  useEffect(() => {
    draftRevisionRef.current += 1;
    const recovered = readDraft(draftKey);
    submissionRef.current = recovered.submission;
    setDraftState(recovered.markdown);
  }, [draftKey]);

  const setDraft = useCallback(
    (markdown: string) => {
      draftRevisionRef.current += 1;
      setDraftState(markdown);
      if (submissionRef.current?.markdown === markdown) return;
      submissionRef.current = undefined;
      try {
        if (markdown) localStorage.setItem(draftKey, markdown);
        else localStorage.removeItem(draftKey);
      } catch {}
    },
    [draftKey],
  );

  useEffect(() => {
    const timer = setTimeout(() => setQuery(queryDraft.trim()), 220);
    return () => clearTimeout(timer);
  }, [queryDraft]);

  const facetBounds = useMemo(() => monthBounds(miniMonth), [miniMonth]);
  const listBounds = useMemo(() => (selectedDate ? dayBounds(selectedDate) : null), [selectedDate]);
  const listScope = useMemo(
    () => JSON.stringify([query, tag, listBounds?.from ?? null, listBounds?.to ?? null]),
    [listBounds, query, tag],
  );
  currentListScopeRef.current = listScope;

  const refresh = useCallback(() => {
    if (memosRef.current.length === 0) setLoading(true);
    setRefreshToken((value) => value + 1);
    setFacetRefreshToken((value) => value + 1);
  }, []);
  const refreshFacets = useCallback(() => setFacetRefreshToken((value) => value + 1), []);
  const invalidateListRequest = useCallback(() => {
    const shouldReload = listRequestPendingRef.current || loadMoreBusyRef.current;
    preserveLoadedPagesRef.current = shouldReload && !query && !tag && memosRef.current.length > 0;
    invalidateMemoListRequest(listRequestRef, listAbortRef);
    loadMoreBusyRef.current = false;
    listRequestPendingRef.current = false;
    setLoading(false);
    setLoadingMore(false);
    return shouldReload;
  }, [query, tag]);

  useEffect(() => {
    if (!active || !facetBounds) return;
    facetAbortRef.current?.abort();
    const controller = new AbortController();
    facetAbortRef.current = controller;
    const requestId = ++facetRequestRef.current;
    setFacetsLoading(true);
    setFacetsError(null);
    void api
      .getMemoFacets(
        {
          from: facetBounds.from,
          to: facetBounds.to,
          timeZone: browserTimeZone(),
          query: query || undefined,
          tag: tag || undefined,
        },
        { signal: controller.signal },
      )
      .then((result) => {
        if (requestId !== facetRequestRef.current) return;
        setDayCounts(
          Object.fromEntries(result.days.map((day: MemoDayCount) => [day.date, day.count])),
        );
        setTagCounts(result.tags);
      })
      .catch((reason) => {
        if (controller.signal.aborted) return;
        if (requestId === facetRequestRef.current)
          setFacetsError(errorMessage(reason, "日期与标签统计加载失败"));
        unauthorized(reason);
      })
      .finally(() => {
        if (requestId === facetRequestRef.current) setFacetsLoading(false);
      });
    return () => controller.abort();
  }, [active, facetBounds, query, tag, facetRefreshToken, unauthorized]);

  useEffect(() => {
    if (!active) return;
    listAbortRef.current?.abort();
    const controller = new AbortController();
    listAbortRef.current = controller;
    const requestId = ++listRequestRef.current;
    listRequestPendingRef.current = true;
    loadMoreBusyRef.current = false;
    const scopeChanged = loadedListScopeRef.current !== listScope;
    loadedListScopeRef.current = listScope;
    if (scopeChanged) {
      preserveLoadedPagesRef.current = false;
      setLoading(true);
      setMemos([]);
      setNextCursor(null);
    }
    setError(null);
    setMoreError(null);
    setLoadingMore(false);
    void api
      .listMemos(
        {
          query: query || undefined,
          tag: tag || undefined,
          from: listBounds?.from,
          to: listBounds?.to,
        },
        { signal: controller.signal },
      )
      .then((result) => {
        if (requestId !== listRequestRef.current) return;
        const preserveLoadedPages =
          preserveLoadedPagesRef.current && !scopeChanged && !query && !tag;
        preserveLoadedPagesRef.current = false;
        if (preserveLoadedPages) {
          const refreshed = reconcileMemoListRefresh(
            memosRef.current,
            result.memos,
            nextCursorRef.current,
            result.nextCursor,
            true,
          );
          setMemos(refreshed.memos);
          setNextCursor(refreshed.nextCursor);
        } else {
          setMemos(result.memos);
          setNextCursor(result.nextCursor);
        }
      })
      .catch((reason) => {
        if (controller.signal.aborted) return;
        setError(errorMessage(reason, "随记加载失败，请重试"));
        unauthorized(reason);
      })
      .finally(() => {
        if (requestId === listRequestRef.current) {
          listRequestPendingRef.current = false;
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [active, listBounds, listScope, query, tag, refreshToken, unauthorized]);

  useEffect(() => {
    if (!active || externalRevision === 0) return;
    refresh();
  }, [active, externalRevision, refresh]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore || loadMoreBusyRef.current || !activeRef.current) return;
    loadMoreBusyRef.current = true;
    const requestId = listRequestRef.current;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const result = await api.listMemos({
        query: query || undefined,
        tag: tag || undefined,
        from: listBounds?.from,
        to: listBounds?.to,
        cursor: nextCursor,
      });
      if (requestId !== listRequestRef.current) return;
      setMemos((current) => mergeMemoPagePreservingLoadedItems(current, result.memos));
      setNextCursor(result.nextCursor);
    } catch (reason) {
      if (requestId !== listRequestRef.current) return;
      setMoreError(errorMessage(reason, "更多随记加载失败"));
      unauthorized(reason);
    } finally {
      if (requestId === listRequestRef.current) {
        setLoadingMore(false);
        loadMoreBusyRef.current = false;
      }
    }
  }, [listBounds, loadingMore, nextCursor, query, tag, unauthorized]);

  const createMemo = useCallback(
    async (contentMarkdown: string, date?: string | null) => {
      const scopeAtStart = listScope;
      const revisionAtStart = draftRevisionRef.current;
      const stored = readDraft(draftKey).submission;
      // The editor may normalize a draft on reload. An edit clears this ref in setDraft.
      const submission = submissionRef.current ??
        (stored?.markdown === contentMarkdown ? stored : undefined) ?? {
          id: createUuid(),
          markdown: contentMarkdown,
          ...(date ? { createdAt: selectedDayCreateTime(date) } : {}),
        };
      submissionRef.current = submission;
      // Persist the exact payload before sending it so refresh can retry the same creation.
      try {
        localStorage.setItem(
          draftKey,
          JSON.stringify({ format: MEMO_SUBMISSION_FORMAT, ...submission }),
        );
      } catch (error) {
        console.warn("[memos] 无法将提交记录写入本地草稿", error);
      }
      try {
        const result = await api.createMemo({
          id: submission.id,
          contentMarkdown: submission.markdown,
          createdAt: submission.createdAt,
        });
        if (submissionRef.current?.id === submission.id) submissionRef.current = undefined;
        const shouldReload = invalidateListRequest();
        if (draftRevisionRef.current === revisionAtStart) {
          setDraftState("");
          const current = readDraft(draftKey);
          if (
            current.submission?.id === submission.id ||
            (!current.submission && current.markdown === submission.markdown)
          ) {
            try {
              localStorage.removeItem(draftKey);
            } catch (error) {
              console.warn("[memos] 无法清除已提交的本地草稿", error);
            }
          }
        }
        if (scopeAtStart !== currentListScopeRef.current) {
          refresh();
          return result.memo;
        }
        const inDateRange =
          !listBounds ||
          (result.memo.createdAt >= listBounds.from && result.memo.createdAt < listBounds.to);
        if (!query && !tag && inDateRange) {
          setMemos((current) => mergeMemoPagePreservingLoadedItems(current, [result.memo]));
          refreshFacets();
        } else refresh();
        if (shouldReload && !query && !tag && inDateRange) refresh();
        return result.memo;
      } catch (reason) {
        unauthorized(reason);
        throw reason;
      }
    },
    [
      draftKey,
      invalidateListRequest,
      listBounds,
      listScope,
      query,
      refresh,
      refreshFacets,
      tag,
      unauthorized,
    ],
  );

  const updateMemo = useCallback(
    async (memo: Memo, contentMarkdown: string) => {
      const scopeAtStart = listScope;
      try {
        const result = await api
          .updateMemo(memo.id, { version: memo.version, contentMarkdown })
          .catch((reason: unknown) => {
            const current = memoConflictCurrent(reason);
            if (current && current.id === memo.id && current.contentMarkdown === contentMarkdown)
              return { memo: current };
            throw reason;
          });
        const shouldReload = invalidateListRequest();
        if (scopeAtStart !== currentListScopeRef.current) {
          refresh();
          return result.memo;
        }
        setMemos((current) => current.map((item) => (item.id === memo.id ? result.memo : item)));
        if (query || tag || shouldReload) refresh();
        else refreshFacets();
        return result.memo;
      } catch (reason) {
        unauthorized(reason);
        throw reason;
      }
    },
    [invalidateListRequest, listScope, query, refresh, refreshFacets, tag, unauthorized],
  );

  const deleteMemo = useCallback(
    async (memo: Memo) => {
      const scopeAtStart = listScope;
      try {
        const draft = readMemoEditDraft(memo.id);
        if (draft?.conflict) throw new Error("这条随记有未处理的冲突草稿，请先打开并处理草稿");
        if (draft) throw new Error("这条随记有未保存的编辑草稿，请先打开并处理草稿");
        if (hasMemoEditDraft(memo.id))
          throw new Error("无法读取这条随记的本地草稿，请先打开并处理草稿");
        await api.deleteMemo(memo.id, memo.version);
        const shouldReload = invalidateListRequest();
        if (scopeAtStart !== currentListScopeRef.current) {
          refresh();
          return;
        }
        setMemos((current) => current.filter((item) => item.id !== memo.id));
        refreshFacets();
        if (shouldReload) refresh();
      } catch (reason) {
        unauthorized(reason);
        throw reason;
      }
    },
    [invalidateListRequest, listScope, refresh, refreshFacets, unauthorized],
  );

  const convertMemo = useCallback(
    async (memo: Memo) => {
      try {
        const result = await api.convertMemo(memo.id, memo.version);
        const shouldReload = invalidateListRequest();
        setMemos((current) => current.filter((item) => item.id !== memo.id));
        refreshFacets();
        if (shouldReload || query || tag) refresh();
        return result.note;
      } catch (reason) {
        unauthorized(reason);
        throw reason;
      }
    },
    [invalidateListRequest, query, tag, refresh, refreshFacets, unauthorized],
  );

  const value: MemoWorkspaceValue = {
    queryDraft,
    setQueryDraft,
    query,
    tag,
    setTag,
    miniMonth,
    setMiniMonth,
    selectedDate,
    setSelectedDate,
    dayCounts,
    tagCounts,
    facetsLoading,
    facetsError,
    memos,
    loading,
    error,
    hasMore: nextCursor !== null,
    loadingMore,
    moreError,
    draft,
    setDraft,
    refresh,
    loadMore,
    createMemo,
    updateMemo,
    deleteMemo,
    convertMemo,
  };

  return <MemoWorkspaceContext.Provider value={value}>{children}</MemoWorkspaceContext.Provider>;
}

export function useMemoWorkspace() {
  const value = useContext(MemoWorkspaceContext);
  if (!value) throw new Error("useMemoWorkspace must be used inside MemoWorkspaceProvider");
  return value;
}
