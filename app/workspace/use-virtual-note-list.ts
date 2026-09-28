import { useCallback, useLayoutEffect, useMemo, useRef, useState, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import type { NoteSummary } from "../../shared/types";

const VIRTUALIZE_AFTER = 140;
const ESTIMATED_ROW_HEIGHT = 120;
const OVERSCAN_PX = 720;

type Viewport = { top: number; height: number };

function offsetsForRows(rows: readonly NoteSummary[], heights: Map<string, number>) {
  const offsets = new Array<number>(rows.length + 1);
  offsets[0] = 0;
  for (let index = 0; index < rows.length; index += 1) {
    offsets[index + 1] = offsets[index] + (heights.get(rows[index]!.id) ?? ESTIMATED_ROW_HEIGHT);
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
  rows: readonly NoteSummary[],
  scrollRef: RefObject<HTMLDivElement | null>,
  scope: string,
) {
  const [viewport, setViewport] = useState<Viewport>({ top: 0, height: 800 });
  const [measurementRevision, setMeasurementRevision] = useState(0);
  const [pinnedIndex, setPinnedIndex] = useState<number | null>(null);
  const heightsRef = useRef(new Map<string, number>());
  const observerRef = useRef<ResizeObserver | null>(null);
  const rowElementsRef = useRef(new Map<string, HTMLLIElement>());
  const rowRefCallbacksRef = useRef(new Map<string, (element: HTMLLIElement | null) => void>());
  const pendingFocusIdRef = useRef<string | null>(null);
  const indexById = useMemo(() => new Map(rows.map((row, index) => [row.id, index])), [rows]);
  const indexByIdRef = useRef(indexById);
  indexByIdRef.current = indexById;
  const offsets = useMemo(() => offsetsForRows(rows, heightsRef.current), [rows, measurementRevision]);
  const offsetsRef = useRef(offsets);
  offsetsRef.current = offsets;
  const isVirtualized = rows.length > VIRTUALIZE_AFTER;

  useLayoutEffect(() => {
    heightsRef.current.clear();
    rowRefCallbacksRef.current.clear();
    setMeasurementRevision((revision) => revision + 1);
  }, [scope]);

  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    let scrollFrame = 0;
    const updateViewport = () => {
      setViewport((current) => {
        const next = { top: container.scrollTop, height: container.clientHeight || current.height || 800 };
        return current.top === next.top && current.height === next.height ? current : next;
      });
    };
    const onScroll = () => {
      if (scrollFrame) return;
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = 0;
        updateViewport();
      });
    };
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateViewport);
    resizeObserver?.observe(container);
    container.addEventListener("scroll", onScroll, { passive: true });
    updateViewport();

    return () => {
      if (scrollFrame) cancelAnimationFrame(scrollFrame);
      container.removeEventListener("scroll", onScroll);
      resizeObserver?.disconnect();
    };
  }, [scrollRef]);

  useLayoutEffect(() => {
    if (!isVirtualized || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const container = scrollRef.current;
      const oldOffsets = offsetsRef.current;
      const anchorIndex = container ? indexAtOffset(oldOffsets, container.scrollTop) : 0;
      let anchorAdjustment = 0;
      let changed = false;

      for (const entry of entries) {
        const element = entry.target as HTMLLIElement;
        const noteId = element.dataset.noteId;
        if (!noteId) continue;
        const index = indexByIdRef.current.get(noteId);
        if (index === undefined) continue;
        const borderBox = entry.borderBoxSize as unknown as ResizeObserverSize | readonly ResizeObserverSize[] | undefined;
        const measuredHeight = borderBox
          ? "blockSize" in borderBox ? borderBox.blockSize : borderBox[0]?.blockSize
          : undefined;
        const nextHeight = measuredHeight ?? element.getBoundingClientRect().height;
        if (!Number.isFinite(nextHeight) || nextHeight <= 0) continue;
        const previousHeight = heightsRef.current.get(noteId) ?? ESTIMATED_ROW_HEIGHT;
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
  }, [isVirtualized, scrollRef]);

  const startIndex = isVirtualized
    ? indexAtOffset(offsets, Math.max(0, viewport.top - OVERSCAN_PX))
    : 0;
  const endIndex = isVirtualized
    ? Math.min(rows.length, indexAtOffset(offsets, viewport.top + viewport.height + OVERSCAN_PX) + 1)
    : rows.length;
  const visibleRows = useMemo(() => {
    const indices = new Set<number>();
    for (let index = startIndex; index < endIndex; index += 1) indices.add(index);
    if (pinnedIndex !== null && pinnedIndex >= 0 && pinnedIndex < rows.length) indices.add(pinnedIndex);
    const result: Array<{ note: NoteSummary; index: number; top: number }> = [];
    for (const index of [...indices].sort((left, right) => left - right)) {
      const note = rows[index];
      if (note) result.push({ note, index, top: offsets[index]! });
    }
    return result;
  }, [endIndex, offsets, pinnedIndex, rows, startIndex]);

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

  const rowStyle = useCallback((top: number) => isVirtualized ? {
    position: "absolute" as const,
    insetInline: 0,
    top: 0,
    transform: `translateY(${top}px)`,
  } : undefined, [isVirtualized]);

  const onFocusCapture = useCallback((event: ReactFocusEvent<HTMLDivElement>) => {
    const noteId = (event.target as HTMLElement).closest<HTMLElement>("[data-note-id]")?.dataset.noteId;
    setPinnedIndex(noteId ? indexByIdRef.current.get(noteId) ?? null : null);
  }, []);
  const onBlurCapture = useCallback((event: ReactFocusEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget;
    const noteId = nextTarget instanceof HTMLElement
      ? nextTarget.closest<HTMLElement>("[data-note-id]")?.dataset.noteId
      : undefined;
    setPinnedIndex(noteId ? indexByIdRef.current.get(noteId) ?? null : null);
  }, []);

  useLayoutEffect(() => {
    const focusId = pendingFocusIdRef.current;
    if (!focusId) return;
    const row = scrollRef.current?.querySelector<HTMLButtonElement>(`[data-note-id="${CSS.escape(focusId)}"] .note-row`);
    if (row) {
      pendingFocusIdRef.current = null;
      row.focus();
    }
  }, [scrollRef, visibleRows]);

  const moveTabFocus = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!isVirtualized || event.key !== "Tab" || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const currentId = target.closest<HTMLElement>("[data-note-id]")?.dataset.noteId;
    if (!currentId) return;
    const currentIndex = indexByIdRef.current.get(currentId);
    if (currentIndex === undefined) return;
    const nextIndex = event.shiftKey ? currentIndex - 1 : currentIndex + 1;
    const boundaryIndex = event.shiftKey ? startIndex : endIndex - 1;
    const focusedOutsideWindow = currentIndex < startIndex || currentIndex >= endIndex;
    if ((!focusedOutsideWindow && currentIndex !== boundaryIndex) || nextIndex < 0 || nextIndex >= rows.length) return;

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
    container.scrollTop = targetScrollTop;
    setViewport({ top: targetScrollTop, height: container.clientHeight || viewport.height });
  }, [endIndex, isVirtualized, offsets, rows, scrollRef, startIndex, viewport.height]);

  return {
    isVirtualized,
    visibleRows,
    totalHeight: offsets[offsets.length - 1] ?? 0,
    rowStyle,
    getRowRef,
    moveTabFocus,
    onFocusCapture,
    onBlurCapture,
  };
}
