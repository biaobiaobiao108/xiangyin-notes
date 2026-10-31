import { useLayoutEffect, useState, type RefObject } from "react";
import type { KanbanCard } from "../../shared/types";

const VIRTUALIZE_THRESHOLD = 80;
const ESTIMATED_CARD_HEIGHT = 136;
const OVERSCAN_CARDS = 8;

export type VirtualKanbanColumnResult = {
  isVirtualized: boolean;
  visibleCards: KanbanCard[];
  paddingTop: number;
  paddingBottom: number;
  startIndex: number;
};

export function useVirtualKanbanColumn(
  cards: KanbanCard[],
  scrollRef: RefObject<HTMLDivElement | null>,
): VirtualKanbanColumnResult {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(800);

  const shouldVirtualize = cards.length >= VIRTUALIZE_THRESHOLD;

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || !shouldVirtualize) return;

    const handleScroll = () => {
      setScrollTop(element.scrollTop);
      setViewportHeight(element.clientHeight || 800);
    };

    handleScroll();
    element.addEventListener("scroll", handleScroll, { passive: true });
    return () => element.removeEventListener("scroll", handleScroll);
  }, [scrollRef, shouldVirtualize]);

  if (!shouldVirtualize) {
    return {
      isVirtualized: false,
      visibleCards: cards,
      paddingTop: 0,
      paddingBottom: 0,
      startIndex: 0,
    };
  }

  const rawStartIndex = Math.floor(scrollTop / ESTIMATED_CARD_HEIGHT);
  const startIndex = Math.max(0, rawStartIndex - OVERSCAN_CARDS);
  const visibleCount = Math.ceil(viewportHeight / ESTIMATED_CARD_HEIGHT) + OVERSCAN_CARDS * 2;
  const endIndex = Math.min(cards.length, startIndex + visibleCount);

  const paddingTop = startIndex * ESTIMATED_CARD_HEIGHT;
  const paddingBottom = Math.max(0, (cards.length - endIndex) * ESTIMATED_CARD_HEIGHT);

  return {
    isVirtualized: true,
    visibleCards: cards.slice(startIndex, endIndex),
    paddingTop,
    paddingBottom,
    startIndex,
  };
}
