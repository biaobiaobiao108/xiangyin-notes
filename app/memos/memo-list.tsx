import { useEffect, useMemo, useRef, useState, type MutableRefObject, type RefObject } from "react";
import type { Memo } from "../../shared/types";
import { FloatingScrollbar } from "../floating-scrollbar";
import { useSwipeActionGroup } from "../workspace/swipe-actions";
import { useScrollEdges } from "../workspace/use-scroll-edges";
import { MiniCalendar } from "./memo-calendar";
import { MemoCard, type MemoNotice } from "./memo-card";
import { dayHeading, groupedByLocalDate, timelineDateLabel } from "./memo-date";
import { useMemoWorkspace } from "./memo-workspace";
import {
  flattenMemoGroups,
  includePinnedMemo,
  memoRowId,
  useMemoPageScroller,
  useVirtualMemoList,
} from "./use-virtual-memo-list";

export function MemoList({
  editingMemo,
  setEditingMemo,
  scrollRef,
  pageScrollRef,
  onBeginEditRef,
  onConvert,
  onSaveNotice,
  isMobileViewport,
}: {
  editingMemo: Memo | null;
  setEditingMemo: (memo: Memo | null) => void;
  scrollRef: RefObject<HTMLDivElement | null>;
  pageScrollRef: RefObject<HTMLElement | null>;
  onBeginEditRef?: MutableRefObject<((memo: Memo) => void) | null>;
  onConvert: (memo: Memo) => Promise<void>;
  onSaveNotice: (notice: MemoNotice) => void;
  isMobileViewport: boolean;
}) {
  const {
    memos,
    loading,
    error,
    hasMore,
    loadingMore,
    moreError,
    refresh,
    loadMore,
    deleteMemo,
    setTag,
    query,
    tag,
    selectedDate,
    setQueryDraft,
    setSelectedDate,
  } = useMemoWorkspace();
  const pageScroller = useMemoPageScroller();
  const visibleMemos = useMemo(() => includePinnedMemo(memos, editingMemo), [editingMemo, memos]);
  const groups = useMemo(() => groupedByLocalDate(visibleMemos), [visibleMemos]);
  const rows = useMemo(() => flattenMemoGroups(groups), [groups]);
  const scope = JSON.stringify([query, tag, selectedDate]);
  const swipeActions = useSwipeActionGroup(
    pageScroller ? pageScrollRef : scrollRef,
    isMobileViewport,
    scope,
  );
  const [focusedMemoId, setFocusedMemoId] = useState<string | null>(null);
  const [editingWasVirtualized, setEditingWasVirtualized] = useState(false);
  const editingSessionRef = useRef(0);
  const editingSession = editingSessionRef.current;
  const pinnedRowId = editingMemo
    ? memoRowId(editingMemo.id)
    : focusedMemoId
      ? memoRowId(focusedMemoId)
      : null;
  const virtualList = useVirtualMemoList(
    rows,
    scrollRef,
    pageScrollRef,
    pageScroller,
    scope,
    visibleMemos.length,
    pinnedRowId,
    editingMemo ? editingWasVirtualized : null,
  );
  const [loadMoreSentinel, setLoadMoreSentinel] = useState<HTMLElement | null>(null);
  const canAutoLoad = typeof IntersectionObserver !== "undefined";
  const filtered = Boolean(query || tag || selectedDate);
  const holdCardHeight = (id: string) => {
    const card = scrollRef.current?.querySelector<HTMLElement>(
      `[data-memo-id="${CSS.escape(id)}"]`,
    );
    if (!card?.querySelector(".mermaid-body")) return;
    // Replacing the preview briefly shrinks the card. Keep Safari from
    // clamping the scroll position before the new preview restores its height.
    card.style.minBlockSize = `${card.offsetHeight}px`;
  };
  const beginEdit = (memo: Memo) => {
    if (editingMemo?.id === memo.id) return;
    if (editingMemo) holdCardHeight(editingMemo.id);
    holdCardHeight(memo.id);
    swipeActions.close();
    editingSessionRef.current += 1;
    setEditingWasVirtualized(virtualList.isVirtualized);
    setEditingMemo(memo);
  };
  const finishEdit = (session: number) => {
    if (editingSessionRef.current !== session || !editingMemo) return;
    holdCardHeight(editingMemo.id);
    editingSessionRef.current += 1;
    setEditingWasVirtualized(false);
    setEditingMemo(null);
  };

  useEffect(() => {
    if (onBeginEditRef) onBeginEditRef.current = beginEdit;
    return () => {
      if (onBeginEditRef) onBeginEditRef.current = null;
    };
  });

  useEffect(() => {
    const sentinel = loadMoreSentinel;
    const root = scrollRef.current;
    if (!sentinel || !root || !hasMore || !canAutoLoad || loadingMore || moreError) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) void loadMore();
      },
      { root: pageScroller ? pageScrollRef.current : root, rootMargin: "360px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [
    canAutoLoad,
    hasMore,
    loadMore,
    loadMoreSentinel,
    loadingMore,
    moreError,
    pageScrollRef,
    pageScroller,
    scrollRef,
  ]);

  if (loading && !editingMemo) {
    return (
      <div className="memo-skeleton-list" aria-busy="true" aria-label="正在加载随记">
        {[0, 1, 2].map((item) => (
          <div className="memo-skeleton" key={item} aria-hidden="true">
            <span />
            <strong />
            <i />
          </div>
        ))}
      </div>
    );
  }

  if (error && memos.length === 0 && !editingMemo) {
    return (
      <div className="memo-state memo-state--error" role="alert">
        <strong>随记没有加载出来</strong>
        <span>{error}</span>
        <button type="button" onClick={refresh}>
          重试
        </button>
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div className="memo-state">
        <strong>{filtered ? "没有找到随记" : "还没有随记"}</strong>
        {filtered && (
          <button
            type="button"
            onClick={() => {
              setQueryDraft("");
              setTag(null);
              setSelectedDate(null);
            }}
          >
            清除筛选
          </button>
        )}
      </div>
    );
  }

  const renderMemoCard = (memo: Memo) => (
    <MemoCard
      memo={memo}
      editing={editingMemo?.id === memo.id}
      editingVersion={editingMemo?.id === memo.id ? editingMemo.version : null}
      onEdit={() => beginEdit(memo)}
      onFinishEdit={() => finishEdit(editingSession)}
      onSaveNotice={onSaveNotice}
      onConvert={onConvert}
      mobile={isMobileViewport}
      swipeOpen={swipeActions.openId === memo.id}
      setSwipeOpenId={swipeActions.setOpenId}
      onDelete={async (target) => {
        await deleteMemo(target);
        if (editingMemo?.id === target.id) finishEdit(editingSession);
      }}
    />
  );
  const loadMoreFooter = hasMore ? (
    <div ref={setLoadMoreSentinel} className="memo-load-sentinel" aria-live="polite">
      {loadingMore ? (
        <span role="status">正在加载更多随记…</span>
      ) : moreError ? (
        <>
          <span role="alert">{moreError}</span>
          <button type="button" onClick={() => void loadMore()}>
            重试
          </button>
        </>
      ) : !canAutoLoad ? (
        <button type="button" onClick={() => void loadMore()}>
          加载更多
        </button>
      ) : (
        <span className="visually-hidden">继续向下滚动以加载更多随记</span>
      )}
    </div>
  ) : null;

  return (
    <div className="memo-timeline">
      {error && (
        <div className="memo-inline-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={refresh}>
            重试
          </button>
        </div>
      )}
      {virtualList.isVirtualized ? (
        <>
          <div
            ref={virtualList.listRef}
            className="memo-virtual-list"
            role="list"
            aria-label="随记时间线"
            style={{ height: `${virtualList.totalHeight}px` }}
            onFocusCapture={(event) => {
              const rowId = (event.target as HTMLElement).closest<HTMLElement>("[data-memo-id]")
                ?.dataset.memoId;
              setFocusedMemoId(rowId ?? null);
            }}
            onBlurCapture={(event) => {
              const next = event.relatedTarget;
              const rowId =
                next instanceof HTMLElement
                  ? next.closest<HTMLElement>("[data-memo-id]")?.dataset.memoId
                  : undefined;
              setFocusedMemoId(rowId ?? null);
            }}
          >
            {virtualList.visibleRows.map(({ row, top }) =>
              row.kind === "day" ? (
                <div
                  key={row.id}
                  ref={virtualList.getRowRef(row.id)}
                  data-memo-row-id={row.id}
                  data-memo-day={row.date}
                  className={`memo-virtual-day ${row.first ? "is-first" : ""}`.trim()}
                  style={virtualList.rowStyle(top)}
                  role="listitem"
                  aria-label={dayHeading(row.date)}
                >
                  <h2>
                    <time dateTime={row.date}>{timelineDateLabel(row.date)}</time>
                  </h2>
                </div>
              ) : (
                <div
                  key={row.id}
                  ref={virtualList.getRowRef(row.id)}
                  data-memo-row-id={row.id}
                  className="memo-virtual-row"
                  style={virtualList.rowStyle(top)}
                  role="listitem"
                >
                  {renderMemoCard(row.memo)}
                </div>
              ),
            )}
          </div>
          {loadMoreFooter}
        </>
      ) : (
        <>
          {groups.map((group) => (
            <section
              className="memo-day"
              key={group.date}
              data-memo-day={group.date}
              aria-label={dayHeading(group.date)}
            >
              <h2>
                <time dateTime={group.date}>{timelineDateLabel(group.date)}</time>
              </h2>
              <div className="memo-day-items">
                {group.items.map((memo) => (
                  <MemoCard
                    key={memo.id}
                    memo={memo}
                    editing={editingMemo?.id === memo.id}
                    editingVersion={editingMemo?.id === memo.id ? editingMemo.version : null}
                    onEdit={() => beginEdit(memo)}
                    onFinishEdit={() => finishEdit(editingSession)}
                    onSaveNotice={onSaveNotice}
                    onConvert={onConvert}
                    mobile={isMobileViewport}
                    swipeOpen={swipeActions.openId === memo.id}
                    setSwipeOpenId={swipeActions.setOpenId}
                    onDelete={async (target) => {
                      await deleteMemo(target);
                      if (editingMemo?.id === target.id) finishEdit(editingSession);
                    }}
                  />
                ))}
              </div>
            </section>
          ))}
          {loadMoreFooter}
        </>
      )}
    </div>
  );
}

function MemoTagFilters({ onSelect }: { onSelect?: () => void }) {
  const memo = useMemoWorkspace();
  const listRef = useRef<HTMLDivElement>(null);
  const scrollEdges = useScrollEdges(listRef, [memo.tagCounts.length, memo.tag]);
  return (
    <section className="memo-tag-section" aria-label="随记标签">
      <header>
        <h2>标签</h2>
        {memo.tag && (
          <button
            type="button"
            onClick={() => {
              memo.setTag(null);
              onSelect?.();
            }}
          >
            全部
          </button>
        )}
      </header>
      {memo.tagCounts.length > 0 ? (
        <div
          className={`memo-tag-list-shell scroll-edge ${scrollEdges.before ? "has-scroll-before" : ""} ${scrollEdges.after ? "has-scroll-after" : ""}`.trim()}
        >
          <div ref={listRef} id="memo-tag-list" className="memo-tag-list floating-scrollbar-target">
            {memo.tagCounts.map((item) => (
              <button
                key={item.tag}
                type="button"
                data-tag={item.tag}
                className={memo.tag === item.tag ? "is-active" : ""}
                aria-pressed={memo.tag === item.tag}
                onClick={() => {
                  memo.setTag(memo.tag === item.tag ? null : item.tag);
                  onSelect?.();
                }}
              >
                <span>#{item.tag}</span>
                <em>{item.count}</em>
              </button>
            ))}
          </div>
          <FloatingScrollbar
            scrollTargetRef={listRef}
            controlsId="memo-tag-list"
            ariaLabel="随记标签滚动条"
            placement="right"
          />
        </div>
      ) : (
        <p>还没有标签</p>
      )}
    </section>
  );
}

export function MemoRail({ onSelect, panel = false }: { onSelect?: () => void; panel?: boolean }) {
  const memo = useMemoWorkspace();
  return (
    <aside
      id={panel ? "memo-filter-panel" : undefined}
      className={`memo-page-rail ${panel ? "memo-filter-panel" : ""}`.trim()}
      aria-label="随记日历与标签"
    >
      <MiniCalendar
        month={memo.miniMonth}
        counts={memo.dayCounts}
        selectedDate={memo.selectedDate}
        loading={memo.facetsLoading}
        error={memo.facetsError}
        onMonthChange={(month) => {
          memo.setMiniMonth(month);
          if (memo.selectedDate && memo.selectedDate.slice(0, 7) !== month)
            memo.setSelectedDate(null);
        }}
        onSelectDate={(date) => {
          if (date) memo.setMiniMonth(date.slice(0, 7));
          memo.setSelectedDate(date);
          onSelect?.();
        }}
      />
      <MemoTagFilters onSelect={onSelect} />
    </aside>
  );
}
