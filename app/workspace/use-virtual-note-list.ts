import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import type { NoteSummary } from "../../shared/types";
import type { NoteGroup } from "./helpers";
import { collapsingGroupRange, stickyGroupOffset } from "./group-layout";

const VIRTUALIZE_AFTER = 140;
const ESTIMATED_ROW_HEIGHT = 120;
const GROUP_HEADER_HEIGHT = 30;
const OVERSCAN_PX = 720;

export type VirtualNoteListRow =
  | { id: string; kind: "note"; note: NoteSummary }
  | { id: string; kind: "group"; group: NoteGroup; firstGroup: boolean };

export function noteGroupRowId(groupId: string) {
  return `group-marker:${groupId}`;
}

export function flattenNoteGroups(
  groups: readonly NoteGroup[],
  collapsedGroupIds: ReadonlySet<string>,
  collapsingGroupId?: string | null,
) {
  const rows: VirtualNoteListRow[] = [];
  for (const group of groups) {
    if (group.notes.length === 0) continue;
    rows.push({
      id: noteGroupRowId(group.id),
      kind: "group",
      group,
      firstGroup: rows.length === 0,
    });
    if (collapsedGroupIds.has(group.id) && collapsingGroupId !== group.id) continue;
    for (const note of group.notes) rows.push({ id: note.id, kind: "note", note });
  }
  return rows;
}

type Viewport = { top: number; height: number };

function estimatedRowHeight(row: VirtualNoteListRow) {
  if (row.kind === "group") return row.firstGroup ? 0 : GROUP_HEADER_HEIGHT;
  return ESTIMATED_ROW_HEIGHT;
}

function offsetsForRows(rows: readonly VirtualNoteListRow[], heights: Map<string, number>) {
  const offsets = new Array<number>(rows.length + 1);
  offsets[0] = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    offsets[index + 1] =
      offsets[index]! +
      (row.kind === "group" && row.firstGroup
        ? 0
        : (heights.get(row.id) ?? estimatedRowHeight(row)));
  }
  return offsets;
}

function indexAtOffset(offsets: readonly number[], offset: number) {
  const count = offsets.length - 1;
  let low = 0;
  let high = count;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (offsets[middle + 1]! <= offset) low = middle + 1;
    else high = middle;
  }
  return Math.min(low, count);
}

export function useVirtualNoteList(
  rows: readonly VirtualNoteListRow[],
  scrollRef: RefObject<HTMLDivElement | null>,
  scrollElement: HTMLDivElement | null,
  scope: string,
  virtualizationCount = rows.length,
  animatingGroupId: string | null = null,
  isCollapsing = false,
) {
  const [viewport, setViewport] = useState<Viewport>({ top: 0, height: 800 });
  const [measurementRevision, setMeasurementRevision] = useState(0);
  const [pinnedIndex, setPinnedIndex] = useState<number | null>(null);
  const [stickyHeaderHeight, setStickyHeaderHeight] = useState(0);
  const heightsRef = useRef(new Map<string, number>());
  const observerRef = useRef<ResizeObserver | null>(null);
  const rowElementsRef = useRef(new Map<string, HTMLLIElement>());
  const rowRefCallbacksRef = useRef(new Map<string, (element: HTMLLIElement | null) => void>());
  const rowStylesRef = useRef(new Map<number, CSSProperties>());
  const pendingFocusIdRef = useRef<string | null>(null);
  const contentInsetRef = useRef(0);
  const stickyHeaderHeightRef = useRef(0);
  const indexById = useMemo(() => new Map(rows.map((row, index) => [row.id, index])), [rows]);
  const indexByIdRef = useRef(indexById);
  indexByIdRef.current = indexById;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const offsets = useMemo(
    () => offsetsForRows(rows, heightsRef.current),
    [rows, measurementRevision],
  );
  const offsetsRef = useRef(offsets);
  offsetsRef.current = offsets;
  const isVirtualized = virtualizationCount > VIRTUALIZE_AFTER;
  const hasGroupRows = rows[0]?.kind === "group";

  useLayoutEffect(() => {
    heightsRef.current.clear();
    rowRefCallbacksRef.current.clear();
    rowStylesRef.current.clear();
    if (scrollElement) scrollElement.scrollTop = 0;
    setViewport((current) => ({ ...current, top: 0 }));
    setPinnedIndex(null);
    setMeasurementRevision((revision) => revision + 1);
  }, [scope, scrollElement]);

  // 同一 scope 内删除或移出笔记后，及时裁掉已不存在的测量值与 ref 回调，避免长期滞留。
  useLayoutEffect(() => {
    const rowsRef = rowElementsRef.current;
    for (const noteId of heightsRef.current.keys()) {
      if (!indexById.has(noteId)) heightsRef.current.delete(noteId);
    }
    for (const noteId of rowRefCallbacksRef.current.keys()) {
      if (indexById.has(noteId)) continue;
      const element = rowsRef.get(noteId);
      if (element) observerRef.current?.unobserve(element);
      rowsRef.delete(noteId);
      rowRefCallbacksRef.current.delete(noteId);
    }
  }, [indexById]);

  useLayoutEffect(() => {
    const container = scrollElement;
    if (!container || !isVirtualized) return;

    let scrollFrame = 0;
    let viewportHeight = container.clientHeight || 800;
    const updateViewport = () => {
      setViewport((current) => {
        const next = {
          top: Math.max(0, container.scrollTop - contentInsetRef.current),
          height: viewportHeight,
        };
        return current.top === next.top && current.height === next.height ? current : next;
      });
    };
    const updateGeometry = () => {
      contentInsetRef.current = Number.parseFloat(getComputedStyle(container).paddingTop) || 0;
      const header = container.querySelector<HTMLElement>(
        ".note-list-group-header.is-virtual-sticky",
      );
      const headerHeight = header?.getBoundingClientRect().height ?? 0;
      stickyHeaderHeightRef.current = headerHeight;
      setStickyHeaderHeight((current) =>
        Math.abs(current - headerHeight) < 0.5 ? current : headerHeight,
      );
      viewportHeight = container.clientHeight || viewportHeight;
      updateViewport();
    };
    const onScroll = () => {
      if (scrollFrame) return;
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = 0;
        updateViewport();
      });
    };
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateGeometry);
    resizeObserver?.observe(container);
    const header = container.querySelector<HTMLElement>(
      ".note-list-group-header.is-virtual-sticky",
    );
    if (header) resizeObserver?.observe(header);
    container.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", updateGeometry, { passive: true });
    updateGeometry();

    return () => {
      if (scrollFrame) cancelAnimationFrame(scrollFrame);
      container.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", updateGeometry);
      resizeObserver?.disconnect();
    };
  }, [hasGroupRows, isVirtualized, scrollElement, scrollRef]);

  useLayoutEffect(() => {
    if (!scrollElement || !isVirtualized || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const container = scrollElement;
      const oldOffsets = offsetsRef.current;
      const anchorIndex = container
        ? indexAtOffset(oldOffsets, Math.max(0, container.scrollTop - contentInsetRef.current))
        : 0;
      let anchorAdjustment = 0;
      let changed = false;

      for (const entry of entries) {
        const element = entry.target as HTMLLIElement;
        const noteId = element.dataset.noteId;
        if (!noteId) continue;
        const index = indexByIdRef.current.get(noteId);
        if (index === undefined) continue;
        const borderBox = entry.borderBoxSize as unknown as
          ResizeObserverSize | readonly ResizeObserverSize[] | undefined;
        const measuredHeight = borderBox
          ? "blockSize" in borderBox
            ? borderBox.blockSize
            : borderBox[0]?.blockSize
          : undefined;
        const nextHeight = measuredHeight ?? element.getBoundingClientRect().height;
        if (!Number.isFinite(nextHeight) || nextHeight <= 0) continue;
        const previousHeight =
          heightsRef.current.get(noteId) ?? estimatedRowHeight(rowsRef.current[index]!);
        if (Math.abs(previousHeight - nextHeight) < 0.75) continue;
        heightsRef.current.set(noteId, nextHeight);
        if (index < anchorIndex) anchorAdjustment += nextHeight - previousHeight;
        changed = true;
      }

      if (!changed) return;
      if (container && anchorAdjustment !== 0) container.scrollTop += anchorAdjustment;
      setMeasurementRevision((revision) => revision + 1);
    });
    observerRef.current = observer;
    for (const element of rowElementsRef.current.values()) observer.observe(element);
    return () => {
      observer.disconnect();
      if (observerRef.current === observer) observerRef.current = null;
    };
  }, [isVirtualized, scrollElement, scrollRef]);

  const startIndex = isVirtualized
    ? indexAtOffset(offsets, Math.max(0, viewport.top - OVERSCAN_PX))
    : 0;
  const topVisibleIndex = rows.length
    ? Math.min(indexAtOffset(offsets, viewport.top - stickyHeaderHeight), rows.length - 1)
    : -1;
  const endIndex = isVirtualized
    ? Math.min(
        rows.length,
        indexAtOffset(offsets, viewport.top + viewport.height + OVERSCAN_PX) + 1,
      )
    : rows.length;
  const animatedGroup = useMemo(() => {
    if (!animatingGroupId) return null;
    return collapsingGroupRange(rows, offsets, indexById.get(noteGroupRowId(animatingGroupId)));
  }, [animatingGroupId, indexById, offsets, rows]);
  const collapsingGroup = isCollapsing ? animatedGroup : null;
  const shiftedStart = animatedGroup
    ? Math.max(
        animatedGroup.end,
        indexAtOffset(offsets, viewport.top + animatedGroup.height - OVERSCAN_PX),
      )
    : 0;
  const shiftedEnd = animatedGroup
    ? Math.min(
        rows.length,
        indexAtOffset(
          offsets,
          viewport.top + viewport.height + animatedGroup.height + OVERSCAN_PX,
        ) + 1,
      )
    : 0;
  const visibleRows = useMemo(() => {
    const indices = new Set<number>();
    for (let index = startIndex; index < endIndex; index += 1) indices.add(index);
    if (isVirtualized && animatedGroup) {
      for (let index = shiftedStart; index < shiftedEnd; index += 1) indices.add(index);
    }
    if (pinnedIndex !== null && pinnedIndex >= 0 && pinnedIndex < rows.length)
      indices.add(pinnedIndex);
    const result: Array<{ row: VirtualNoteListRow; index: number; top: number }> = [];
    for (const index of [...indices].sort((left, right) => left - right)) {
      const row = rows[index];
      if (row) result.push({ row, index, top: offsets[index]! });
    }
    return result;
  }, [
    animatedGroup,
    endIndex,
    isVirtualized,
    offsets,
    pinnedIndex,
    rows,
    startIndex,
    shiftedStart,
    shiftedEnd,
  ]);
  const nextGroupTop = visibleRows.find(
    ({ row, index }) => index > topVisibleIndex && row.kind === "group",
  )?.top;

  const getRowRef = useCallback((noteId: string) => {
    let callback = rowRefCallbacksRef.current.get(noteId);
    if (!callback) {
      callback = (element) => {
        const previous = rowElementsRef.current.get(noteId);
        if (previous && previous !== element) observerRef.current?.unobserve(previous);
        if (!element) {
          rowElementsRef.current.delete(noteId);
          return;
        }
        rowElementsRef.current.set(noteId, element);
        observerRef.current?.observe(element);
      };
      rowRefCallbacksRef.current.set(noteId, callback);
    }
    return callback;
  }, []);

  // 按 top 缓存样式对象：同一偏移复用同一引用，memo(NoteListRow) 的 rowStyle prop 才不会每次渲染都失效。
  const rowStyle = useCallback(
    (top: number) => {
      if (!isVirtualized) return undefined;
      const cache = rowStylesRef.current;
      const cached = cache.get(top);
      if (cached) return cached;
      const style = {
        position: "absolute",
        insetInline: 0,
        top: 0,
        transform: `translateY(${top}px)`,
      } as CSSProperties;
      if (cache.size > 512) cache.clear();
      cache.set(top, style);
      return style;
    },
    [isVirtualized],
  );

  const scrollToRowStart = useCallback(
    (noteId: string) => {
      const index = indexByIdRef.current.get(noteId);
      const container = scrollRef.current;
      if (index === undefined || !container) return;
      const top = offsetsRef.current[index] ?? 0;
      const row = rowsRef.current[index];
      container.scrollTop =
        row?.kind === "group" && !row.firstGroup
          ? top + stickyHeaderHeightRef.current
          : row?.kind === "group"
            ? 0
            : top + contentInsetRef.current;
      setViewport((current) => {
        const next = {
          top: container.scrollTop - contentInsetRef.current,
          height: container.clientHeight || current.height || 800,
        };
        return current.top === next.top && current.height === next.height ? current : next;
      });
    },
    [scrollRef],
  );

  const onFocusCapture = useCallback((event: ReactFocusEvent<HTMLDivElement>) => {
    const noteId = (event.target as HTMLElement).closest<HTMLElement>("[data-note-id]")?.dataset
      .noteId;
    setPinnedIndex(noteId ? (indexByIdRef.current.get(noteId) ?? null) : null);
  }, []);
  const onBlurCapture = useCallback((event: ReactFocusEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget;
    const noteId =
      nextTarget instanceof HTMLElement
        ? nextTarget.closest<HTMLElement>("[data-note-id]")?.dataset.noteId
        : undefined;
    setPinnedIndex(noteId ? (indexByIdRef.current.get(noteId) ?? null) : null);
  }, []);

  useLayoutEffect(() => {
    const focusId = pendingFocusIdRef.current;
    if (!focusId) return;
    const row = scrollRef.current?.querySelector<HTMLButtonElement>(
      `[data-note-id="${CSS.escape(focusId)}"] .note-row, [data-note-id="${CSS.escape(focusId)}"] .note-list-virtual-group-toggle`,
    );
    if (row) {
      pendingFocusIdRef.current = null;
      row.focus();
    }
  }, [scrollRef, visibleRows]);

  const moveTabFocus = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (
        !isVirtualized ||
        event.key !== "Tab" ||
        event.nativeEvent.isComposing ||
        event.nativeEvent.keyCode === 229
      )
        return;
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const currentId = target.closest<HTMLElement>("[data-note-id]")?.dataset.noteId;
      if (!currentId) return;
      const currentIndex = indexByIdRef.current.get(currentId);
      if (currentIndex === undefined) return;
      const direction = event.shiftKey ? -1 : 1;
      const isFocusableRow = (index: number) => {
        const row = rows[index];
        return (
          row !== undefined &&
          !(row.kind === "group" && index === topVisibleIndex && pinnedIndex !== index)
        );
      };
      let nextIndex = currentIndex + direction;
      while (nextIndex >= 0 && nextIndex < rows.length && !isFocusableRow(nextIndex))
        nextIndex += direction;
      let boundaryIndex: number | null = null;
      if (event.shiftKey) {
        for (let index = startIndex; index < endIndex; index += 1) {
          if (!isFocusableRow(index)) continue;
          boundaryIndex = index;
          break;
        }
      } else {
        for (let index = endIndex - 1; index >= startIndex; index -= 1) {
          if (!isFocusableRow(index)) continue;
          boundaryIndex = index;
          break;
        }
      }
      const focusedOutsideWindow = currentIndex < startIndex || currentIndex >= endIndex;
      if (
        (!focusedOutsideWindow && currentIndex !== boundaryIndex) ||
        nextIndex < 0 ||
        nextIndex >= rows.length
      )
        return;

      event.preventDefault();
      const container = scrollRef.current;
      if (!container) return;
      pendingFocusIdRef.current = rows[nextIndex]!.id;
      setPinnedIndex(nextIndex);
      const nextTop = offsets[nextIndex]!;
      const nextHeight = offsets[nextIndex + 1]! - nextTop;
      const targetScrollTop = event.shiftKey
        ? Math.max(0, nextTop - container.clientHeight + nextHeight + 80)
        : Math.max(0, nextTop - 80);
      container.scrollTop = targetScrollTop + contentInsetRef.current;
      setViewport({ top: targetScrollTop, height: container.clientHeight || viewport.height });
    },
    [
      endIndex,
      isVirtualized,
      offsets,
      pinnedIndex,
      rows,
      scrollRef,
      startIndex,
      topVisibleIndex,
      viewport.height,
    ],
  );

  return {
    isVirtualized,
    visibleRows,
    pinnedRowId: pinnedIndex === null ? null : (rows[pinnedIndex]?.id ?? null),
    topVisibleRow: topVisibleIndex < 0 ? undefined : rows[topVisibleIndex],
    stickyOffset: stickyGroupOffset(
      nextGroupTop,
      viewport.top - stickyHeaderHeight,
      stickyHeaderHeight,
    ),
    collapsingGroup,
    totalHeight: offsets[offsets.length - 1] ?? 0,
    rowStyle,
    getRowRef,
    scrollToRowStart,
    moveTabFocus,
    onFocusCapture,
    onBlurCapture,
  };
}
