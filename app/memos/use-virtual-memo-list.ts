import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import type { Memo } from "../../shared/types";

const VIRTUALIZE_AFTER = 24;
const ESTIMATED_DAY_HEIGHT = 44;
const ESTIMATED_MEMO_HEIGHT = 160;
const OVERSCAN_PX = 720;

export function shouldVirtualizeMemoList(
  memoCount: number,
  hasResizeObserver: boolean,
  virtualizationOverride: boolean | null = null,
) {
  return hasResizeObserver && (virtualizationOverride ?? memoCount > VIRTUALIZE_AFTER);
}

export type MemoVirtualRow =
  | { id: string; kind: "day"; date: string; first: boolean }
  | { id: string; kind: "memo"; memo: Memo };

type MemoGroup = { date: string; items: Memo[] };
type Viewport = { top: number; height: number };

export function includePinnedMemo(memos: readonly Memo[], pinnedMemo: Memo | null) {
  if (!pinnedMemo || memos.some((memo) => memo.id === pinnedMemo.id)) return [...memos];
  return [...memos, pinnedMemo].sort((left, right) => right.createdAt - left.createdAt);
}

export function memoDayRowId(date: string) {
  return `day:${date}`;
}

export function memoRowId(id: string) {
  return `memo:${id}`;
}

export function flattenMemoGroups(groups: readonly MemoGroup[]) {
  const rows: MemoVirtualRow[] = [];
  for (const group of groups) {
    if (group.items.length === 0) continue;
    rows.push({
      id: memoDayRowId(group.date),
      kind: "day",
      date: group.date,
      first: rows.length === 0,
    });
    for (const memo of group.items) rows.push({ id: memoRowId(memo.id), kind: "memo", memo });
  }
  return rows;
}

function estimatedRowHeight(row: MemoVirtualRow) {
  return row.kind === "day"
    ? row.first
      ? ESTIMATED_DAY_HEIGHT - 24
      : ESTIMATED_DAY_HEIGHT
    : ESTIMATED_MEMO_HEIGHT;
}

export function memoRowOffsets(rows: readonly MemoVirtualRow[], heights: Map<string, number>) {
  const offsets = new Array<number>(rows.length + 1);
  offsets[0] = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    offsets[index + 1] = offsets[index]! + (heights.get(row.id) ?? estimatedRowHeight(row));
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

export function useVirtualMemoList(
  rows: readonly MemoVirtualRow[],
  scrollRef: RefObject<HTMLDivElement | null>,
  scope: string,
  memoCount: number,
  pinnedRowId: string | null,
  virtualizationOverride: boolean | null = null,
) {
  const [viewport, setViewport] = useState<Viewport>({ top: 0, height: 800 });
  const [measurementRevision, setMeasurementRevision] = useState(0);
  const heightsRef = useRef(new Map<string, number>());
  const elementsRef = useRef(new Map<string, HTMLElement>());
  const refCallbacksRef = useRef(new Map<string, (element: HTMLElement | null) => void>());
  const observerRef = useRef<ResizeObserver | null>(null);
  const rowStylesRef = useRef(new Map<number, CSSProperties>());
  const indexById = useMemo(() => new Map(rows.map((row, index) => [row.id, index])), [rows]);
  const indexByIdRef = useRef(indexById);
  indexByIdRef.current = indexById;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const isVirtualized = shouldVirtualizeMemoList(
    memoCount,
    typeof ResizeObserver !== "undefined",
    virtualizationOverride,
  );
  const offsets = useMemo(
    () => memoRowOffsets(rows, heightsRef.current),
    [measurementRevision, rows],
  );
  const offsetsRef = useRef(offsets);
  offsetsRef.current = offsets;

  useLayoutEffect(() => {
    heightsRef.current.clear();
    rowStylesRef.current.clear();
    const container = scrollRef.current;
    if (container) container.scrollTop = 0;
    setViewport((current) => (current.top === 0 ? current : { ...current, top: 0 }));
    setMeasurementRevision((revision) => revision + 1);
  }, [scope, scrollRef]);

  useLayoutEffect(() => {
    const presentIds = new Set(rows.map((row) => row.id));
    for (const id of heightsRef.current.keys()) {
      if (!presentIds.has(id)) heightsRef.current.delete(id);
    }
    for (const [id, element] of elementsRef.current) {
      if (presentIds.has(id)) continue;
      observerRef.current?.unobserve(element);
      elementsRef.current.delete(id);
      refCallbacksRef.current.delete(id);
    }
  }, [rows]);

  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container || !isVirtualized) return;
    let frame = 0;
    let viewportHeight = container.clientHeight || 800;
    const update = () => {
      setViewport((current) => {
        const next = { top: Math.max(0, container.scrollTop), height: viewportHeight };
        return current.top === next.top && current.height === next.height ? current : next;
      });
    };
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        update();
      });
    };
    const onResize = () => {
      viewportHeight = container.clientHeight || viewportHeight;
      update();
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(onResize);
    observer?.observe(container);
    container.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize, { passive: true });
    onResize();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect();
      container.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
    };
  }, [isVirtualized, scope, scrollRef]);

  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container || !isVirtualized || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const anchorIndex = indexAtOffset(offsetsRef.current, container.scrollTop);
      let anchorAdjustment = 0;
      let changed = false;
      for (const entry of entries) {
        const element = entry.target as HTMLElement;
        const rowId = element.dataset.memoRowId;
        if (!rowId) continue;
        const index = indexByIdRef.current.get(rowId);
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
          heightsRef.current.get(rowId) ?? estimatedRowHeight(rowsRef.current[index]!);
        if (Math.abs(previousHeight - nextHeight) < 0.75) continue;
        heightsRef.current.set(rowId, nextHeight);
        if (index < anchorIndex) anchorAdjustment += nextHeight - previousHeight;
        changed = true;
      }
      if (!changed) return;
      if (anchorAdjustment !== 0) container.scrollTop += anchorAdjustment;
      setMeasurementRevision((revision) => revision + 1);
    });
    observerRef.current = observer;
    for (const element of elementsRef.current.values()) observer.observe(element);
    return () => {
      observer.disconnect();
      if (observerRef.current === observer) observerRef.current = null;
    };
  }, [isVirtualized, scope, scrollRef]);

  const getRowRef = useCallback((rowId: string) => {
    let callback = refCallbacksRef.current.get(rowId);
    if (!callback) {
      callback = (element) => {
        const previous = elementsRef.current.get(rowId);
        if (previous && previous !== element) observerRef.current?.unobserve(previous);
        if (!element) {
          elementsRef.current.delete(rowId);
          return;
        }
        elementsRef.current.set(rowId, element);
        observerRef.current?.observe(element);
      };
      refCallbacksRef.current.set(rowId, callback);
    }
    return callback;
  }, []);

  const rowStyle = useCallback(
    (top: number) => {
      if (!isVirtualized) return undefined;
      const cached = rowStylesRef.current.get(top);
      if (cached) return cached;
      const style: CSSProperties = {
        position: "absolute",
        insetInline: 0,
        top: 0,
        transform: `translateY(${top}px)`,
      };
      if (rowStylesRef.current.size > 512) rowStylesRef.current.clear();
      rowStylesRef.current.set(top, style);
      return style;
    },
    [isVirtualized],
  );

  const startIndex = isVirtualized
    ? indexAtOffset(offsets, Math.max(0, viewport.top - OVERSCAN_PX))
    : 0;
  const endIndex = isVirtualized
    ? Math.min(
        rows.length,
        indexAtOffset(offsets, viewport.top + viewport.height + OVERSCAN_PX) + 1,
      )
    : rows.length;
  const visibleRows = useMemo(() => {
    const indices = new Set<number>();
    for (let index = startIndex; index < endIndex; index += 1) indices.add(index);
    const pinnedIndex = pinnedRowId ? indexById.get(pinnedRowId) : undefined;
    if (pinnedIndex !== undefined) indices.add(pinnedIndex);
    return [...indices]
      .sort((left, right) => left - right)
      .flatMap((index) => {
        const row = rows[index];
        return row ? [{ row, top: offsets[index]!, index }] : [];
      });
  }, [endIndex, indexById, isVirtualized, offsets, pinnedRowId, rows, startIndex]);

  return {
    isVirtualized,
    visibleRows,
    totalHeight: offsets[offsets.length - 1] ?? 0,
    rowStyle,
    getRowRef,
  };
}
