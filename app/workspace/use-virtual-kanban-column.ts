import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import type { KanbanCard } from "../../shared/types";

export const VIRTUALIZE_KANBAN_AFTER = 80;
const ESTIMATED_CARD_HEIGHT = 136;
const CARD_GAP = 10;
const OVERSCAN_PX = 600;
const INDICATOR_OFFSET = 6;

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
  visibleCards: Array<{ card: KanbanCard; index: number; top: number }>;
  totalHeight: number;
  startIndex: number;
  endIndex: number;
  setListRef: (element: HTMLDivElement | null) => void;
  getCardRef: (noteId: string) => (element: HTMLDivElement | null) => void;
  rowStyle: (top: number) => CSSProperties | undefined;
  focusCard: (index: number) => boolean;
  indicatorTop: (index: number) => number;
};

export function useVirtualKanbanColumn(
  cards: readonly KanbanCard[],
  scrollRef: RefObject<HTMLDivElement | null>,
  scrollElement: HTMLDivElement | null,
): VirtualKanbanColumnResult {
  const [viewport, setViewport] = useState({ top: 0, height: 800 });
  const [measurementRevision, setMeasurementRevision] = useState(0);
  const [focusRevision, setFocusRevision] = useState(0);
  const heightsRef = useRef(new Map<string, number>());
  const elementsRef = useRef(new Map<string, HTMLDivElement>());
  const refCallbacksRef = useRef(new Map<string, (element: HTMLDivElement | null) => void>());
  const observerRef = useRef<ResizeObserver | null>(null);
  const listElementRef = useRef<HTMLDivElement | null>(null);
  const pendingFocusRef = useRef<number | null>(null);
  const cardIndexById = useMemo(
    () => new Map(cards.map((card, index) => [card.noteId, index])),
    [cards],
  );
  const cardIndexByIdRef = useRef(cardIndexById);
  cardIndexByIdRef.current = cardIndexById;
  const isVirtualized =
    cards.length >= VIRTUALIZE_KANBAN_AFTER && typeof ResizeObserver !== "undefined";

  const offsets = useMemo(
    () => kanbanCardOffsets(cards, heightsRef.current),
    [cards, measurementRevision],
  );
  const totalHeight = useMemo(
    () => kanbanTotalHeight(cards, offsets, heightsRef.current),
    [cards, measurementRevision, offsets],
  );
  const offsetsRef = useRef(offsets);
  offsetsRef.current = offsets;
  const setListRef = useCallback((element: HTMLDivElement | null) => {
    listElementRef.current = element;
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
    const container = scrollElement;
    if (!container || !isVirtualized) return;

    let frame = 0;
    const update = () => {
      const list = listElementRef.current;
      const top = list
        ? Math.max(0, container.getBoundingClientRect().top - list.getBoundingClientRect().top)
        : Math.max(0, container.scrollTop);
      setViewport((current) => {
        const next = { top, height: container.clientHeight || 800 };
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
    resizeObserver?.observe(container);
    container.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", update, { passive: true });
    update();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      container.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", update);
    };
  }, [isVirtualized, scrollElement]);

  useLayoutEffect(() => {
    if (!scrollElement || !isVirtualized || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const container = scrollElement;
      const list = listElementRef.current;
      const viewportTop = list
        ? Math.max(0, container.getBoundingClientRect().top - list.getBoundingClientRect().top)
        : container.scrollTop;
      const anchorIndex = indexAtOffset(offsetsRef.current, viewportTop);
      let anchorAdjustment = 0;
      let changed = false;
      for (const entry of entries) {
        const element = entry.target as HTMLDivElement;
        const noteId = element.dataset.kanbanVirtualId;
        if (!noteId) continue;
        const index = cardIndexByIdRef.current.get(noteId);
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
        const previousHeight = heightsRef.current.get(noteId) ?? ESTIMATED_CARD_HEIGHT;
        if (Math.abs(previousHeight - nextHeight) < 0.5) continue;
        heightsRef.current.set(noteId, nextHeight);
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
  }, [isVirtualized, scrollElement]);

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

  const startIndex = isVirtualized
    ? indexAtOffset(offsets, Math.max(0, viewport.top - OVERSCAN_PX))
    : 0;
  const endIndex = isVirtualized
    ? Math.min(
        cards.length,
        indexAtOffset(offsets, viewport.top + viewport.height + OVERSCAN_PX) + 1,
      )
    : cards.length;
  const visibleCards = useMemo(() => {
    if (!isVirtualized) return cards.map((card, index) => ({ card, index, top: 0 }));
    const result: Array<{ card: KanbanCard; index: number; top: number }> = [];
    for (let index = startIndex; index < endIndex; index += 1) {
      const card = cards[index];
      if (card) result.push({ card, index, top: offsets[index]! });
    }
    return result;
  }, [cards, endIndex, isVirtualized, offsets, startIndex]);

  const focusCard = useCallback(
    (index: number) => {
      if (!isVirtualized) return false;
      const container = scrollRef.current;
      const card = cards[index];
      if (!container || !card) return false;
      pendingFocusRef.current = index;
      const top = offsetsRef.current[index] ?? 0;
      const height = heightsRef.current.get(card.noteId) ?? ESTIMATED_CARD_HEIGHT;
      const list = listElementRef.current;
      const viewportTop = list
        ? Math.max(0, container.getBoundingClientRect().top - list.getBoundingClientRect().top)
        : container.scrollTop;
      const viewportBottom = viewportTop + container.clientHeight;
      if (top < viewportTop || top + height > viewportBottom) {
        container.scrollTop = Math.max(0, container.scrollTop + top - viewportTop - 16);
      }
      setViewport({ top: Math.max(0, top - 16), height: container.clientHeight || 800 });
      setFocusRevision((revision) => revision + 1);
      return true;
    },
    [cards, isVirtualized, scrollRef],
  );

  useLayoutEffect(() => {
    const index = pendingFocusRef.current;
    if (index === null) return;
    const card = cards[index];
    if (!card) {
      pendingFocusRef.current = null;
      return;
    }
    const element = elementsRef.current.get(card.noteId);
    if (!element) return;
    element.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
    pendingFocusRef.current = null;
  }, [cards, focusRevision, visibleCards]);

  const rowStyle = useCallback(
    (top: number) => (isVirtualized ? { transform: `translateY(${top}px)` } : undefined),
    [isVirtualized],
  );
  const indicatorTop = useCallback(
    (index: number) => {
      const top = index >= cards.length ? totalHeight : (offsets[index] ?? totalHeight);
      return Math.max(0, top - INDICATOR_OFFSET);
    },
    [cards.length, offsets, totalHeight],
  );

  return {
    isVirtualized,
    visibleCards,
    totalHeight,
    startIndex,
    endIndex,
    setListRef,
    getCardRef,
    rowStyle,
    focusCard,
    indicatorTop,
  };
}
