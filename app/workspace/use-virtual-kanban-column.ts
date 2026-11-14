import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { KanbanCard } from "../../shared/types";

export const VIRTUALIZE_KANBAN_AFTER = 80;
const ESTIMATED_CARD_HEIGHT = 136;
const CARD_GAP = 10;
const OVERSCAN_PX = 600;

export function kanbanCardOffsets(
  cards: readonly KanbanCard[],
  heights: ReadonlyMap<string, number>,
) {
  const offsets = new Array<number>(cards.length);
  let top = 0;
  for (let index = 0; index < cards.length; index += 1) {
    offsets[index] = top;
    top += (heights.get(cards[index]!.noteId) ?? ESTIMATED_CARD_HEIGHT) + CARD_GAP;
  }
  return offsets;
}

export function kanbanTotalHeight(
  cards: readonly KanbanCard[],
  offsets: readonly number[],
  heights: ReadonlyMap<string, number>,
) {
  const lastIndex = cards.length - 1;
  if (lastIndex < 0) return 0;
  const last = cards[lastIndex]!;
  return offsets[lastIndex]! + (heights.get(last.noteId) ?? ESTIMATED_CARD_HEIGHT);
}

function indexAtOffset(offsets: readonly number[], offset: number) {
  const count = offsets.length;
  let low = 0;
  let high = count;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (offsets[middle]! <= offset) low = middle + 1;
    else high = middle;
  }
  return Math.min(Math.max(0, low - 1), Math.max(0, count - 1));
}

export type VirtualKanbanColumnResult = {
  isVirtualized: boolean;
  visibleCards: KanbanCard[];
  paddingTop: number;
  paddingBottom: number;
  startIndex: number;
  getCardRef: (noteId: string) => (element: HTMLElement | null) => void;
};

export function useVirtualKanbanColumn(
  cards: readonly KanbanCard[],
  scrollRef: RefObject<HTMLDivElement | null>,
): VirtualKanbanColumnResult {
  const [viewport, setViewport] = useState({ top: 0, height: 800 });
  const [measurementRevision, setMeasurementRevision] = useState(0);
  const heightsRef = useRef(new Map<string, number>());
  const elementsRef = useRef(new Map<string, HTMLElement>());
  const refCallbacksRef = useRef(new Map<string, (element: HTMLElement | null) => void>());
  const observerRef = useRef<ResizeObserver | null>(null);
  const isVirtualized =
    cards.length >= VIRTUALIZE_KANBAN_AFTER && typeof ResizeObserver !== "undefined";

  const offsets = useMemo(
    () => kanbanCardOffsets(cards, heightsRef.current),
    [cards, measurementRevision],
  );
  const totalHeight = useMemo(
    () => kanbanTotalHeight(cards, offsets, heightsRef.current),
    [cards, offsets],
  );

  const getCardRef = useCallback((noteId: string) => {
    let callback = refCallbacksRef.current.get(noteId);
    if (!callback) {
      callback = (element) => {
        const previous = elementsRef.current.get(noteId);
        if (previous && previous !== element) observerRef.current?.unobserve(previous);
        if (!element) {
          elementsRef.current.delete(noteId);
          return;
        }
        elementsRef.current.set(noteId, element);
        observerRef.current?.observe(element);
      };
      refCallbacksRef.current.set(noteId, callback);
    }
    return callback;
  }, []);

  useLayoutEffect(() => {
    const presentIds = new Set(cards.map((card) => card.noteId));
    for (const noteId of heightsRef.current.keys()) {
      if (!presentIds.has(noteId)) heightsRef.current.delete(noteId);
    }
    for (const [noteId, element] of elementsRef.current) {
      if (presentIds.has(noteId)) continue;
      observerRef.current?.unobserve(element);
      elementsRef.current.delete(noteId);
      refCallbacksRef.current.delete(noteId);
    }
  }, [cards]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || !isVirtualized) return;

    let frame = 0;
    const update = () => {
      setViewport((current) => {
        const next = { top: element.scrollTop, height: element.clientHeight || 800 };
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
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    resizeObserver?.observe(element);
    element.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", update, { passive: true });
    update();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      element.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", update);
    };
  }, [isVirtualized, scrollRef]);

  useLayoutEffect(() => {
    if (!isVirtualized || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const element = entry.target as HTMLElement;
        const noteId = element.dataset.kanbanNoteId;
        if (!noteId) continue;
        const borderBox = entry.borderBoxSize as unknown as
          ResizeObserverSize | readonly ResizeObserverSize[] | undefined;
        const measuredHeight = borderBox
          ? "blockSize" in borderBox
            ? borderBox.blockSize
            : borderBox[0]?.blockSize
          : undefined;
        const nextHeight = measuredHeight ?? element.getBoundingClientRect().height;
        if (!Number.isFinite(nextHeight) || nextHeight <= 0) continue;
        const previousHeight = heightsRef.current.get(noteId) ?? ESTIMATED_CARD_HEIGHT;
        if (Math.abs(previousHeight - nextHeight) < 0.5) continue;
        heightsRef.current.set(noteId, nextHeight);
        changed = true;
      }
      if (changed) setMeasurementRevision((revision) => revision + 1);
    });
    observerRef.current = observer;
    for (const element of elementsRef.current.values()) observer.observe(element);
    return () => {
      observer.disconnect();
      if (observerRef.current === observer) observerRef.current = null;
    };
  }, [isVirtualized]);

  const startIndex = isVirtualized
    ? indexAtOffset(offsets, Math.max(0, viewport.top - OVERSCAN_PX))
    : 0;
  const endIndex = isVirtualized
    ? Math.min(
        cards.length,
        indexAtOffset(offsets, viewport.top + viewport.height + OVERSCAN_PX) + 1,
      )
    : cards.length;
  const paddingTop = isVirtualized ? (offsets[startIndex] ?? 0) : 0;
  const paddingBottom =
    isVirtualized && endIndex < cards.length
      ? Math.max(0, totalHeight - (offsets[endIndex] ?? totalHeight) + CARD_GAP)
      : 0;

  return {
    isVirtualized,
    visibleCards: cards.slice(startIndex, endIndex),
    paddingTop,
    paddingBottom,
    startIndex,
    getCardRef,
  };
}
