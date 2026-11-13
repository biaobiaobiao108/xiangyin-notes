import { ChevronLeft, Search, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { Memo } from "../../shared/types";
import { FloatingScrollbar } from "../floating-scrollbar";
import { ReadOnlyMarkdown } from "../editor/read-only-markdown";
import { useScrollEdges } from "../workspace/use-scroll-edges";
import { MemoComposer } from "./memo-composer";
import { MiniCalendar } from "./memo-calendar";
import {
  dayHeading,
  groupedByLocalDate,
  localDateKey,
  timelineDateLabel,
  timeLabel,
} from "./memo-date";
import { useMemoWorkspace } from "./memo-workspace";
import { flattenMemoGroups, memoRowId, useVirtualMemoList } from "./use-virtual-memo-list";

function MemoCard({
  memo,
  onEdit,
  editing,
  onFinishEdit,
  onDelete,
}: {
  memo: Memo;
  onEdit: () => void;
  editing: boolean;
  onFinishEdit: () => void;
  onDelete: (memo: Memo) => Promise<void>;
}) {
  const { updateMemo } = useMemoWorkspace();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const beginEdit = (target?: EventTarget | null) => {
    if (
      target instanceof Element &&
      target.closest("a,button,input,textarea,select,[contenteditable='true'],[role='button']")
    )
      return;
    onEdit();
  };

  const remove = async () => {
    if (deleting) return;
    setDeleting(true);
    setDeleteError("");
    try {
      await onDelete(memo);
    } catch (reason) {
      setDeleteError(reason instanceof Error && reason.message ? reason.message : "删除失败");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <article
      className={`memo-card ${editing ? "is-editing" : ""}`.trim()}
      data-memo-id={memo.id}
      tabIndex={editing ? -1 : 0}
      aria-label={`${dayHeading(localDateKey(memo.createdAt))} ${timeLabel(memo.createdAt)} 的随记，按 Enter 编辑`}
      onDoubleClick={(event) => beginEdit(event.target)}
      onKeyDown={(event) => {
        if (editing || event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Enter" || event.key === "F2") {
          if (
            event.target instanceof Element &&
            event.target.closest("a,button,input,textarea,select,[contenteditable='true']")
          )
            return;
          event.preventDefault();
          onEdit();
        }
      }}
    >
      <span className="memo-card-delete-zone">
        <button
          className="memo-card-delete"
          type="button"
          aria-label="删除随记"
          disabled={deleting || editing}
          onClick={() => void remove()}
        >
          <Trash2 size={16} aria-hidden="true" />
        </button>
      </span>
      <header className="memo-card-header">
        <time dateTime={new Date(memo.createdAt).toISOString()}>{timeLabel(memo.createdAt)}</time>
      </header>
      {editing ? (
        <MemoComposer
          key={`${memo.id}:${memo.version}`}
          initialMarkdown={memo.contentMarkdown}
          placeholder="修改这条随记"
          ariaLabel="编辑随记"
          autoFocus
          onSubmit={async (markdown) => {
            await updateMemo(memo, markdown);
            onFinishEdit();
          }}
          onCancel={onFinishEdit}
        />
      ) : (
        <div className="memo-card-content">
          <ReadOnlyMarkdown markdown={memo.contentMarkdown} />
        </div>
      )}
      {deleteError && (
        <p className="memo-card-error" role="alert">
          {deleteError}
        </p>
      )}
    </article>
  );
}

function MemoList({
  editingId,
  setEditingId,
  scrollRef,
}: {
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  scrollRef: RefObject<HTMLDivElement | null>;
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
  const groups = useMemo(() => groupedByLocalDate(memos), [memos]);
  const rows = useMemo(() => flattenMemoGroups(groups), [groups]);
  const scope = JSON.stringify([query, tag, selectedDate]);
  const [focusedMemoId, setFocusedMemoId] = useState<string | null>(null);
  const pinnedRowId = editingId
    ? memoRowId(editingId)
    : focusedMemoId
      ? memoRowId(focusedMemoId)
      : null;
  const virtualList = useVirtualMemoList(rows, scrollRef, scope, memos.length, pinnedRowId);
  const [loadMoreSentinel, setLoadMoreSentinel] = useState<HTMLElement | null>(null);
  const canAutoLoad = typeof IntersectionObserver !== "undefined";
  const filtered = Boolean(query || tag || selectedDate);

  useEffect(() => {
    const sentinel = loadMoreSentinel;
    const root = scrollRef.current;
    if (!sentinel || !root || !hasMore || !canAutoLoad || loadingMore || moreError) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) void loadMore();
      },
      { root, rootMargin: "360px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [canAutoLoad, hasMore, loadMore, loadMoreSentinel, loadingMore, moreError, scrollRef]);

  if (loading) {
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

  if (error && memos.length === 0) {
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
      editing={editingId === memo.id}
      onEdit={() => setEditingId(memo.id)}
      onFinishEdit={() => setEditingId(null)}
      onDelete={async (target) => {
        await deleteMemo(target);
        if (editingId === target.id) setEditingId(null);
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
            <section className="memo-day" key={group.date} aria-label={dayHeading(group.date)}>
              <h2>
                <time dateTime={group.date}>{timelineDateLabel(group.date)}</time>
              </h2>
              <div className="memo-day-items">
                {group.items.map((memo) => (
                  <MemoCard
                    key={memo.id}
                    memo={memo}
                    editing={editingId === memo.id}
                    onEdit={() => setEditingId(memo.id)}
                    onFinishEdit={() => setEditingId(null)}
                    onDelete={async (target) => {
                      await deleteMemo(target);
                      if (editingId === target.id) setEditingId(null);
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

function MemoTagFilters() {
  const memo = useMemoWorkspace();
  const listRef = useRef<HTMLDivElement>(null);
  const scrollEdges = useScrollEdges(listRef, [memo.tagCounts.length, memo.tag]);
  return (
    <section className="memo-tag-section" aria-label="随记标签">
      <header>
        <h2>标签</h2>
        {memo.tag && (
          <button type="button" onClick={() => memo.setTag(null)}>
            全部
          </button>
        )}
      </header>
      {memo.tagCounts.length > 0 ? (
        <div
          className={`memo-tag-list-shell ${scrollEdges.before ? "has-scroll-before" : ""} ${scrollEdges.after ? "has-scroll-after" : ""}`.trim()}
        >
          <div ref={listRef} id="memo-tag-list" className="memo-tag-list floating-scrollbar-target">
            {memo.tagCounts.map((item) => (
              <button
                key={item.tag}
                type="button"
                className={memo.tag === item.tag ? "is-active" : ""}
                aria-pressed={memo.tag === item.tag}
                onClick={() => memo.setTag(memo.tag === item.tag ? null : item.tag)}
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

function MemoRail() {
  const memo = useMemoWorkspace();
  return (
    <aside className="memo-page-rail" aria-label="随记日历与标签">
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
        }}
      />
      <MemoTagFilters />
    </aside>
  );
}

export function MemoPage({
  isMobileViewport,
  onBack,
}: {
  isMobileViewport: boolean;
  onBack?: () => void;
}) {
  const memo = useMemoWorkspace();
  const pageRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const scrollEdges = useScrollEdges(scrollRef, [memo.memos.length, memo.loading]);

  const submit = useCallback(
    async (markdown: string) => {
      await memo.createMemo(markdown, memo.selectedDate);
      setNotice("随记已保存");
      window.setTimeout(() => setNotice(""), 1600);
    },
    [memo],
  );

  return (
    <main ref={pageRef} id="memo-page-scroll-region" className="memo-page" aria-label="随记">
      <h1 className="visually-hidden">随记</h1>
      <div className="memo-layout">
        <div
          className={`memo-scroll-shell ${scrollEdges.before ? "has-scroll-before" : ""} ${scrollEdges.after ? "has-scroll-after" : ""}`.trim()}
        >
          <div
            ref={scrollRef}
            className="memo-scroll floating-scrollbar-target"
            id="memo-scroll-region"
          >
            <section className="memo-feed" aria-label="随记时间线">
              <div className="memo-feed-tools">
                {isMobileViewport && onBack && (
                  <button
                    className="memo-back-button"
                    type="button"
                    onClick={onBack}
                    aria-label="返回"
                  >
                    <ChevronLeft size={20} />
                  </button>
                )}
                <label className="memo-search">
                  <Search size={17} aria-hidden="true" />
                  <input
                    type="search"
                    value={memo.queryDraft}
                    onChange={(event) => memo.setQueryDraft(event.target.value)}
                    placeholder="搜索随记"
                    aria-label="搜索随记"
                  />
                  {memo.queryDraft && (
                    <button
                      type="button"
                      aria-label="清空搜索"
                      onClick={() => memo.setQueryDraft("")}
                    >
                      <X size={15} />
                    </button>
                  )}
                </label>
                {memo.tag && (
                  <button
                    className="memo-filter-chip"
                    type="button"
                    onClick={() => memo.setTag(null)}
                  >
                    #{memo.tag}
                    <X size={13} aria-hidden="true" />
                  </button>
                )}
                {memo.selectedDate && (
                  <button
                    className="memo-filter-chip"
                    type="button"
                    onClick={() => memo.setSelectedDate(null)}
                  >
                    {timelineDateLabel(memo.selectedDate)}
                    <X size={13} aria-hidden="true" />
                  </button>
                )}
              </div>
              <MemoComposer
                initialMarkdown={memo.draft}
                placeholder={memo.selectedDate ? "记下这一天……" : "记下此刻……"}
                ariaLabel="新建随记"
                resetOnSubmit
                onDraftChange={memo.setDraft}
                onSubmit={submit}
              />
              <MemoList editingId={editingId} setEditingId={setEditingId} scrollRef={scrollRef} />
            </section>
          </div>
          <FloatingScrollbar
            scrollTargetRef={scrollRef}
            controlsId="memo-scroll-region"
            ariaLabel="随记滚动条"
            placement="right"
          />
        </div>
        <MemoRail />
      </div>
      <FloatingScrollbar
        scrollTargetRef={pageRef}
        controlsId="memo-page-scroll-region"
        ariaLabel="随记页面滚动条"
        placement="right"
      />
      {notice && (
        <div className="memo-toast" role="status" aria-live="polite">
          {notice}
        </div>
      )}
    </main>
  );
}
