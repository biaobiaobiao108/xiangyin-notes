import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  Archive,
  ChevronDown,
  ChevronLeft,
  LoaderCircle,
  Menu,
  Plus,
  RotateCcw,
  Search,
  Star,
  Trash2,
} from "lucide-react";
import type { NoteSummary, NoteView } from "../../shared/types";
import { playEntranceAnimation } from "../animation";
import { BrandMark } from "../brand-mark";
import { EmptyTrashButton } from "./empty-trash-button";
import type { OutlineItem } from "../editor-metrics";
import { FloatingScrollbar } from "../floating-scrollbar";
import { commandMenuShortcutLabel } from "../platform";
import {
  getNoteTags,
  groupNotes,
  type NoteGroup,
  relativeDate,
  searchResultLabel,
  sortNotes,
  viewLabel,
} from "./helpers";
import { NOTE_DRAG_MIME_TYPE, setNoteDragImage } from "./note-drag-drop";
import { NoteTags } from "./note-tags";
import {
  flattenNoteGroups,
  ESTIMATED_ROW_HEIGHT,
  noteGroupRowId,
  useVirtualNoteList,
  type VirtualNoteListRow,
} from "./use-virtual-note-list";
import { useGroupCollapseAnchor } from "./use-group-collapse-anchor";
import { partitionVirtualGroupRows, shouldAnimateVirtualGroup } from "./group-layout";
import { useScrollEdges } from "./use-scroll-edges";
import { MobileCollectionHeader } from "./mobile-collection-header";
import { type NoteSwipeAction, useSwipeActionGesture, useSwipeActionGroup } from "./swipe-actions";

import { NoteOutlinePanel } from "./note-outline-panel";
export { NoteOutlinePanel } from "./note-outline-panel";
export { Sidebar } from "./sidebar";
function toggleGroupInSet(current: ReadonlySet<string>, groupId: string) {
  const next = new Set(current);
  if (current.has(groupId)) next.delete(groupId);
  else next.add(groupId);
  return next;
}

type VirtualGroupTransition = {
  groupId: string;
  phase: "preparing-collapse" | "preparing-expansion" | "collapsing" | "expanding";
};

function groupMotionDuration(target: HTMLElement | null) {
  if (!target) return 0;
  const value = getComputedStyle(target).getPropertyValue("--motion-group").trim();
  const duration = Number.parseFloat(value);
  if (!Number.isFinite(duration)) return 0;
  if (value.endsWith("ms")) return duration;
  if (value.endsWith("s")) return duration * 1000;
  return duration;
}

export function NoteLoadingState() {
  return (
    <section className="editor-panel editor-loading-shell" aria-label="笔记编辑器" aria-busy="true">
      <div
        className="editor-switch-overlay editor-switch-overlay--visible"
        role="status"
        aria-live="polite"
      >
        <div className="editor-switch-card">
          <BrandMark className="editor-switch-mark" />
          <div className="editor-switch-lines" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <strong>正在打开笔记…</strong>
        </div>
      </div>
    </section>
  );
}

function NoteThumbnail({ note }: { note: NoteSummary }) {
  const thumbnail = note.thumbnail;
  if (!thumbnail?.url) return null;
  return (
    <span className="note-row-thumbnail" aria-hidden="true">
      <img
        src={thumbnail.url}
        alt=""
        width={76}
        height={76}
        loading="lazy"
        decoding="async"
        draggable={false}
      />
    </span>
  );
}

function NoteRowMeta({ note, showNotebook }: { note: NoteSummary; showNotebook: boolean }) {
  return (
    <span className="note-row-meta">
      {showNotebook && note.notebookName && (
        <span className="note-row-notebook">{note.notebookName}</span>
      )}
      <time>{relativeDate(note.updatedAt)}</time>
    </span>
  );
}

const NoteListRow = memo(function NoteListRow({
  note,
  isSelected,
  isActive,
  showNotebook,
  onToggleFavorite,
  onSelect,
  rowRef,
  rowStyle,
  rowIndex,
  setSize,
  isMobileViewport,
  isTrashView,
  trashBusy,
  onNoteSwipeAction,
  open,
  setOpenId,
  isDragging,
  groupMotion,
  onDragStart,
  onDragEnd,
}: {
  note: NoteSummary;
  isSelected: boolean;
  isActive: boolean;
  showNotebook: boolean;
  onToggleFavorite: (note: NoteSummary) => void;
  onSelect: (id: string, event: ReactMouseEvent<HTMLButtonElement>) => void;
  rowRef?: (element: HTMLLIElement | null) => void;
  rowStyle?: CSSProperties;
  rowIndex: number;
  setSize: number;
  isMobileViewport: boolean;
  isTrashView: boolean;
  trashBusy: boolean;
  onNoteSwipeAction: (note: NoteSummary, action: NoteSwipeAction) => void;
  open: boolean;
  setOpenId: (id: string | null) => void;
  isDragging: boolean;
  groupMotion?: "collapsing" | "expanding";
  onDragStart: (note: NoteSummary, event: ReactDragEvent<HTMLButtonElement>) => void;
  onDragEnd: () => void;
}) {
  const actionWidth = isTrashView ? 144 : 96;
  const foregroundRef = useRef<HTMLButtonElement>(null);
  const gesture = useSwipeActionGesture({
    enabled: isMobileViewport && !trashBusy,
    itemId: note.id,
    open,
    actionWidth,
    onOpenChange: setOpenId,
    foregroundRef,
  });

  return (
    <li
      ref={rowRef}
      data-note-id={note.id}
      className={`note-list-item ${isDragging ? "is-dragging" : ""}${groupMotion ? ` is-group-${groupMotion}` : ""}`.trim()}
      style={rowStyle}
      inert={groupMotion === "collapsing" || undefined}
      aria-posinset={rowIndex + 1}
      aria-setsize={setSize}
    >
      <div
        className={`swipe-action-row note-row-swipe${open ? " is-swipe-open" : ""}`}
        style={
          {
            "--swipe-action-width": `${actionWidth}px`,
            "--swipe-action-button-width": isTrashView ? "72px" : "96px",
          } as CSSProperties
        }
        {...gesture}
      >
        {isMobileViewport && (
          <div
            id={`note-actions-${note.id}`}
            className="swipe-action-buttons"
            role="group"
            aria-label={`${note.title || "未命名笔记"}的操作`}
            aria-hidden={!open}
            inert={!open}
          >
            {isTrashView ? (
              <>
                <button
                  type="button"
                  className="swipe-action-button"
                  tabIndex={open ? 0 : -1}
                  aria-label={`恢复笔记：${note.title || "未命名笔记"}`}
                  disabled={trashBusy}
                  onClick={() => {
                    setOpenId(null);
                    onNoteSwipeAction(note, "restore");
                  }}
                >
                  <span className="swipe-action-icon">
                    <RotateCcw size={17} aria-hidden="true" />
                  </span>
                </button>
                <button
                  type="button"
                  className="swipe-action-button is-danger"
                  tabIndex={open ? 0 : -1}
                  aria-label={`彻底删除笔记：${note.title || "未命名笔记"}`}
                  disabled={trashBusy}
                  onClick={() => {
                    setOpenId(null);
                    onNoteSwipeAction(note, "permanent-delete");
                  }}
                >
                  <span className="swipe-action-icon">
                    <Trash2 size={17} aria-hidden="true" />
                  </span>
                </button>
              </>
            ) : (
              <button
                type="button"
                className="swipe-action-button is-danger"
                tabIndex={open ? 0 : -1}
                aria-label={`移入回收站：${note.title || "未命名笔记"}`}
                disabled={trashBusy}
                onClick={() => {
                  setOpenId(null);
                  onNoteSwipeAction(note, "trash");
                }}
              >
                <span className="swipe-action-icon">
                  <Trash2 size={17} aria-hidden="true" />
                </span>
              </button>
            )}
          </div>
        )}
        <button
          ref={foregroundRef}
          type="button"
          draggable={!isMobileViewport}
          onDragStart={(event) => onDragStart(note, event)}
          onDragEnd={onDragEnd}
          className={`note-row swipe-action-foreground ${note.thumbnail ? "has-thumbnail" : ""} ${!isTrashView ? "has-favorite-action" : ""} ${isSelected ? "is-selected" : ""} ${isActive ? "is-active" : ""}`}
          aria-current={isActive ? "page" : undefined}
          aria-pressed={isSelected}
          aria-expanded={isMobileViewport ? open : undefined}
          aria-controls={isMobileViewport ? `note-actions-${note.id}` : undefined}
          onClick={(event) => onSelect(note.id, event)}
        >
          <NoteThumbnail note={note} />
          <span className="note-row-main">
            <span className="note-row-title">
              <span className="note-row-title-text">{note.title || "未命名笔记"}</span>
            </span>
            <NoteTags tags={getNoteTags(note)} variant="row" />
            <span className="note-row-preview">
              {note.preview || "还没有内容，开始写下第一句话。"}
            </span>
            <NoteRowMeta note={note} showNotebook={showNotebook} />
          </span>
        </button>
        {!isTrashView && (
          <button
            type="button"
            className={`note-row-star-btn ${note.isFavorite ? "is-favorite" : ""}`}
            aria-label={note.isFavorite ? "取消收藏" : "加入收藏"}
            aria-pressed={note.isFavorite}
            onClick={(event) => {
              event.stopPropagation();
              onToggleFavorite(note);
            }}
          >
            <Star size={15} fill={note.isFavorite ? "currentColor" : "none"} />
          </button>
        )}
      </div>
    </li>
  );
});

type NoteListPanelProps = {
  notes: NoteSummary[];
  total: number;
  hasMore?: boolean;
  selectedId: string | null;
  selectedIds: ReadonlySet<string>;
  onSelect: (id: string, event: ReactMouseEvent<HTMLButtonElement>) => void;
  onToggleFavoriteNote: (note: NoteSummary) => void;
  onDeleteSelected: () => void;
  onNoteSwipeAction: (note: NoteSummary, action: NoteSwipeAction) => void;
  view: NoteView;
  query: string;
  currentNotebookName?: string;
  onNewNote?: () => void;
  creatingNote?: boolean;
  onEmptyTrash?: () => void;
  trashBusy: boolean;
  onClearQuery: () => void;
  onOpenSidebar: () => void;
  transitionToken: number;

  isMobileViewport?: boolean;
  outlineOpen: boolean;
  outlineItems: OutlineItem[];
  activeOutlineId: string | null;
  onScrollToOutlineItem: (id: string) => void;
  onCloseOutline: () => void;
  onLoadMore?: () => void;
  isLoadingMore?: boolean;
  virtualizationScope: string;
  onFocusEditor?: () => void;

  inert?: boolean;
};

function noteLoadMoreLabel(shown: number, total: number) {
  return `加载更多（已显示 ${shown}${total > shown ? ` / ${total}` : ""}）`;
}

export const NoteListPanel = memo(function NoteListPanel({
  notes,
  total,
  hasMore = total > notes.length,
  selectedId,
  selectedIds,
  onSelect,
  onToggleFavoriteNote,
  onDeleteSelected,
  onNoteSwipeAction,
  view,
  query,
  currentNotebookName,
  onNewNote,
  creatingNote = false,
  onEmptyTrash,
  trashBusy,
  onClearQuery,
  isMobileViewport = false,
  onOpenSidebar,
  transitionToken,
  outlineOpen,
  outlineItems,
  activeOutlineId,
  onScrollToOutlineItem,
  onCloseOutline,
  onLoadMore,
  isLoadingMore = false,
  virtualizationScope,
  onFocusEditor,
  inert = false,
}: NoteListPanelProps) {
  const noteListRef = useRef<HTMLDivElement>(null);
  const [noteListElement, setNoteListElement] = useState<HTMLDivElement | null>(null);
  const setNoteListRef = useCallback((element: HTMLDivElement | null) => {
    noteListRef.current = element;
    setNoteListElement((current) => (current === element ? current : element));
  }, []);
  const { anchorGroupCollapse, isAnchoring } = useGroupCollapseAnchor(noteListRef);
  const [loadMoreSentinel, setLoadMoreSentinel] = useState<HTMLElement | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const swipeActions = useSwipeActionGroup(
    noteListRef,
    isMobileViewport && !inert,
    virtualizationScope,
  );

  useLayoutEffect(() => {
    if (transitionToken === 0 || !panelRef.current) return;
    const panel = panelRef.current;
    const content = panel.querySelector<HTMLElement>(".note-list-content");
    if (!content) return;
    const animation = playEntranceAnimation(content, "page-content-in");
    return () => animation?.cancel();
  }, [transitionToken]);

  const [draggingNoteIds, setDraggingNoteIds] = useState<ReadonlySet<string> | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const [virtualGroupTransition, setVirtualGroupTransition] =
    useState<VirtualGroupTransition | null>(null);
  const dragFrameRef = useRef<number | null>(null);
  const virtualGroupTransitionTimerRef = useRef<number | null>(null);
  const queuedVirtualGroupIdRef = useRef<string | null>(null);
  const focusRestoreRef = useRef<{ noteId: string; selector: string } | null>(null);
  useEffect(() => {
    const clearFocusRestore = (event: PointerEvent) => {
      if (event.target instanceof Node && !panelRef.current?.contains(event.target)) {
        focusRestoreRef.current = null;
      }
    };
    document.addEventListener("pointerdown", clearFocusRestore, true);
    return () => document.removeEventListener("pointerdown", clearFocusRestore, true);
  }, []);
  const transitionDataRef = useRef<{ rowIds: string } | null>(null);

  const handleRowDragStart = useCallback(
    (note: NoteSummary, event: ReactDragEvent<HTMLButtonElement>) => {
      if (isMobileViewport) return;
      const inSelection = selectedIds.has(note.id);
      const ids =
        selectedIds.size > 1
          ? inSelection
            ? Array.from(selectedIds)
            : Array.from(new Set([...selectedIds, note.id]))
          : selectedIds.size === 1 && !inSelection
            ? [selectedIds.values().next().value!, note.id]
            : [note.id];

      const serialized = JSON.stringify(ids);
      event.dataTransfer.setData(NOTE_DRAG_MIME_TYPE, serialized);
      event.dataTransfer.setData("text/plain", serialized);
      event.dataTransfer.effectAllowed = "move";
      setNoteDragImage(event.dataTransfer, event.currentTarget, ids.length);

      // 延迟到下一动画帧设置 is-dragging，避免在 dragstart 事件同微任务内重渲染 DOM 打断 Chromium 的拖拽初始化
      dragFrameRef.current = requestAnimationFrame(() => {
        dragFrameRef.current = null;
        setDraggingNoteIds(new Set(ids));
      });
    },
    [isMobileViewport, selectedIds],
  );

  const handleRowDragEnd = useCallback(() => {
    if (dragFrameRef.current !== null) cancelAnimationFrame(dragFrameRef.current);
    dragFrameRef.current = null;
    setDraggingNoteIds(null);
  }, []);

  const sortedNotes = useMemo(() => sortNotes(notes, "updated"), [notes]);
  const groups = useMemo(() => {
    if (query.trim()) return null;
    return groupNotes(sortedNotes, "updated");
  }, [query, sortedNotes]);
  const collapsingGroupId =
    virtualGroupTransition?.phase === "collapsing" &&
    collapsedGroups.has(virtualGroupTransition.groupId)
      ? virtualGroupTransition.groupId
      : null;
  const virtualRows = useMemo<VirtualNoteListRow[]>(() => {
    if (groups) return flattenNoteGroups(groups, collapsedGroups, collapsingGroupId);
    return sortedNotes.map((note) => ({ id: note.id, kind: "note" as const, note }));
  }, [collapsedGroups, collapsingGroupId, groups, sortedNotes]);
  const currentRowIds = useMemo(
    () =>
      (groups ?? [])
        .flatMap((group) => [noteGroupRowId(group.id), ...group.notes.map((note) => note.id)])
        .join("\u0000"),
    [groups],
  );
  const transitionDataChanged = Boolean(
    virtualGroupTransition &&
    transitionDataRef.current &&
    transitionDataRef.current.rowIds !== currentRowIds,
  );
  const sortedIndexById = useMemo(
    () => new Map(sortedNotes.map((note, index) => [note.id, index])),
    [sortedNotes],
  );
  const groupByNoteId = useMemo(() => {
    const byNoteId = new Map<string, NoteGroup>();
    for (const group of groups ?? []) {
      for (const note of group.notes) byNoteId.set(note.id, group);
    }
    return byNoteId;
  }, [groups]);
  // 收起的笔记仍保留测量值，展开时避免先按估算高度排版再跳到实际高度。
  const retainedRowIds = useMemo(
    () =>
      new Set([
        ...sortedNotes.map((note) => note.id),
        ...(groups ?? []).map((group) => noteGroupRowId(group.id)),
      ]),
    [groups, sortedNotes],
  );
  const virtualList = useVirtualNoteList(
    virtualRows,
    retainedRowIds,
    noteListRef,
    noteListElement,
    virtualizationScope,
    sortedNotes.length,
    virtualGroupTransition?.groupId ?? null,
    virtualGroupTransition?.phase === "collapsing",
  );
  const noteListScrollEdges = useScrollEdges(noteListRef, [
    noteListElement,
    sortedNotes.length,
    virtualList.totalHeight,
  ]);

  const currentStickyGroup = useMemo(() => {
    if (!groups || groups.length === 0) return null;
    const topRow = virtualList.topVisibleRow;
    if (!topRow) return groups[0];
    return topRow.kind === "group" ? topRow.group : groupByNoteId.get(topRow.note.id) || groups[0];
  }, [groupByNoteId, groups, virtualList.topVisibleRow]);
  const virtualStickyGroup = currentStickyGroup ?? groups?.[0] ?? null;
  const virtualStickyTransition =
    virtualGroupTransition && virtualStickyGroup?.id === virtualGroupTransition.groupId
      ? virtualGroupTransition.phase
      : null;
  const virtualStickyGroupCollapsed =
    virtualStickyTransition === "collapsing" || virtualStickyTransition === "preparing-expansion"
      ? true
      : virtualStickyTransition === "expanding" || virtualStickyTransition === "preparing-collapse"
        ? false
        : virtualStickyGroup
          ? collapsedGroups.has(virtualStickyGroup.id)
          : false;
  const canAutoLoadMore =
    !groups ||
    groups.some((group) => {
      return (
        !collapsedGroups.has(group.id) &&
        !(
          virtualGroupTransition?.groupId === group.id &&
          virtualGroupTransition.phase === "collapsing"
        )
      );
    });

  useEffect(() => {
    const sentinel = loadMoreSentinel;
    const container = noteListRef.current;
    if (
      !sentinel ||
      !container ||
      !hasMore ||
      !onLoadMore ||
      isLoadingMore ||
      !canAutoLoadMore ||
      virtualGroupTransition !== null ||
      typeof IntersectionObserver === "undefined"
    )
      return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) onLoadMore();
      },
      { root: container, rootMargin: "240px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [
    canAutoLoadMore,
    loadMoreSentinel,
    hasMore,
    isLoadingMore,
    onLoadMore,
    sortedNotes.length,
    virtualGroupTransition?.groupId,
    virtualGroupTransition?.phase,
  ]);

  const toggleGroup = (groupId: string, button: HTMLButtonElement) => {
    anchorGroupCollapse();
    const scroll = noteListRef.current;
    const section = button.closest<HTMLElement>(".note-list-group");
    const content = section?.querySelector<HTMLElement>(".note-list-group-content");
    if (
      !collapsedGroups.has(groupId) &&
      scroll &&
      section &&
      content &&
      button.getBoundingClientRect().top <= scroll.getBoundingClientRect().top + 1
    ) {
      anchorGroupCollapse(
        Math.max(
          0,
          scroll.scrollTop +
            section.getBoundingClientRect().top -
            scroll.getBoundingClientRect().top,
        ),
        content.getBoundingClientRect().height,
        `#${CSS.escape(content.id)}`,
      );
    }
    setCollapsedGroups((current) => toggleGroupInSet(current, groupId));
  };

  const toggleVirtualGroup = (group: NoteGroup) => {
    if (virtualGroupTransition && virtualGroupTransition.groupId !== group.id) {
      queuedVirtualGroupIdRef.current = group.id;
      return;
    }
    queuedVirtualGroupIdRef.current = null;
    anchorGroupCollapse();
    const scroll = noteListRef.current;
    const animate = shouldAnimateVirtualGroup(
      group.notes.length * ESTIMATED_ROW_HEIGHT,
      scroll?.clientHeight ?? 0,
    );
    const duration = animate ? groupMotionDuration(scroll) : 0;
    if (!collapsedGroups.has(group.id) && group.id === virtualStickyGroup?.id) {
      const index = virtualRows.findIndex((row) => row.id === noteGroupRowId(group.id));
      const end = virtualRows.findIndex((row, i) => i > index && row.kind === "group");
      const contentTop = virtualList.rowTop(index + 1);
      const targetTop = index === 0 ? 0 : contentTop;
      if (duration > 0)
        anchorGroupCollapse(
          targetTop,
          virtualList.rowTop(end < 0 ? virtualRows.length : end) - contentTop,
          ".virtual-group-motion-clip",
        );
      else if (scroll) scroll.scrollTop = Math.min(scroll.scrollTop, targetTop);
    }
    const clearTimer = () => {
      if (virtualGroupTransitionTimerRef.current !== null)
        window.clearTimeout(virtualGroupTransitionTimerRef.current);
      virtualGroupTransitionTimerRef.current = null;
    };
    const setCollapsed = (collapsed: boolean) => {
      setCollapsedGroups((current) => {
        const next = new Set(current);
        if (collapsed) next.add(group.id);
        else next.delete(group.id);
        return next;
      });
    };
    const rememberTransitionData = () => {
      transitionDataRef.current = { rowIds: currentRowIds };
    };
    const startTransition = (phase: VirtualGroupTransition["phase"], collapsed: boolean) => {
      clearTimer();
      if (duration <= 0) {
        setCollapsed(collapsed);
        setVirtualGroupTransition(null);
        return;
      }
      setVirtualGroupTransition({ groupId: group.id, phase });
      setCollapsed(collapsed);
    };

    if (virtualGroupTransition?.groupId === group.id) {
      if (virtualGroupTransition.phase === "preparing-collapse") {
        clearTimer();
        transitionDataRef.current = null;
        setVirtualGroupTransition(null);
        return;
      }
      if (virtualGroupTransition.phase === "preparing-expansion") {
        clearTimer();
        setCollapsed(true);
        transitionDataRef.current = null;
        setVirtualGroupTransition(null);
        return;
      }
      if (virtualGroupTransition.phase === "collapsing") {
        startTransition("expanding", false);
        return;
      }
      if (virtualGroupTransition.phase === "expanding") {
        startTransition("collapsing", true);
        return;
      }
    }

    if (collapsedGroups.has(group.id)) {
      rememberTransitionData();
      startTransition("preparing-expansion", false);
      return;
    }

    if (duration <= 0) {
      setCollapsed(true);
      setVirtualGroupTransition(null);
      return;
    }
    rememberTransitionData();
    startTransition("preparing-collapse", false);
  };

  useLayoutEffect(() => {
    const transition = virtualGroupTransition;
    if (
      !transition ||
      (transition.phase !== "preparing-collapse" && transition.phase !== "preparing-expansion")
    )
      return;
    noteListRef.current?.querySelector<HTMLElement>(".virtual-group-motion-clip")?.offsetHeight;
    const frame = requestAnimationFrame(() => {
      if (transition.phase === "preparing-collapse") {
        setCollapsedGroups((current) => new Set(current).add(transition.groupId));
        setVirtualGroupTransition({ groupId: transition.groupId, phase: "collapsing" });
      } else {
        setVirtualGroupTransition({ groupId: transition.groupId, phase: "expanding" });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [virtualGroupTransition]);

  useLayoutEffect(() => {
    if (
      !virtualGroupTransition ||
      (virtualGroupTransition.phase !== "collapsing" &&
        virtualGroupTransition.phase !== "expanding")
    )
      return;
    const clip = noteListRef.current?.querySelector<HTMLElement>(".virtual-group-motion-clip");
    const finish = () => {
      if (virtualGroupTransitionTimerRef.current !== null)
        window.clearTimeout(virtualGroupTransitionTimerRef.current);
      virtualGroupTransitionTimerRef.current = null;
      transitionDataRef.current = null;
      setVirtualGroupTransition(null);
    };
    const onTransitionEnd = (event: TransitionEvent) => {
      if (event.target === clip && event.propertyName === "height") finish();
    };
    clip?.addEventListener("transitionend", onTransitionEnd);
    // 快速反向点击也重新安排收尾；无高度差时浏览器不会发 transitionend。
    virtualGroupTransitionTimerRef.current = window.setTimeout(
      finish,
      groupMotionDuration(noteListRef.current) + 50,
    );
    return () => {
      clip?.removeEventListener("transitionend", onTransitionEnd);
      if (virtualGroupTransitionTimerRef.current !== null)
        window.clearTimeout(virtualGroupTransitionTimerRef.current);
      virtualGroupTransitionTimerRef.current = null;
    };
  }, [virtualGroupTransition]);

  useLayoutEffect(() => {
    if (!transitionDataChanged || !virtualGroupTransition) return;
    if (virtualGroupTransitionTimerRef.current !== null)
      window.clearTimeout(virtualGroupTransitionTimerRef.current);
    virtualGroupTransitionTimerRef.current = null;
    transitionDataRef.current = null;
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (
        virtualGroupTransition.phase === "collapsing" ||
        virtualGroupTransition.phase === "preparing-collapse"
      )
        next.add(virtualGroupTransition.groupId);
      else next.delete(virtualGroupTransition.groupId);
      return next;
    });
    setVirtualGroupTransition(null);
  }, [transitionDataChanged, virtualGroupTransition]);

  useEffect(() => {
    if (virtualGroupTransition) return;
    const queuedGroupId = queuedVirtualGroupIdRef.current;
    if (!queuedGroupId) return;
    queuedVirtualGroupIdRef.current = null;
    const queuedGroup = groups?.find((group) => group.id === queuedGroupId);
    if (!queuedGroup) return;
    const frame = requestAnimationFrame(() => toggleVirtualGroup(queuedGroup));
    return () => cancelAnimationFrame(frame);
  }, [groups, virtualGroupTransition]);

  useLayoutEffect(() => {
    if (virtualGroupTransition) return;
    const focus = focusRestoreRef.current;
    if (!focus || document.activeElement !== document.body) return;
    const selector = `[data-note-id="${CSS.escape(focus.noteId)}"] ${focus.selector}`;
    let target = noteListRef.current?.querySelector<HTMLElement>(selector);
    if (!target || target.closest("[inert]")) {
      const groupId = groupByNoteId.get(focus.noteId)?.id;
      const markerId = groupId ? noteGroupRowId(groupId) : null;
      target = markerId
        ? (noteListRef.current?.querySelector<HTMLElement>(
            `[data-note-id="${CSS.escape(markerId)}"] .note-list-virtual-group-toggle`,
          ) ?? null)
        : null;
    }
    if (!target || target.closest("[inert]"))
      target =
        noteListRef.current?.querySelector<HTMLElement>(
          ".note-list-group-header.is-virtual-sticky button",
        ) ?? null;
    target?.focus({ preventScroll: true });
    focusRestoreRef.current = null;
  }, [groupByNoteId, virtualGroupTransition]);

  useEffect(
    () => () => {
      if (virtualGroupTransitionTimerRef.current !== null)
        window.clearTimeout(virtualGroupTransitionTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (virtualGroupTransition) return;
    const focus = focusRestoreRef.current;
    if (!focus || document.activeElement !== document.body) return;
    const noteRow = noteListRef.current?.querySelector<HTMLElement>(
      `[data-note-id="${CSS.escape(focus.noteId)}"] ${focus.selector}`,
    );
    if (noteRow && !noteRow.closest("[inert]")) {
      noteRow.focus({ preventScroll: true });
      focusRestoreRef.current = null;
    }
  }, [virtualGroupTransition, virtualList.visibleRows]);

  const keyboardNotes = useMemo(
    () =>
      groups
        ? groups.flatMap((group) =>
            collapsedGroups.has(group.id) ||
            (virtualGroupTransition?.groupId === group.id &&
              virtualGroupTransition.phase === "collapsing")
              ? []
              : group.notes,
          )
        : sortedNotes,
    [collapsedGroups, groups, sortedNotes, virtualGroupTransition],
  );

  const handleNoteListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    virtualList.moveTabFocus(event);
    if (event.defaultPrevented) return;
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.isContentEditable || target.matches("input, textarea, select"))
    )
      return;
    if (
      target instanceof HTMLElement &&
      target.closest(".note-list-group-toggle, .note-list-virtual-group-toggle")
    )
      return;

    const isPlainKey = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;

    if (isPlainKey && (event.key === "j" || event.key === "J" || event.key === "ArrowDown")) {
      event.preventDefault();
      const currentIndex = keyboardNotes.findIndex((n) => n.id === selectedId);
      const nextIndex =
        currentIndex >= 0 && currentIndex < keyboardNotes.length - 1 ? currentIndex + 1 : 0;
      const nextNote = keyboardNotes[nextIndex];
      if (nextNote) {
        onSelect(nextNote.id, event as unknown as ReactMouseEvent<HTMLButtonElement>);
        virtualList.focusRow(nextNote.id);
      }
      return;
    }

    if (isPlainKey && (event.key === "k" || event.key === "K" || event.key === "ArrowUp")) {
      event.preventDefault();
      const currentIndex = keyboardNotes.findIndex((n) => n.id === selectedId);
      const prevIndex = currentIndex > 0 ? currentIndex - 1 : keyboardNotes.length - 1;
      const prevNote = keyboardNotes[prevIndex];
      if (prevNote) {
        onSelect(prevNote.id, event as unknown as ReactMouseEvent<HTMLButtonElement>);
        virtualList.focusRow(prevNote.id);
      }
      return;
    }

    if (isPlainKey && event.key === "Enter") {
      if (selectedId && onFocusEditor) {
        event.preventDefault();
        onFocusEditor();
        return;
      }
    }

    if (isPlainKey && (event.key === "s" || event.key === "S")) {
      const currentNote = sortedNotes.find((n) => n.id === selectedId);
      if (currentNote) {
        event.preventDefault();
        onToggleFavoriteNote(currentNote);
        return;
      }
    }

    if (
      (event.key === "Delete" || event.key === "Backspace") &&
      (selectedIds.size > 0 || selectedId)
    ) {
      event.preventDefault();
      onDeleteSelected();
      return;
    }
  };
  const heading = query ? "搜索结果" : (currentNotebookName ?? viewLabel(view));
  const truncated = hasMore;
  const hasLoadMoreRow = hasMore && Boolean(onLoadMore);
  const listSize = Math.max(total, sortedNotes.length);
  const activeMotionGroup = transitionDataChanged ? null : virtualList.transitionGroup;
  const motionCollapsed =
    virtualGroupTransition?.phase === "collapsing" ||
    virtualGroupTransition?.phase === "preparing-expansion";
  const listStyle: CSSProperties | undefined = virtualList.isVirtualized
    ? {
        position: "relative",
        height: `${virtualList.totalHeight - (motionCollapsed ? (activeMotionGroup?.height ?? 0) : 0) + (hasLoadMoreRow ? 76 : 0)}px`,
      }
    : undefined;
  const noteListStyle: CSSProperties = { overflowAnchor: "none" };
  const motionGroupHeader = activeMotionGroup
    ? virtualList.visibleRows.find(({ index }) => index === activeMotionGroup.start)
    : undefined;
  const motionContentTop = activeMotionGroup ? virtualList.rowTop(activeMotionGroup.start + 1) : 0;
  const motionAfterTop = activeMotionGroup ? virtualList.rowTop(activeMotionGroup.end) : 0;
  const motionRows = activeMotionGroup
    ? partitionVirtualGroupRows(
        virtualList.visibleRows,
        activeMotionGroup.start,
        activeMotionGroup.end,
        motionContentTop,
        motionAfterTop,
      )
    : null;
  const renderVirtualNote = (note: NoteSummary, rowIndex: number, top: number) => (
    <NoteListRow
      key={note.id}
      note={note}
      rowIndex={sortedIndexById.get(note.id) ?? rowIndex}
      setSize={listSize}
      rowRef={virtualList.getRowRef(note.id)}
      rowStyle={virtualList.rowStyle(top)}
      isSelected={selectedIds.has(note.id)}
      isActive={selectedId === note.id && !isMobileViewport}
      showNotebook
      onToggleFavorite={onToggleFavoriteNote}
      onSelect={onSelect}
      isMobileViewport={isMobileViewport}
      isTrashView={view === "trash"}
      trashBusy={trashBusy}
      onNoteSwipeAction={onNoteSwipeAction}
      open={swipeActions.openId === note.id}
      setOpenId={swipeActions.setOpenId}
      isDragging={draggingNoteIds?.has(note.id) ?? false}
      onDragStart={handleRowDragStart}
      onDragEnd={handleRowDragEnd}
    />
  );
  const renderVirtualGroupMarker = (
    row: Extract<VirtualNoteListRow, { kind: "group" }>,
    top: number,
  ) => {
    const isStickyMarker = virtualStickyGroup?.id === row.group.id;
    const isFocusedMarker = virtualList.pinnedRowId === row.id;
    const hideMarker = isStickyMarker && !isFocusedMarker;
    const markerTransition =
      virtualGroupTransition?.groupId === row.group.id ? virtualGroupTransition.phase : null;
    const markerCollapsed =
      markerTransition === "collapsing" || markerTransition === "preparing-expansion"
        ? true
        : markerTransition === "expanding" || markerTransition === "preparing-collapse"
          ? false
          : collapsedGroups.has(row.group.id);
    return (
      <li
        key={row.id}
        ref={virtualList.getRowRef(row.id)}
        data-note-id={row.id}
        className={`note-list-virtual-group-marker${row.firstGroup ? " is-first" : ""}${markerCollapsed ? " is-collapsed" : ""}${hideMarker ? " is-sticky-marker" : ""}`}
        role="presentation"
        aria-hidden={hideMarker || undefined}
        inert={hideMarker || undefined}
        style={virtualList.rowStyle(top)}
      >
        <button
          type="button"
          className="note-list-virtual-group-toggle"
          aria-expanded={!markerCollapsed}
          aria-controls="note-list-virtual-rows"
          onClick={() => toggleVirtualGroup(row.group)}
        >
          <ChevronDown className="note-list-group-chevron" size={13} aria-hidden="true" />
          <span className="note-list-group-title">{row.group.title}</span>
          <span className="note-list-group-count">{row.group.count}</span>
        </button>
      </li>
    );
  };
  const handleVirtualListFocusCapture = (event: ReactFocusEvent<HTMLDivElement>) => {
    virtualList.onFocusCapture(event);
    const active = event.target;
    if (!(active instanceof HTMLElement)) {
      focusRestoreRef.current = null;
      return;
    }
    const row = active.closest<HTMLElement>("[data-note-id]");
    if (!row?.dataset.noteId || row.dataset.noteId.startsWith("group-marker:")) {
      focusRestoreRef.current = null;
      return;
    }
    const button = active.closest<HTMLButtonElement>("button");
    if (!button) {
      focusRestoreRef.current = null;
      return;
    }
    const selector = button.classList.contains("note-row")
      ? ".note-row"
      : button.classList.contains("note-row-star-btn")
        ? ".note-row-star-btn"
        : button.classList.contains("swipe-action-button")
          ? `.swipe-action-button:nth-of-type(${Array.from(button.parentElement?.children ?? []).indexOf(button) + 1})`
          : null;
    focusRestoreRef.current = selector ? { noteId: row.dataset.noteId, selector } : null;
  };
  const handleVirtualListBlurCapture = (event: ReactFocusEvent<HTMLDivElement>) => {
    if (!virtualGroupTransition) virtualList.onBlurCapture(event);
  };
  return (
    <section
      ref={panelRef}
      className={`note-list-panel ${outlineOpen ? "is-outline-open" : ""}`.trim()}
      aria-label={outlineOpen ? "笔记大纲" : "笔记列表"}
      aria-hidden={inert || undefined}
      inert={inert}
    >
      <div className="note-list-content">
        {outlineOpen && (
          <NoteOutlinePanel
            outlineItems={outlineItems}
            activeOutlineId={activeOutlineId}
            onScrollToOutlineItem={onScrollToOutlineItem}
            onCloseOutline={onCloseOutline}
          />
        )}
        <div className="note-list-body" hidden={outlineOpen} inert={outlineOpen || undefined}>
          {isMobileViewport ? (
            <MobileCollectionHeader
              active={!inert}
              heading={heading}
              total={total}
              shown={notes.length}
              query={query}
              onBack={onOpenSidebar}
              onEmptyTrash={onEmptyTrash}
              trashBusy={trashBusy}
            />
          ) : (
            <header className="list-header">
              <button
                className="icon-button mobile-only"
                type="button"
                aria-label="打开导航"
                onClick={onOpenSidebar}
              >
                <Menu size={20} />
              </button>
              <div className="list-header-main">
                <h2 tabIndex={-1}>{heading}</h2>
                <p>
                  {query
                    ? searchResultLabel(query, total)
                    : `${truncated ? total : notes.length} 篇笔记`}
                  {truncated && <> · 已显示最近 {notes.length} 篇</>}
                </p>
              </div>
              <div className="list-header-controls">
                {onEmptyTrash && (
                  <EmptyTrashButton onClick={onEmptyTrash} disabled={trashBusy || total === 0} />
                )}
                {onNewNote && !isMobileViewport && (
                  <button
                    className="icon-button list-new-note-button"
                    type="button"
                    aria-label={
                      creatingNote ? "正在新建笔记" : `在${currentNotebookName}中新建笔记`
                    }
                    aria-busy={creatingNote || undefined}
                    disabled={creatingNote}
                    onClick={onNewNote}
                  >
                    {creatingNote ? (
                      <LoaderCircle className="spin-icon" size={18} aria-hidden="true" />
                    ) : (
                      <Plus size={18} aria-hidden="true" />
                    )}
                  </button>
                )}
              </div>
            </header>
          )}
          <div
            className={`note-list-scroll-shell${noteListScrollEdges.before || isAnchoring ? " has-scroll-before" : ""}${noteListScrollEdges.after ? " has-scroll-after" : ""}`}
          >
            <div
              id="note-list-scroll-region"
              className="note-list floating-scrollbar-target"
              ref={setNoteListRef}
              tabIndex={-1}
              style={noteListStyle}
              onKeyDown={handleNoteListKeyDown}
              onFocusCapture={handleVirtualListFocusCapture}
              onBlurCapture={handleVirtualListBlurCapture}
            >
              {virtualList.isVirtualized && virtualStickyGroup && (
                <div
                  className="note-list-group-header is-virtual-sticky"
                  style={{ transform: `translateY(${virtualList.stickyOffset}px)` }}
                >
                  <button
                    type="button"
                    className="note-list-virtual-group-toggle"
                    aria-expanded={!virtualStickyGroupCollapsed}
                    aria-controls="note-list-virtual-rows"
                    onClick={() => toggleVirtualGroup(virtualStickyGroup)}
                  >
                    <ChevronDown className="note-list-group-chevron" size={13} aria-hidden="true" />
                    <span className="note-list-group-title">{virtualStickyGroup.title}</span>
                    <span className="note-list-group-count">{virtualStickyGroup.count}</span>
                  </button>
                </div>
              )}
              {!virtualList.isVirtualized && groups ? (
                <div className="note-list-groups">
                  {groups.map((group) => {
                    const collapsed = collapsedGroups.has(group.id);
                    const contentId = `note-list-group-${group.id}`;
                    return (
                      <section
                        key={group.id}
                        className="note-list-group"
                        aria-label={`${group.title}，共 ${group.count} 篇`}
                      >
                        <h2 className="note-list-group-header">
                          <button
                            type="button"
                            className="note-list-group-toggle"
                            aria-expanded={!collapsed}
                            aria-controls={contentId}
                            onClick={(event) => toggleGroup(group.id, event.currentTarget)}
                          >
                            <ChevronDown
                              className="note-list-group-chevron"
                              size={13}
                              aria-hidden="true"
                            />
                            <span className="note-list-group-title">{group.title}</span>
                            <span className="note-list-group-count">{group.count}</span>
                          </button>
                        </h2>
                        <div
                          id={contentId}
                          className={`note-list-group-content${collapsed ? " is-collapsed" : ""}`}
                          inert={collapsed}
                        >
                          <ul className="note-list-group-items note-list-items" role="list">
                            {group.notes.map((note) => {
                              const index = sortedIndexById.get(note.id) ?? -1;
                              return (
                                <NoteListRow
                                  key={note.id}
                                  note={note}
                                  rowIndex={index}
                                  setSize={listSize}
                                  isSelected={selectedIds.has(note.id)}
                                  isActive={selectedId === note.id && !isMobileViewport}
                                  showNotebook
                                  onToggleFavorite={onToggleFavoriteNote}
                                  onSelect={onSelect}
                                  isMobileViewport={isMobileViewport}
                                  isTrashView={view === "trash"}
                                  trashBusy={trashBusy}
                                  onNoteSwipeAction={onNoteSwipeAction}
                                  open={swipeActions.openId === note.id}
                                  setOpenId={swipeActions.setOpenId}
                                  isDragging={draggingNoteIds?.has(note.id) ?? false}
                                  onDragStart={handleRowDragStart}
                                  onDragEnd={handleRowDragEnd}
                                />
                              );
                            })}
                          </ul>
                        </div>
                      </section>
                    );
                  })}
                  {hasLoadMoreRow && (
                    <div ref={setLoadMoreSentinel} className="note-list-load-more-item">
                      <button
                        className="secondary-button note-list-load-more-button"
                        type="button"
                        onClick={onLoadMore}
                        disabled={isLoadingMore}
                      >
                        {isLoadingMore ? "正在加载……" : noteLoadMoreLabel(notes.length, total)}
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <ul
                  id={virtualList.isVirtualized ? "note-list-virtual-rows" : undefined}
                  className={`note-list-items${activeMotionGroup ? " virtual-group-list-motion" : ""}`}
                  role="list"
                  style={listStyle}
                >
                  {activeMotionGroup && motionRows && motionGroupHeader?.row.kind === "group" ? (
                    <>
                      {motionRows.before.map(({ row, index, top }) =>
                        row.kind === "group"
                          ? renderVirtualGroupMarker(row, top)
                          : renderVirtualNote(row.note, index, top),
                      )}
                      {renderVirtualGroupMarker(motionGroupHeader.row, motionGroupHeader.top)}
                      <li
                        key={`virtual-group-motion-${virtualGroupTransition?.groupId}`}
                        className="virtual-group-motion note-list-virtual-group-motion"
                        role="presentation"
                        style={virtualList.rowStyle(motionContentTop)}
                      >
                        <div
                          className={`virtual-group-motion-clip note-list-virtual-group-clip${virtualGroupTransition?.phase === "collapsing" || virtualGroupTransition?.phase === "preparing-expansion" ? " is-collapsed" : ""}`}
                          style={
                            {
                              "--group-content-height": `${activeMotionGroup.height}px`,
                            } as CSSProperties
                          }
                          inert={virtualGroupTransition?.phase === "collapsing" || undefined}
                        >
                          <div className="virtual-group-motion-clip-content">
                            <ul
                              className="note-list-items note-list-virtual-group-content"
                              role="list"
                              style={{ height: `${activeMotionGroup.height}px` }}
                            >
                              {motionRows.group.map(({ row, index, localTop }) =>
                                row.kind === "note"
                                  ? renderVirtualNote(row.note, index, localTop)
                                  : null,
                              )}
                            </ul>
                          </div>
                        </div>
                        <ul
                          className="note-list-items virtual-group-motion-after note-list-virtual-group-after"
                          role="list"
                          style={{
                            height: `${Math.max(0, virtualList.totalHeight - motionAfterTop + (hasLoadMoreRow ? 76 : 0))}px`,
                          }}
                        >
                          {motionRows.after.map(({ row, index, localTop }) =>
                            row.kind === "group"
                              ? renderVirtualGroupMarker(row, localTop)
                              : renderVirtualNote(row.note, index, localTop),
                          )}
                          {hasLoadMoreRow && (
                            <li
                              ref={setLoadMoreSentinel}
                              className="note-list-load-more-item"
                              style={{
                                position: "absolute",
                                insetInline: 0,
                                top: 0,
                                transform: `translateY(${virtualList.totalHeight - motionAfterTop}px)`,
                              }}
                            >
                              <button
                                className="secondary-button note-list-load-more-button"
                                type="button"
                                onClick={onLoadMore}
                                disabled={isLoadingMore}
                              >
                                {isLoadingMore
                                  ? "正在加载……"
                                  : noteLoadMoreLabel(notes.length, total)}
                              </button>
                            </li>
                          )}
                        </ul>
                      </li>
                    </>
                  ) : (
                    <>
                      {virtualList.visibleRows.map(({ row, index, top }) =>
                        row.kind === "group"
                          ? renderVirtualGroupMarker(row, top)
                          : renderVirtualNote(row.note, index, top),
                      )}
                      {hasLoadMoreRow && (
                        <li
                          ref={setLoadMoreSentinel}
                          className="note-list-load-more-item"
                          style={
                            virtualList.isVirtualized
                              ? {
                                  position: "absolute",
                                  insetInline: 0,
                                  top: 0,
                                  transform: `translateY(${virtualList.totalHeight}px)`,
                                }
                              : undefined
                          }
                        >
                          <button
                            className="secondary-button note-list-load-more-button"
                            type="button"
                            onClick={onLoadMore}
                            disabled={isLoadingMore}
                          >
                            {isLoadingMore ? "正在加载……" : noteLoadMoreLabel(notes.length, total)}
                          </button>
                        </li>
                      )}
                    </>
                  )}
                </ul>
              )}
              {!sortedNotes.length &&
                (query ? (
                  <div className="list-empty">
                    <span className="empty-icon">
                      <Search size={23} />
                    </span>
                    <strong>没有找到匹配的笔记</strong>
                    <span>试试更短的关键词，或清空搜索查看全部内容。</span>
                    <button className="secondary-button" type="button" onClick={onClearQuery}>
                      清空搜索
                    </button>
                  </div>
                ) : (
                  <div className="list-empty">
                    <span className="empty-icon">
                      <Archive size={23} />
                    </span>
                    <strong>{view === "trash" ? "回收站是空的" : "这里还没有笔记"}</strong>
                    <span>
                      {view === "trash"
                        ? "移入回收站的笔记会显示在这里。"
                        : "按下“新建笔记”，让一个想法有地方落脚。"}
                    </span>
                  </div>
                ))}
            </div>
            <FloatingScrollbar
              scrollTargetRef={noteListRef}
              controlsId="note-list-scroll-region"
              ariaLabel="笔记列表滚动条"
              placement="right"
            />
          </div>
        </div>
      </div>
    </section>
  );
});

export function EmptyEditor({
  isTrash,
  onNewNote,
  creatingNote = false,
  onOpenList,
  transitionToken,
}: {
  isTrash: boolean;
  onNewNote: () => void;
  creatingNote?: boolean;
  onOpenList: () => void;
  transitionToken: number;
}) {
  return (
    <section key={transitionToken} className="empty-editor">
      <button
        className="icon-button mobile-only empty-back"
        type="button"
        aria-label="打开笔记列表"
        onClick={onOpenList}
      >
        <ChevronLeft size={20} />
      </button>
      <BrandMark className="empty-editor-mark" />
      <h1 tabIndex={-1}>{isTrash ? "回收站是空的" : "让想法有地方落脚"}</h1>
      <p>{isTrash ? "没有需要清理或恢复的笔记。" : "创建一篇笔记，记录此刻值得留下的东西。"}</p>
      {!isTrash && (
        <>
          <button
            className="primary-button"
            type="button"
            aria-busy={creatingNote || undefined}
            disabled={creatingNote}
            onClick={onNewNote}
          >
            {creatingNote ? (
              <LoaderCircle className="spin-icon" size={18} aria-hidden="true" />
            ) : (
              <Plus size={18} aria-hidden="true" />
            )}
            {creatingNote ? "正在新建…" : "新建笔记"}
          </button>
          <span className="empty-shortcut">或按 {commandMenuShortcutLabel} 打开命令菜单</span>
        </>
      )}
    </section>
  );
}
