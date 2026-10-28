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
import type { TaskSummary } from "../../shared/types";

const VIRTUALIZE_AFTER = 140;
const ESTIMATED_TASK_HEIGHT = 52;
const OVERSCAN_PX = 640;

export type TaskVirtualRow = {
  id: string;
  groupId: string;
  kind: "group" | "task";
  firstGroup?: boolean;
  task: TaskSummary;
};

export function taskGroupRowId(groupId: string) {
  return `group:${groupId}`;
}

export function taskRowId(task: TaskSummary) {
  return `task:${task.noteId}:${task.ordinal}`;
}

export function flattenTaskGroups(
  groups: readonly (readonly TaskSummary[])[],
  collapsedGroupIds: ReadonlySet<string>,
  collapsingGroupId?: string | null,
) {
  const rows: TaskVirtualRow[] = [];
  for (const group of groups) {
    const firstTask = group[0];
    if (!firstTask) continue;
    const groupId = firstTask.noteId;
    rows.push({
      id: taskGroupRowId(groupId),
      groupId,
      kind: "group",
      firstGroup: rows.length === 0,
      task: firstTask,
    });
    if (collapsedGroupIds.has(groupId) && collapsingGroupId !== groupId) continue;
    for (const task of group) rows.push({ id: taskRowId(task), groupId, kind: "task", task });
  }
  return rows;
}

export function taskGroupRowIds(groups: readonly (readonly TaskSummary[])[]) {
  const ids = new Set<string>();
  for (const group of groups) {
    const firstTask = group[0];
    if (!firstTask) continue;
    ids.add(taskGroupRowId(firstTask.noteId));
    for (const task of group) ids.add(taskRowId(task));
  }
  return ids;
}

function estimatedHeight(row: TaskVirtualRow, groupHeaderHeight: number) {
  if (row.kind === "group") return row.firstGroup ? 0 : groupHeaderHeight;
  return ESTIMATED_TASK_HEIGHT;
}

function offsetsForRows(
  rows: readonly TaskVirtualRow[],
  heights: Map<string, number>,
  groupHeaderHeight: number,
) {
  const offsets = new Array<number>(rows.length + 1);
  offsets[0] = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    offsets[index + 1] =
      offsets[index]! +
      (row.firstGroup ? 0 : (heights.get(row.id) ?? estimatedHeight(row, groupHeaderHeight)));
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

type Viewport = { top: number; height: number };
type PendingFocus = { rowId: string; tabIndex: number };

export function useVirtualTaskList(
  rows: readonly TaskVirtualRow[],
  retainedRowIds: ReadonlySet<string>,
  scrollRef: RefObject<HTMLDivElement | null>,
  scope: string,
  taskCount: number,
) {
  const [viewport, setViewport] = useState<Viewport>({ top: 0, height: 800 });
  const [measurementRevision, setMeasurementRevision] = useState(0);
  const [groupHeaderHeight, setGroupHeaderHeight] = useState(40);
  const [pinnedRowId, setPinnedRowId] = useState<string | null>(null);
  const heightsRef = useRef(new Map<string, number>());
  const observerRef = useRef<ResizeObserver | null>(null);
  const rowElementsRef = useRef(new Map<string, HTMLLIElement>());
  const rowRefCallbacksRef = useRef(new Map<string, (element: HTMLLIElement | null) => void>());
  const rowStylesRef = useRef(new Map<number, CSSProperties>());
  const pendingFocusRef = useRef<PendingFocus | null>(null);
  const contentInsetRef = useRef(0);
  const scopeRef = useRef(scope);
  const indexById = useMemo(() => new Map(rows.map((row, index) => [row.id, index])), [rows]);
  const indexByIdRef = useRef(indexById);
  indexByIdRef.current = indexById;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const offsets = useMemo(
    () => offsetsForRows(rows, heightsRef.current, groupHeaderHeight),
    [groupHeaderHeight, measurementRevision, rows],
  );
  const offsetsRef = useRef(offsets);
  offsetsRef.current = offsets;
  const isVirtualized = taskCount > VIRTUALIZE_AFTER && typeof ResizeObserver !== "undefined";

  useLayoutEffect(() => {
    if (scopeRef.current === scope) return;
    scopeRef.current = scope;
    heightsRef.current.clear();
    rowRefCallbacksRef.current.clear();
    rowStylesRef.current.clear();
    pendingFocusRef.current = null;
    setPinnedRowId(null);
    const container = scrollRef.current;
    if (container) container.scrollTop = 0;
    setViewport((current) => ({ ...current, top: -contentInsetRef.current }));
    setMeasurementRevision((revision) => revision + 1);
  }, [scope, scrollRef]);

  useLayoutEffect(() => {
    for (const rowId of heightsRef.current.keys()) {
      if (!retainedRowIds.has(rowId)) heightsRef.current.delete(rowId);
    }
    for (const rowId of rowRefCallbacksRef.current.keys()) {
      if (retainedRowIds.has(rowId)) continue;
      const element = rowElementsRef.current.get(rowId);
      if (element) observerRef.current?.unobserve(element);
      rowElementsRef.current.delete(rowId);
      rowRefCallbacksRef.current.delete(rowId);
    }
  }, [retainedRowIds]);

  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    let scrollFrame = 0;
    const updateViewport = () => {
      const header = container.querySelector<HTMLElement>(".tasks-virtual-sticky-header");
      const inset = header?.getBoundingClientRect().height ?? 0;
      contentInsetRef.current = inset;
      if (inset > 0) {
        setGroupHeaderHeight((current) => (Math.abs(current - inset) < 0.5 ? current : inset));
      }
      setViewport((current) => {
        const next = {
          top: container.scrollTop - inset,
          height: container.clientHeight || current.height || 800,
        };
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
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateViewport);
    resizeObserver?.observe(container);
    const header = container.querySelector<HTMLElement>(".tasks-virtual-sticky-header");
    if (header) resizeObserver?.observe(header);
    container.addEventListener("scroll", onScroll, { passive: true });
    updateViewport();

    return () => {
      if (scrollFrame) cancelAnimationFrame(scrollFrame);
      container.removeEventListener("scroll", onScroll);
      resizeObserver?.disconnect();
    };
  }, [isVirtualized, scrollRef]);

  useLayoutEffect(() => {
    if (!isVirtualized) return;
    const container = scrollRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      const oldOffsets = offsetsRef.current;
      const anchorIndex = indexAtOffset(
        oldOffsets,
        Math.max(0, container.scrollTop - contentInsetRef.current),
      );
      let anchorAdjustment = 0;
      let changed = false;

      for (const entry of entries) {
        const element = entry.target as HTMLLIElement;
        const rowId = element.dataset.taskRowId;
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
        const row = rowsRef.current[index]!;
        const previousHeight =
          heightsRef.current.get(rowId) ?? estimatedHeight(row, groupHeaderHeight);
        if (Math.abs(previousHeight - nextHeight) < 0.75) continue;
        heightsRef.current.set(rowId, nextHeight);
        if (index < anchorIndex) anchorAdjustment += nextHeight - previousHeight;
        changed = true;
      }

      if (!changed) return;
      if (anchorAdjustment !== 0) {
        container.scrollTop += anchorAdjustment;
        setViewport((current) => ({
          ...current,
          top: container.scrollTop - contentInsetRef.current,
        }));
      }
      setMeasurementRevision((revision) => revision + 1);
    });
    observerRef.current = observer;
    for (const element of rowElementsRef.current.values()) observer.observe(element);
    return () => {
      observer.disconnect();
      if (observerRef.current === observer) observerRef.current = null;
    };
  }, [groupHeaderHeight, isVirtualized, scope, scrollRef]);

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
        return row ? [{ row, index, top: offsets[index]! }] : [];
      });
  }, [endIndex, indexById, offsets, pinnedRowId, rows, startIndex]);

  const getRowRef = useCallback((rowId: string) => {
    let callback = rowRefCallbacksRef.current.get(rowId);
    if (!callback) {
      callback = (element) => {
        const previous = rowElementsRef.current.get(rowId);
        if (previous && previous !== element) observerRef.current?.unobserve(previous);
        if (!element) {
          rowElementsRef.current.delete(rowId);
          return;
        }
        rowElementsRef.current.set(rowId, element);
        observerRef.current?.observe(element);
      };
      rowRefCallbacksRef.current.set(rowId, callback);
    }
    return callback;
  }, []);

  const rowStyle = useCallback(
    (top: number) => {
      if (!isVirtualized) return undefined;
      const cached = rowStylesRef.current.get(top);
      if (cached) return cached;
      const style = {
        position: "absolute",
        insetInline: 12,
        top: 0,
        transform: `translateY(${top}px)`,
      } as CSSProperties;
      if (rowStylesRef.current.size > 512) rowStylesRef.current.clear();
      rowStylesRef.current.set(top, style);
      return style;
    },
    [isVirtualized],
  );

  const scrollToRowStart = useCallback(
    (rowId: string) => {
      const index = indexByIdRef.current.get(rowId);
      const container = scrollRef.current;
      if (index === undefined || !container) return;
      const top = offsetsRef.current[index] ?? 0;
      container.scrollTop = index === 0 ? 0 : top + contentInsetRef.current;
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
    const rowId = (event.target as HTMLElement).closest<HTMLElement>("[data-task-row-id]")?.dataset
      .taskRowId;
    setPinnedRowId(rowId ?? null);
  }, []);
  const onBlurCapture = useCallback((event: ReactFocusEvent<HTMLDivElement>) => {
    const target = event.relatedTarget;
    const rowId =
      target instanceof HTMLElement
        ? target.closest<HTMLElement>("[data-task-row-id]")?.dataset.taskRowId
        : undefined;
    setPinnedRowId(rowId ?? null);
  }, []);

  useLayoutEffect(() => {
    const pendingFocus = pendingFocusRef.current;
    if (!pendingFocus) return;
    const button = scrollRef.current?.querySelector<HTMLButtonElement>(
      `[data-task-row-id="${CSS.escape(pendingFocus.rowId)}"] [data-task-tab-index="${pendingFocus.tabIndex}"]`,
    );
    if (!button) return;
    pendingFocusRef.current = null;
    button.focus({ preventScroll: true });
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
      const rowId = target.closest<HTMLElement>("[data-task-row-id]")?.dataset.taskRowId;
      const currentIndex = rowId ? indexByIdRef.current.get(rowId) : undefined;
      const currentRow = currentIndex === undefined ? undefined : rows[currentIndex];
      if (!rowId || currentIndex === undefined || currentRow?.kind !== "task") return;
      const currentTabIndex = Number(
        target.closest<HTMLElement>("[data-task-tab-index]")?.dataset.taskTabIndex,
      );
      if (!Number.isInteger(currentTabIndex)) return;
      if ((!event.shiftKey && currentTabIndex === 0) || (event.shiftKey && currentTabIndex === 1))
        return;

      const direction = event.shiftKey ? -1 : 1;
      let nextIndex = currentIndex + direction;
      while (nextIndex >= 0 && nextIndex < rows.length && rows[nextIndex]!.kind !== "task")
        nextIndex += direction;
      if (nextIndex < 0 || nextIndex >= rows.length) return;
      const nextRow = rows[nextIndex]!;
      const nextTabIndex = event.shiftKey ? 1 : 0;
      const container = scrollRef.current;
      if (!container) return;
      const nextButton = container.querySelector<HTMLButtonElement>(
        `[data-task-row-id="${CSS.escape(nextRow.id)}"] [data-task-tab-index="${nextTabIndex}"]`,
      );
      if (nextButton) return;

      event.preventDefault();
      pendingFocusRef.current = { rowId: nextRow.id, tabIndex: nextTabIndex };
      setPinnedRowId(nextRow.id);
      const nextTop = offsets[nextIndex]!;
      const nextHeight = offsets[nextIndex + 1]! - nextTop;
      const targetTop = event.shiftKey
        ? Math.max(0, nextTop - container.clientHeight + nextHeight + 80)
        : Math.max(0, nextTop - 80);
      container.scrollTop = targetTop + contentInsetRef.current;
      setViewport({ top: targetTop, height: container.clientHeight || viewport.height });
    },
    [isVirtualized, offsets, rows, scrollRef, viewport.height],
  );

  return {
    isVirtualized,
    visibleRows,
    topVisibleRow: rows.length
      ? rows[Math.min(indexAtOffset(offsets, viewport.top), rows.length - 1)]
      : undefined,
    totalHeight: offsets[offsets.length - 1] ?? 0,
    rowStyle,
    getRowRef,
    scrollToRowStart,
    onFocusCapture,
    onBlurCapture,
    moveTabFocus,
  };
}
