import { CalendarDays, ChevronLeft, Copy, FileText, Plus, Search, Trash2, X } from "lucide-react";
import {
  type CSSProperties,
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
import type { Memo, Note } from "../../shared/types";
import { FloatingScrollbar } from "../floating-scrollbar";
import { MemoMarkdown } from "./memo-markdown";
import { useScrollEdges } from "../workspace/use-scroll-edges";
import { useSwipeActionGesture, useSwipeActionGroup } from "../workspace/swipe-actions";
import { MemoComposer, type MemoComposerHandle } from "./memo-composer";
import { MiniCalendar } from "./memo-calendar";
import {
  dayHeading,
  groupedByLocalDate,
  localDateKey,
  timelineDateLabel,
  timeLabel,
} from "./memo-date";
import { memoConflictCurrent, useMemoWorkspace } from "./memo-workspace";
import {
  flattenMemoGroups,
  includePinnedMemo,
  memoRowId,
  useMemoPageScroller,
  useVirtualMemoList,
} from "./use-virtual-memo-list";
import { textFieldMenuItems, useContextMenu } from "../context-menu";
import { copyPlainText } from "../editor/code-block-copy";
import { hasMemoEditDraft, readMemoEditDraft, writeMemoEditDraft } from "./memo-edit-draft";
import {
  buildMemoCalendarMenuItems,
  buildMemoCardMenuItems,
  buildMemoFeedMenuItems,
  buildMemoTagMenuItems,
} from "./memo-context-menu";

type MemoNotice = { message: string; error?: boolean };

function MemoCard({
  memo,
  onEdit,
  editing,
  editingVersion,
  onFinishEdit,
  onSaveNotice,
  onDelete,
  onConvert,
  mobile,
  swipeOpen,
  setSwipeOpenId,
}: {
  memo: Memo;
  onEdit: () => void;
  editing: boolean;
  editingVersion: number | null;
  onFinishEdit: () => void;
  onSaveNotice: (notice: MemoNotice) => void;
  onDelete: (memo: Memo) => Promise<void>;
  onConvert: (memo: Memo) => Promise<void>;
  mobile: boolean;
  swipeOpen: boolean;
  setSwipeOpenId: (id: string | null) => void;
}) {
  const { updateMemo, refresh } = useMemoWorkspace();
  const [conflict, setConflict] = useState<Memo | null>(null);
  const [copyNotice, setCopyNotice] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const composerRef = useRef<MemoComposerHandle>(null);
  const foregroundRef = useRef<HTMLElement>(null);
  const gesture = useSwipeActionGesture({
    enabled: mobile && !editing && !deleting,
    itemId: memo.id,
    open: swipeOpen,
    actionWidth: 144,
    onOpenChange: setSwipeOpenId,
    foregroundRef,
  });
  const readEditDraft = () => readMemoEditDraft(memo.id);
  const editDraft = editing ? readEditDraft() : null;
  const editVersion = editDraft?.version ?? editingVersion ?? memo.version;
  const conflictMemo = conflict ?? (editDraft?.conflict ? memo : null);
  const writeEditDraft = (markdown: string) => {
    const current = readEditDraft();
    const isConflict = Boolean(current?.conflict || conflict);
    writeMemoEditDraft(
      memo.id,
      markdown || isConflict
        ? {
            markdown,
            version: current?.version ?? editVersion,
            ...(isConflict ? { conflict: true } : {}),
          }
        : null,
    );
  };

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
    <div
      className={`swipe-action-row memo-card-swipe${swipeOpen ? " is-swipe-open" : ""}`}
      style={
        { "--swipe-action-width": "144px", "--swipe-action-button-width": "72px" } as CSSProperties
      }
      {...gesture}
    >
      {mobile && !editing && (
        <div
          className="swipe-action-buttons"
          role="group"
          aria-label="随记操作"
          aria-hidden={!swipeOpen}
          inert={!swipeOpen}
        >
          <button
            type="button"
            className="swipe-action-button"
            tabIndex={swipeOpen ? 0 : -1}
            aria-label="转为笔记"
            disabled={deleting}
            onClick={() => {
              setSwipeOpenId(null);
              setDeleteError("");
              void onConvert(memo).catch((reason) =>
                setDeleteError(reason instanceof Error ? reason.message : "转换失败"),
              );
            }}
          >
            <span className="swipe-action-icon">
              <FileText size={17} aria-hidden="true" />
            </span>
          </button>
          <button
            type="button"
            className="swipe-action-button is-danger"
            tabIndex={swipeOpen ? 0 : -1}
            aria-label="删除随记"
            disabled={deleting}
            onClick={() => {
              setSwipeOpenId(null);
              void remove();
            }}
          >
            <span className="swipe-action-icon">
              <Trash2 size={17} aria-hidden="true" />
            </span>
          </button>
        </div>
      )}
      <article
        ref={foregroundRef}
        className={`memo-card swipe-action-foreground ${editing ? "is-editing" : ""}`.trim()}
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
        {!mobile && (
          <button
            className="memo-card-convert"
            type="button"
            aria-label="转为笔记"
            disabled={deleting || editing}
            onClick={() => {
              setDeleteError("");
              void onConvert(memo).catch((reason) =>
                setDeleteError(reason instanceof Error ? reason.message : "转换失败"),
              );
            }}
          >
            <FileText size={16} aria-hidden="true" />
          </button>
        )}
        <header className="memo-card-header">
          <time dateTime={new Date(memo.createdAt).toISOString()}>{timeLabel(memo.createdAt)}</time>
        </header>
        {editing ? (
          <>
            <MemoComposer
              ref={composerRef}
              key={memo.id}
              initialMarkdown={editDraft?.markdown ?? memo.contentMarkdown}
              placeholder="修改这条随记"
              ariaLabel="编辑随记"
              autoFocus
              onSaveError={(reason) => {
                if (!memoConflictCurrent(reason)) onSaveNotice(memoSaveFailure(reason));
              }}
              onSubmit={async (markdown) => {
                const draftAtSubmit = readEditDraft();
                if (draftAtSubmit?.conflict || conflict)
                  throw new Error("请先处理冲突草稿，再保存随记。");
                const submittedDraft = draftAtSubmit?.markdown === markdown ? draftAtSubmit : null;
                try {
                  await updateMemo({ ...memo, version: editVersion }, markdown);
                } catch (reason) {
                  const current = memoConflictCurrent(reason);
                  if (current) {
                    writeMemoEditDraft(memo.id, {
                      markdown: submittedDraft?.markdown ?? markdown,
                      version: current.version,
                      conflict: true,
                    });
                    setConflict(current);
                  }
                  throw reason;
                }
                const currentDraft = readEditDraft();
                if (
                  currentDraft?.version === editVersion &&
                  (currentDraft.markdown === markdown ||
                    currentDraft.markdown === submittedDraft?.markdown)
                )
                  writeEditDraft("");
                onFinishEdit();
                onSaveNotice({ message: "随记已保存" });
              }}
              onDraftChange={writeEditDraft}
              onCancel={() => {
                if (!conflictMemo && !readEditDraft()?.conflict) writeEditDraft("");
                onFinishEdit();
              }}
            />
            {conflictMemo && (
              <section className="memo-conflict" aria-label="随记保存冲突">
                <p>这条随记已在别处更新。草稿已保留，请选择如何处理。</p>
                <div className="memo-conflict-actions">
                  <button
                    type="button"
                    onClick={() => {
                      void copyPlainText(composerRef.current?.getMarkdown() ?? "")
                        .then(() => setCopyNotice("草稿已复制"))
                        .catch(() => setCopyNotice("复制失败，请重试"))
                        .finally(() => window.setTimeout(() => setCopyNotice(""), 1600));
                    }}
                  >
                    复制草稿
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      composerRef.current?.discardPendingDraft();
                      writeMemoEditDraft(memo.id, null);
                      setConflict(null);
                      setCopyNotice("");
                      refresh();
                      onFinishEdit();
                    }}
                  >
                    丢弃草稿并编辑最新内容
                  </button>
                </div>
                {copyNotice && (
                  <p className="memo-conflict-notice" role="status">
                    {copyNotice}
                  </p>
                )}
                <details>
                  <summary>查看最新随记</summary>
                  <MemoMarkdown markdown={conflictMemo.contentMarkdown} />
                </details>
              </section>
            )}
          </>
        ) : (
          <div className="memo-card-content">
            <MemoMarkdown markdown={memo.contentMarkdown} />
          </div>
        )}
        {deleteError && (
          <p className="memo-card-error" role="alert">
            {deleteError}
          </p>
        )}
      </article>
    </div>
  );
}

function memoSaveFailure(reason: unknown): MemoNotice {
  const detail =
    reason instanceof TypeError
      ? "请检查网络后重试。"
      : reason instanceof Error && reason.message
        ? reason.message
        : "请重试。";
  return { message: `随记未保存，草稿仍可编辑。${detail}`, error: true };
}

function MemoList({
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
  const beginEdit = (memo: Memo) => {
    swipeActions.close();
    editingSessionRef.current += 1;
    setEditingWasVirtualized(virtualList.isVirtualized);
    setEditingMemo(memo);
  };
  const finishEdit = (session: number) => {
    if (editingSessionRef.current !== session) return;
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

function MemoRail({ onSelect, panel = false }: { onSelect?: () => void; panel?: boolean }) {
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

export function MemoPage({
  isMobileViewport,
  onBack,
  onConverted,
}: {
  isMobileViewport: boolean;
  onBack?: () => void;
  onConverted: (note: Note) => void;
}) {
  const memo = useMemoWorkspace();
  const pageRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<MemoComposerHandle>(null);
  const beginEditRef = useRef<((memo: Memo) => void) | null>(null);
  const { openMenu, menu } = useContextMenu();
  const [editingMemo, setEditingMemo] = useState<Memo | null>(null);
  const [notice, setNotice] = useState<MemoNotice | null>(() =>
    memo.draft.trim() ? { message: "已恢复未提交的随记草稿" } : null,
  );
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), notice.error ? 8000 : 2200);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterButtonRef = useRef<HTMLButtonElement>(null);
  const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 1320px)").matches);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 1320px)");
    const update = () => setNarrow(media.matches);
    media.addEventListener("change", update);
    update();
    return () => media.removeEventListener("change", update);
  }, []);
  const scrollEdges = useScrollEdges(scrollRef, [memo.memos.length, memo.loading]);

  const submit = useCallback(
    async (markdown: string) => {
      await memo.createMemo(markdown, memo.selectedDate);
      setNotice({ message: "随记已保存" });
    },
    [memo],
  );

  const convertingRef = useRef(false);
  const convertMemo = useCallback(
    async (target: Memo) => {
      if (convertingRef.current) return;
      const draft = readMemoEditDraft(target.id);
      if (draft?.conflict) throw new Error("这条随记有未处理的冲突草稿，请先打开并处理草稿");
      if (draft) throw new Error("这条随记有未保存的编辑草稿，请先打开并处理草稿");
      if (hasMemoEditDraft(target.id))
        throw new Error("无法读取这条随记的本地草稿，请先打开并处理草稿");
      convertingRef.current = true;
      try {
        const note = await memo.convertMemo(target);
        onConverted(note);
      } finally {
        convertingRef.current = false;
      }
    },
    [memo, onConverted],
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
              convertMemo,
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
    [convertMemo, editingMemo, focusComposer, memo, openMenu],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (
        event.key === "Escape" &&
        !event.nativeEvent.isComposing &&
        event.keyCode !== 229 &&
        narrow &&
        filtersOpen &&
        event.target instanceof Element &&
        event.target.closest("#memo-filter-panel")
      ) {
        event.preventDefault();
        event.stopPropagation();
        setFiltersOpen(false);
        filterButtonRef.current?.focus();
        return;
      }
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
    },
    [narrow, filtersOpen],
  );

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
                {narrow && (
                  <button
                    ref={filterButtonRef}
                    className="memo-filter-toggle"
                    type="button"
                    aria-label="日期和标签筛选"
                    aria-expanded={filtersOpen}
                    aria-controls="memo-filter-panel"
                    onClick={() => setFiltersOpen((open) => !open)}
                  >
                    <CalendarDays size={18} aria-hidden="true" />
                  </button>
                )}
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
              {narrow && (
                <div
                  className={`memo-filter-collapse ${filtersOpen ? "is-open" : ""}`.trim()}
                  inert={!filtersOpen}
                  aria-hidden={!filtersOpen}
                >
                  <div className="memo-filter-collapse-inner">
                    <MemoRail
                      panel
                      onSelect={() => {
                        setFiltersOpen(false);
                        filterButtonRef.current?.focus({ preventScroll: true });
                      }}
                    />
                  </div>
                </div>
              )}
              <MemoComposer
                ref={composerRef}
                initialMarkdown={memo.draft}
                placeholder={memo.selectedDate ? "记下这一天……" : "记下此刻……"}
                ariaLabel="新建随记"
                resetOnSubmit
                onDraftChange={memo.setDraft}
                onSubmit={submit}
                onSaveError={(reason) => setNotice(memoSaveFailure(reason))}
              />
              <MemoList
                isMobileViewport={isMobileViewport}
                editingMemo={editingMemo}
                setEditingMemo={setEditingMemo}
                scrollRef={scrollRef}
                pageScrollRef={pageRef}
                onBeginEditRef={beginEditRef}
                onConvert={convertMemo}
                onSaveNotice={setNotice}
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
        {!narrow && <MemoRail />}
      </div>
      <FloatingScrollbar
        scrollTargetRef={pageRef}
        controlsId="memo-page-scroll-region"
        ariaLabel="随记页面滚动条"
        placement="right"
      />
      {notice && (
        <div className="memo-toast" role={notice.error ? "alert" : "status"}>
          {notice.message}
        </div>
      )}
      {menu}
    </main>
  );
}
