import { CalendarDays, ChevronLeft, List, Search, Trash2, X } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import type { Memo } from "../../shared/types";
import { FloatingScrollbar } from "../floating-scrollbar";
import { ReadOnlyMarkdown } from "../editor/read-only-markdown";
import { useScrollEdges } from "../workspace/use-scroll-edges";
import { MemoComposer, type MemoComposerHandle } from "./memo-composer";
import { MiniCalendar, MonthCalendar } from "./memo-calendar";
import {
  dayHeading,
  groupedByLocalDate,
  localDateKey,
  timelineDateLabel,
  timeLabel,
} from "./memo-date";
import { useMemoWorkspace } from "./memo-workspace";

function MemoCard({
  memo,
  onEdit,
  editing,
  onFinishEdit,
  onTagClick,
  onDelete,
}: {
  memo: Memo;
  onEdit: () => void;
  editing: boolean;
  onFinishEdit: () => void;
  onTagClick: (tag: string) => void;
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
      <button
        className="memo-card-delete"
        type="button"
        aria-label="删除随记"
        disabled={deleting || editing}
        onClick={() => void remove()}
      >
        <Trash2 size={16} aria-hidden="true" />
      </button>
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
      {!editing && memo.tags.length > 0 && (
        <footer className="memo-card-tags" aria-label="随记标签">
          {memo.tags.map((tag) => (
            <button key={tag} type="button" onClick={() => onTagClick(tag)}>
              #{tag}
            </button>
          ))}
        </footer>
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
}: {
  editingId: string | null;
  setEditingId: (id: string | null) => void;
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
    mode,
    selectedDate,
    setQueryDraft,
    setSelectedDate,
  } = useMemoWorkspace();
  const groups = groupedByLocalDate(memos);
  const filtered = Boolean(query || tag || (mode === "timeline" && selectedDate));

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
        <strong>
          {filtered ? "没有找到随记" : mode === "calendar" ? "这一天还没有随记" : "还没有随记"}
        </strong>
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
                onTagClick={setTag}
                onDelete={async (target) => {
                  await deleteMemo(target);
                  if (editingId === target.id) setEditingId(null);
                }}
              />
            ))}
          </div>
        </section>
      ))}
      {moreError && (
        <p className="memo-more-error" role="alert">
          {moreError}
        </p>
      )}
      {hasMore && (
        <button
          className="memo-load-more"
          type="button"
          onClick={() => void loadMore()}
          disabled={loadingMore}
        >
          {loadingMore ? "加载中…" : moreError ? "重试加载" : "加载更多"}
        </button>
      )}
    </div>
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<MemoComposerHandle>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const scrollEdges = useScrollEdges(scrollRef, [memo.memos.length, memo.loading]);
  const selectedCalendarDate = memo.calendarDate ?? localDateKey(Date.now());

  const submit = useCallback(
    async (markdown: string) => {
      await memo.createMemo(
        markdown,
        memo.mode === "calendar" ? selectedCalendarDate : memo.selectedDate,
      );
      composerRef.current?.clear();
      setNotice("随记已保存");
      window.setTimeout(() => setNotice(""), 1600);
    },
    [memo, selectedCalendarDate],
  );

  return (
    <main className="memo-page" aria-label="随记">
      <header className="memo-page-header">
        {isMobileViewport && onBack && (
          <button className="memo-back-button" type="button" onClick={onBack} aria-label="返回">
            <ChevronLeft size={20} />
          </button>
        )}
        <h1>随记</h1>
        <div className="memo-view-switch" role="group" aria-label="随记视图">
          <button
            type="button"
            className={memo.mode === "timeline" ? "is-active" : ""}
            aria-pressed={memo.mode === "timeline"}
            aria-label="时间线"
            onClick={() => memo.setMode("timeline")}
          >
            <List size={17} aria-hidden="true" />
            <span>时间线</span>
          </button>
          <button
            type="button"
            className={memo.mode === "calendar" ? "is-active" : ""}
            aria-pressed={memo.mode === "calendar"}
            aria-label="日历"
            onClick={() => {
              const nextMonth = memo.selectedDate?.slice(0, 7) ?? memo.miniMonth;
              memo.setCalendarMonth(nextMonth);
              memo.setCalendarDate(memo.selectedDate ?? localDateKey(Date.now()));
              memo.setMode("calendar");
            }}
          >
            <CalendarDays size={17} aria-hidden="true" />
            <span>日历</span>
          </button>
        </div>
      </header>

      <div className="memo-filter-bar">
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
            <button type="button" aria-label="清空搜索" onClick={() => memo.setQueryDraft("")}>
              <X size={15} />
            </button>
          )}
        </label>
        {memo.tag && (
          <button className="memo-filter-chip" type="button" onClick={() => memo.setTag(null)}>
            #{memo.tag}
            <X size={13} aria-hidden="true" />
          </button>
        )}
        {memo.mode === "timeline" && memo.selectedDate && (
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

      <div
        ref={scrollRef}
        className={`memo-scroll-shell ${scrollEdges.before ? "has-scroll-before" : ""} ${scrollEdges.after ? "has-scroll-after" : ""}`.trim()}
      >
        <div className="memo-scroll floating-scrollbar-target" id="memo-scroll-region">
          {memo.mode === "timeline" ? (
            <div className="memo-feed">
              <MemoComposer
                ref={composerRef}
                initialMarkdown={memo.draft}
                placeholder={memo.selectedDate ? "记下这一天……" : "记下此刻……"}
                ariaLabel="新建随记"
                onDraftChange={memo.setDraft}
                onSubmit={submit}
              />
              <MemoList editingId={editingId} setEditingId={setEditingId} />
            </div>
          ) : (
            <div className="memo-calendar-layout">
              <MonthCalendar
                month={memo.calendarMonth}
                counts={memo.dayCounts}
                selectedDate={memo.calendarDate}
                loading={memo.facetsLoading}
                error={memo.facetsError}
                onMonthChange={(month) => {
                  memo.setCalendarMonth(month);
                  memo.setCalendarDate(`${month}-01`);
                }}
                onSelectDate={(date) => {
                  const next = date ?? localDateKey(Date.now());
                  if (next.slice(0, 7) !== memo.calendarMonth)
                    memo.setCalendarMonth(next.slice(0, 7));
                  memo.setCalendarDate(next);
                }}
              />
              <section className="memo-calendar-day" aria-label={dayHeading(selectedCalendarDate)}>
                <header>
                  <h2>{dayHeading(selectedCalendarDate)}</h2>
                </header>
                <MemoComposer
                  key={`calendar:${selectedCalendarDate}`}
                  placeholder="记下这一天……"
                  ariaLabel={`在${dayHeading(selectedCalendarDate)}新建随记`}
                  onSubmit={submit}
                />
                <MemoList editingId={editingId} setEditingId={setEditingId} />
              </section>
            </div>
          )}
        </div>
        <FloatingScrollbar
          scrollTargetRef={scrollRef}
          controlsId="memo-scroll-region"
          ariaLabel="随记滚动条"
          placement="right"
        />
      </div>
      {notice && (
        <div className="memo-toast" role="status" aria-live="polite">
          {notice}
        </div>
      )}
    </main>
  );
}

export function MemoSidebar() {
  const memo = useMemoWorkspace();
  return (
    <div className="memo-sidebar-context">
      <MiniCalendar
        month={memo.miniMonth}
        counts={memo.dayCounts}
        selectedDate={memo.selectedDate}
        loading={memo.facetsLoading}
        error={memo.facetsError}
        onMonthChange={memo.setMiniMonth}
        onSelectDate={(date) => {
          memo.setMode("timeline");
          if (date) memo.setMiniMonth(date.slice(0, 7));
          memo.setSelectedDate(date);
        }}
      />
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
          <div className="memo-tag-list">
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
        ) : (
          <p>还没有标签</p>
        )}
      </section>
    </div>
  );
}
