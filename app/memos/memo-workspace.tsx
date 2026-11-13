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
import type { Memo, MemoDayCount, MemoTagCount } from "../../shared/types";
import { api, ApiError } from "../api";
import {
  browserTimeZone,
  currentMonthKey,
  dayBounds,
  localDateKey,
  monthBounds,
  selectedDayCreateTime,
} from "./memo-date";

export type MemoViewMode = "timeline" | "calendar";

type MemoWorkspaceValue = {
  mode: MemoViewMode;
  setMode: (mode: MemoViewMode) => void;
  queryDraft: string;
  setQueryDraft: (query: string) => void;
  query: string;
  tag: string | null;
  setTag: (tag: string | null) => void;
  miniMonth: string;
  setMiniMonth: (month: string) => void;
  selectedDate: string | null;
  setSelectedDate: (date: string | null) => void;
  calendarMonth: string;
  setCalendarMonth: (month: string) => void;
  calendarDate: string | null;
  setCalendarDate: (date: string | null) => void;
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
};

const MemoWorkspaceContext = createContext<MemoWorkspaceValue | null>(null);

function errorMessage(reason: unknown, fallback: string) {
  return reason instanceof ApiError && reason.message ? reason.message : fallback;
}

function readDraft(key: string) {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
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
  const [mode, setMode] = useState<MemoViewMode>("timeline");
  const [queryDraft, setQueryDraft] = useState("");
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  const [miniMonth, setMiniMonth] = useState(() => currentMonthKey());
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [calendarMonth, setCalendarMonth] = useState(() => currentMonthKey());
  const [calendarDate, setCalendarDate] = useState<string | null>(() => localDateKey(Date.now()));
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
  const [draft, setDraftState] = useState(() => readDraft(draftKey));
  const listRequestRef = useRef(0);
  const facetRequestRef = useRef(0);
  const listAbortRef = useRef<AbortController | null>(null);
  const facetAbortRef = useRef<AbortController | null>(null);
  const loadMoreBusyRef = useRef(false);
  const loadedListScopeRef = useRef("");
  const memosRef = useRef<Memo[]>([]);
  const activeRef = useRef(active);
  activeRef.current = active;
  memosRef.current = memos;

  const unauthorized = useCallback(
    (reason: unknown) => {
      if (reason instanceof ApiError && reason.status === 401) onUnauthorized();
    },
    [onUnauthorized],
  );

  useEffect(() => {
    setDraftState(readDraft(draftKey));
  }, [draftKey]);

  const setDraft = useCallback(
    (markdown: string) => {
      setDraftState(markdown);
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

  const facetMonth = mode === "calendar" ? calendarMonth : miniMonth;
  const facetBounds = useMemo(() => monthBounds(facetMonth), [facetMonth]);
  const listDate = mode === "calendar" ? calendarDate : selectedDate;
  const listBounds = useMemo(() => (listDate ? dayBounds(listDate) : null), [listDate]);
  const listScope = useMemo(
    () => JSON.stringify([query, tag, listBounds?.from ?? null, listBounds?.to ?? null]),
    [listBounds, query, tag],
  );

  const refresh = useCallback(() => {
    if (memosRef.current.length === 0) setLoading(true);
    setRefreshToken((value) => value + 1);
    setFacetRefreshToken((value) => value + 1);
  }, []);
  const refreshFacets = useCallback(() => setFacetRefreshToken((value) => value + 1), []);

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
    loadMoreBusyRef.current = false;
    const scopeChanged = loadedListScopeRef.current !== listScope;
    loadedListScopeRef.current = listScope;
    if (scopeChanged) {
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
        setMemos(result.memos);
        setNextCursor(result.nextCursor);
      })
      .catch((reason) => {
        if (controller.signal.aborted) return;
        setError(errorMessage(reason, "随记加载失败，请重试"));
        unauthorized(reason);
      })
      .finally(() => {
        if (requestId === listRequestRef.current) setLoading(false);
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
      setMemos((current) => [...current, ...result.memos]);
      setNextCursor(result.nextCursor);
    } catch (reason) {
      if (requestId !== listRequestRef.current) return;
      setMoreError(errorMessage(reason, "更多随记加载失败"));
      unauthorized(reason);
    } finally {
      if (requestId === listRequestRef.current) setLoadingMore(false);
      loadMoreBusyRef.current = false;
    }
  }, [listBounds, loadingMore, nextCursor, query, tag, unauthorized]);

  const createMemo = useCallback(
    async (contentMarkdown: string, date?: string | null) => {
      try {
        const result = await api.createMemo({
          contentMarkdown,
          ...(date ? { createdAt: selectedDayCreateTime(date) } : {}),
        });
        setDraft("");
        const inDateRange =
          !listBounds ||
          (result.memo.createdAt >= listBounds.from && result.memo.createdAt < listBounds.to);
        if (!query && !tag && inDateRange) {
          setMemos((current) => [
            result.memo,
            ...current.filter((item) => item.id !== result.memo.id),
          ]);
          refreshFacets();
        } else refresh();
        return result.memo;
      } catch (reason) {
        unauthorized(reason);
        throw reason;
      }
    },
    [listBounds, query, refresh, refreshFacets, setDraft, tag, unauthorized],
  );

  const updateMemo = useCallback(
    async (memo: Memo, contentMarkdown: string) => {
      try {
        const result = await api.updateMemo(memo.id, { version: memo.version, contentMarkdown });
        setMemos((current) => current.map((item) => (item.id === memo.id ? result.memo : item)));
        if (query || tag) refresh();
        else refreshFacets();
        return result.memo;
      } catch (reason) {
        unauthorized(reason);
        throw reason;
      }
    },
    [query, refresh, refreshFacets, tag, unauthorized],
  );

  const deleteMemo = useCallback(
    async (memo: Memo) => {
      try {
        await api.deleteMemo(memo.id, memo.version);
        setMemos((current) => current.filter((item) => item.id !== memo.id));
        refreshFacets();
      } catch (reason) {
        unauthorized(reason);
        throw reason;
      }
    },
    [refreshFacets, unauthorized],
  );

  const value: MemoWorkspaceValue = {
    mode,
    setMode,
    queryDraft,
    setQueryDraft,
    query,
    tag,
    setTag,
    miniMonth,
    setMiniMonth,
    selectedDate,
    setSelectedDate,
    calendarMonth,
    setCalendarMonth,
    calendarDate,
    setCalendarDate,
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
  };

  return <MemoWorkspaceContext.Provider value={value}>{children}</MemoWorkspaceContext.Provider>;
}

export function useMemoWorkspace() {
  const value = useContext(MemoWorkspaceContext);
  if (!value) throw new Error("useMemoWorkspace must be used inside MemoWorkspaceProvider");
  return value;
}
