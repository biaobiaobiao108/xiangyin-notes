import { ChevronLeft, Copy, Plus, Search, Trash2, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
  type RefObject,
} from "react";
import type { Memo } from "../../shared/types";
import { FloatingScrollbar } from "../floating-scrollbar";
import { ReadOnlyMarkdown } from "../editor/read-only-markdown";
import { useScrollEdges } from "../workspace/use-scroll-edges";
import { MemoComposer, type MemoComposerHandle } from "./memo-composer";
import { MiniCalendar } from "./memo-calendar";
import {
  dayHeading,
  groupedByLocalDate,
  localDateKey,
  timelineDateLabel,
  timeLabel,
} from "./memo-date";
import { useMemoWorkspace } from "./memo-workspace";
import {
  flattenMemoGroups,
  includePinnedMemo,
  memoRowId,
  useMemoPageScroller,
  useVirtualMemoList,
} from "./use-virtual-memo-list";
import { textFieldMenuItems, useContextMenu } from "../context-menu";
import { copyPlainText } from "../editor/code-block-copy";
import {
  buildMemoCalendarMenuItems,
  buildMemoCardMenuItems,
  buildMemoFeedMenuItems,
  buildMemoTagMenuItems,
} from "./memo-context-menu";

function MemoCard({
  memo,
  onEdit,
  editing,
  editingVersion,
  onFinishEdit,
  onDelete,
}: {
  memo: Memo;
  onEdit: () => void;
  editing: boolean;
  editingVersion: number | null;
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
          key={memo.id}
          initialMarkdown={memo.contentMarkdown}
          placeholder="修改这条随记"
          ariaLabel="编辑随记"
          autoFocus
          onSubmit={async (markdown) => {
            await updateMemo(
              editingVersion === null ? memo : { ...memo, version: editingVersion },
              markdown,
            );
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
  editingMemo,
  setEditingMemo,
  scrollRef,
  pageScrollRef,
  onBeginEditRef,
}: {
  editingMemo: Memo | null;
  setEditingMemo: (memo: Memo | null) => void;
  scrollRef: RefObject<HTMLDivElement | null>;
  pageScrollRef: RefObject<HTMLElement | null>;
  onBeginEditRef?: MutableRefObject<((memo: Memo) => void) | null>;
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
  const [focusedMemoId, setFocusedMemoId] = useState<string | null>(null);
  const [editingWasVirtualized, setEditingWasVirtualized] = useState(false);
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
  const beginEdit = (memo: Memo) => {
    setEditingWasVirtualized(virtualList.isVirtualized);
    setEditingMemo(memo);
  };
  const finishEdit = () => {
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
      onFinishEdit={finishEdit}
      onDelete={async (target) => {
        await deleteMemo(target);
        if (editingMemo?.id === target.id) finishEdit();
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
                    onFinishEdit={finishEdit}
                    onDelete={async (target) => {
                      await deleteMemo(target);
                      if (editingMemo?.id === target.id) finishEdit();
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
                data-tag={item.tag}
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
  const composerRef = useRef<MemoComposerHandle>(null);
  const beginEditRef = useRef<((memo: Memo) => void) | null>(null);
  const { openMenu, menu } = useContextMenu();
  const [editingMemo, setEditingMemo] = useState<Memo | null>(null);
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

  const focusComposer = useCallback(() => {
    scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    pageRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    composerRef.current?.focus();
  }, []);

  const handleContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest("dialog, [role='dialog']")) return;

      if (target instanceof HTMLInputElement && target.type === "search") {
        openMenu(
          event,
          textFieldMenuItems(target, (val) => memo.setQueryDraft(val)),
          "搜索随记",
        );
        return;
      }

      if (target.closest(".memo-composer-prose")) return;

      const cardEl = target.closest<HTMLElement>("[data-memo-id]");
      if (cardEl) {
        const memoId = cardEl.dataset.memoId;
        const targetMemo =
          memo.memos.find((m) => m.id === memoId) ??
          (editingMemo?.id === memoId ? editingMemo : undefined);
        if (targetMemo) {
          const selection = window.getSelection();
          const isSelInCard =
            selection &&
            cardEl.contains(selection.anchorNode) &&
            !selection.isCollapsed &&
            Boolean(selection.toString().trim());
          const selectedText = isSelInCard ? selection!.toString() : undefined;
          const linkEl = target.closest<HTMLAnchorElement>("a[href]");
          const linkUrl = linkEl?.href;

          const items = buildMemoCardMenuItems({
            memo: targetMemo,
            isEditing: editingMemo?.id === targetMemo.id,
            selectedDate: memo.selectedDate,
            activeTag: memo.tag,
            selectedText,
            linkUrl,
            actions: {
              startEdit: (m) => {
                beginEditRef.current?.(m) ?? setEditingMemo(m);
              },
              copyContent: async (text) => {
                await copyPlainText(text);
              },
              filterDate: (date) => {
                memo.setSelectedDate(date);
                if (date) memo.setMiniMonth(date.slice(0, 7));
              },
              filterTag: (tag) => {
                memo.setTag(tag);
              },
              deleteMemo: async (m) => {
                await memo.deleteMemo(m);
                if (editingMemo?.id === m.id) setEditingMemo(null);
              },
              openLink: (url) => {
                window.open(url, "_blank", "noopener,noreferrer");
              },
            },
          });

          openMenu(event, items, `${timeLabel(targetMemo.createdAt)} 随记`);
          return;
        }
      }

      const filterChip = target.closest<HTMLElement>("[data-filter-type]");
      if (filterChip) {
        const filterType = filterChip.dataset.filterType;
        if (filterType === "tag" && memo.tag) {
          const currentTag = memo.tag;
          openMenu(
            event,
            [
              {
                label: `清除 #${currentTag} 标签筛选`,
                icon: X,
                onSelect: () => memo.setTag(null),
              },
              {
                label: "复制标签名",
                icon: Copy,
                separator: true,
                onSelect: () => copyPlainText(`#${currentTag}`),
              },
            ],
            `#${currentTag}`,
          );
          return;
        }
        if (filterType === "date" && memo.selectedDate) {
          const currentDate = memo.selectedDate;
          openMenu(
            event,
            [
              {
                label: `清除 ${timelineDateLabel(currentDate)} 日期筛选`,
                icon: X,
                onSelect: () => memo.setSelectedDate(null),
              },
              {
                label: `在${timelineDateLabel(currentDate)}新建随记`,
                icon: Plus,
                separator: true,
                onSelect: () => focusComposer(),
              },
            ],
            timelineDateLabel(currentDate),
          );
          return;
        }
      }

      const dayEl = target.closest<HTMLElement>("[data-memo-day]");
      if (dayEl) {
        const dayDate = dayEl.dataset.memoDay;
        if (dayDate) {
          const today = localDateKey(Date.now());
          const items = buildMemoCalendarMenuItems({
            date: dayDate,
            today,
            selectedDate: memo.selectedDate,
            actions: {
              selectDate: (date) => {
                memo.setSelectedDate(date);
                if (date) memo.setMiniMonth(date.slice(0, 7));
              },
              newMemoOnDate: (date) => {
                memo.setSelectedDate(date);
                memo.setMiniMonth(date.slice(0, 7));
                focusComposer();
              },
              goToToday: () => {
                memo.setSelectedDate(today);
                memo.setMiniMonth(today.slice(0, 7));
              },
            },
          });
          openMenu(event, items, dayHeading(dayDate));
          return;
        }
      }

      const cellEl = target.closest<HTMLElement>("[data-date]");
      if (cellEl) {
        const cellDate = cellEl.dataset.date;
        if (cellDate) {
          const today = localDateKey(Date.now());
          const items = buildMemoCalendarMenuItems({
            date: cellDate,
            today,
            selectedDate: memo.selectedDate,
            actions: {
              selectDate: (date) => {
                memo.setSelectedDate(date);
                if (date) memo.setMiniMonth(date.slice(0, 7));
              },
              newMemoOnDate: (date) => {
                memo.setSelectedDate(date);
                memo.setMiniMonth(date.slice(0, 7));
                focusComposer();
              },
              goToToday: () => {
                memo.setSelectedDate(today);
                memo.setMiniMonth(today.slice(0, 7));
              },
            },
          });
          openMenu(event, items, dayHeading(cellDate));
          return;
        }
      }

      if (target.closest(".memo-mini-calendar")) {
        const today = localDateKey(Date.now());
        const items = buildMemoCalendarMenuItems({
          today,
          selectedDate: memo.selectedDate,
          actions: {
            selectDate: (date) => memo.setSelectedDate(date),
            newMemoOnDate: (date) => {
              memo.setSelectedDate(date);
              memo.setMiniMonth(date.slice(0, 7));
              focusComposer();
            },
            goToToday: () => {
              memo.setSelectedDate(today);
              memo.setMiniMonth(today.slice(0, 7));
            },
          },
        });
        openMenu(event, items, "随记月历");
        return;
      }

      const tagEl = target.closest<HTMLElement>("[data-tag]");
      if (tagEl) {
        const tagName = tagEl.dataset.tag;
        if (tagName) {
          const items = buildMemoTagMenuItems({
            tag: tagName,
            activeTag: memo.tag,
            actions: {
              selectTag: (tag) => memo.setTag(tag),
              copyTagName: async (tag) => {
                await copyPlainText(tag);
              },
            },
          });
          openMenu(event, items, `#${tagName}`);
          return;
        }
      }

      if (target.closest(".memo-tag-section")) {
        const items = buildMemoTagMenuItems({
          activeTag: memo.tag,
          actions: {
            selectTag: (tag) => memo.setTag(tag),
            copyTagName: async () => {},
          },
        });
        if (items.length > 0) {
          openMenu(event, items, "随记标签");
          return;
        }
      }

      if (target.closest(".memo-feed, .memo-scroll, .memo-layout, .memo-page")) {
        const items = buildMemoFeedMenuItems({
          hasQuery: Boolean(memo.queryDraft),
          hasTag: Boolean(memo.tag),
          hasDate: Boolean(memo.selectedDate),
          activeTag: memo.tag,
          selectedDate: memo.selectedDate,
          actions: {
            newMemo: focusComposer,
            refresh: () => memo.refresh(),
            clearQuery: () => memo.setQueryDraft(""),
            clearTag: () => memo.setTag(null),
            clearDate: () => memo.setSelectedDate(null),
            clearAllFilters: () => {
              memo.setQueryDraft("");
              memo.setTag(null);
              memo.setSelectedDate(null);
            },
          },
        });
        openMenu(event, items, "随记");
      }
    },
    [editingMemo, focusComposer, memo, openMenu],
  );

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (
      event.nativeEvent.isComposing ||
      event.keyCode === 229 ||
      !(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
    )
      return;
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.closest("dialog, [contenteditable='true']"))
      return;
    event.preventDefault();
    event.stopPropagation();
    const rect = target.getBoundingClientRect();
    target.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + 12,
        clientY: rect.top + 12,
      }),
    );
  }, []);

  return (
    <main
      ref={pageRef}
      id="memo-page-scroll-region"
      className="memo-page"
      aria-label="随记"
      onContextMenu={handleContextMenu}
      onKeyDown={handleKeyDown}
    >
      <h1 className="visually-hidden">随记</h1>
      {isMobileViewport && (
        <header className="list-header mobile-collection-header memo-mobile-header">
          {onBack && (
            <button
              className="mobile-list-back"
              type="button"
              onClick={onBack}
              aria-label="返回笔记本首页"
            >
              <ChevronLeft size={22} aria-hidden="true" />
            </button>
          )}
          <div className="list-header-main">
            <h2>随记</h2>
          </div>
        </header>
      )}
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
                    data-filter-type="tag"
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
                    data-filter-type="date"
                    onClick={() => memo.setSelectedDate(null)}
                  >
                    {timelineDateLabel(memo.selectedDate)}
                    <X size={13} aria-hidden="true" />
                  </button>
                )}
              </div>
              <MemoComposer
                ref={composerRef}
                initialMarkdown={memo.draft}
                placeholder={memo.selectedDate ? "记下这一天……" : "记下此刻……"}
                ariaLabel="新建随记"
                resetOnSubmit
                onDraftChange={memo.setDraft}
                onSubmit={submit}
              />
              <MemoList
                editingMemo={editingMemo}
                setEditingMemo={setEditingMemo}
                scrollRef={scrollRef}
                pageScrollRef={pageRef}
                onBeginEditRef={beginEditRef}
              />
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
      {menu}
    </main>
  );
}
