import { CalendarDays, ChevronLeft, Copy, Plus, Search, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { Memo, Note } from "../../shared/types";
import { textFieldMenuItems, useContextMenu } from "../context-menu";
import { copyPlainText } from "../editor/code-block-copy";
import { FloatingScrollbar } from "../floating-scrollbar";
import { useScrollEdges } from "../workspace/use-scroll-edges";
import { MemoComposer, type MemoComposerHandle } from "./memo-composer";
import {
  buildMemoCalendarMenuItems,
  buildMemoCardMenuItems,
  buildMemoFeedMenuItems,
  buildMemoTagMenuItems,
} from "./memo-context-menu";
import { dayHeading, localDateKey, timelineDateLabel, timeLabel } from "./memo-date";
import { hasMemoEditDraft, readMemoEditDraft } from "./memo-edit-draft";
import { memoSaveFailure, type MemoNotice } from "./memo-card";
import { MemoList, MemoRail } from "./memo-list";
import { useMemoWorkspace } from "./memo-workspace";

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
          className={`memo-scroll-shell scroll-edge ${scrollEdges.before ? "has-scroll-before" : ""} ${scrollEdges.after ? "has-scroll-after" : ""}`.trim()}
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
