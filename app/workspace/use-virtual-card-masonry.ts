import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type RefCallback, type RefObject } from "react";
import type { NoteSummary } from "../../shared/types";
import {
  assignCardMasonryLanes,
  cardLaneConfig,
  positionCardMasonryLanes,
  visibleCardIndexes,
  type CardMasonryPlacement,
  type MeasuredCardHeight,
} from "./card-masonry";

const CARD_OVERSCAN_PX = 900;
const TAB_STOP_SELECTOR = "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

type ViewportMetrics = {
  scrollTop: number;
  paddingTop: number;
  visibleHeight: number;
  contentWidth: number;
  viewportWidth: number;
};

type ScrollAnchor = { noteId: string; top: number };
type PendingFocus = { noteId: string; backwards: boolean };

function initialViewport(isMobileViewport: boolean): ViewportMetrics {
  const viewportWidth = typeof window === "undefined" ? 1024 : window.innerWidth;
  return {
    scrollTop: 0,
    paddingTop: isMobileViewport ? 76 : 28,
    visibleHeight: typeof window === "undefined" ? 800 : window.innerHeight,
    contentWidth: Math.max(1, viewportWidth - (isMobileViewport ? 28 : 64)),
    viewportWidth,
  };
}

function readMetrics(element: HTMLDivElement): ViewportMetrics {
  const styles = getComputedStyle(element);
  const paddingTop = Number.parseFloat(styles.paddingTop) || 0;
  const paddingBottom = Number.parseFloat(styles.paddingBottom) || 0;
  const paddingLeft = Number.parseFloat(styles.paddingLeft) || 0;
  const paddingRight = Number.parseFloat(styles.paddingRight) || 0;
  const viewportWidth = typeof window === "undefined" ? element.clientWidth : window.innerWidth;
  return {
    scrollTop: element.scrollTop,
    paddingTop,
    visibleHeight: Math.max(0, element.clientHeight - paddingTop - paddingBottom),
    contentWidth: Math.max(1, element.clientWidth - paddingLeft - paddingRight),
    viewportWidth,
  };
}

export function useVirtualCardMasonry(
  notes: NoteSummary[],
  scrollRootRef: RefObject<HTMLDivElement | null>,
  isMobileViewport: boolean,
) {
  const [viewport, setViewport] = useState(() => initialViewport(isMobileViewport));
  const [measurementRevision, setMeasurementRevision] = useState(0);
  const [focusedNoteId, setFocusedNoteId] = useState<string | null>(null);
  const [focusRevision, setFocusRevision] = useState(0);
  const viewportRef = useRef(viewport);
  const measuredHeightsRef = useRef(new Map<string, MeasuredCardHeight>());
  const cardNodesRef = useRef(new Map<string, HTMLDivElement>());
  const cardRefCallbacksRef = useRef(new Map<string, RefCallback<HTMLDivElement>>());
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const pendingMeasurementsRef = useRef(new Map<string, number>());
  const measurementFrameRef = useRef(0);
  const viewportFrameRef = useRef(0);
  const scrollAnchorRef = useRef<ScrollAnchor | null>(null);
  const pendingFocusRef = useRef<PendingFocus | null>(null);

  const config = useMemo(() => cardLaneConfig(viewport.contentWidth, viewport.viewportWidth, isMobileViewport), [isMobileViewport, viewport.contentWidth, viewport.viewportWidth]);
  const widthKey = Math.round(config.laneWidth);
  const assignments = useMemo(() => assignCardMasonryLanes(notes, config, isMobileViewport), [config, isMobileViewport, notes]);
  const lanes = useMemo(() => positionCardMasonryLanes(assignments, measuredHeightsRef.current, widthKey, config.gap), [assignments, config.gap, measurementRevision, widthKey]);
  const placements = useMemo(() => {
    const result = new Array<CardMasonryPlacement>(notes.length);
    for (const lane of lanes) for (const card of lane.cards) result[card.index] = card;
    return result;
  }, [lanes, notes.length]);
  const indexById = useMemo(() => new Map(notes.map((note, index) => [note.id, index])), [notes]);
  const virtualizationSupported = typeof ResizeObserver !== "undefined";

  const visibleIndexes = useMemo(() => {
    if (!virtualizationSupported) return new Set(notes.map((_, index) => index));
    const top = Math.max(0, viewport.scrollTop - viewport.paddingTop - CARD_OVERSCAN_PX);
    const bottom = viewport.scrollTop - viewport.paddingTop + viewport.visibleHeight + CARD_OVERSCAN_PX;
    const result = visibleCardIndexes(lanes, top, bottom);
    const focusedIndex = focusedNoteId ? indexById.get(focusedNoteId) : undefined;
    if (focusedIndex !== undefined) result.add(focusedIndex);
    return result;
  }, [focusedNoteId, indexById, lanes, notes, viewport.paddingTop, viewport.scrollTop, viewport.visibleHeight, virtualizationSupported]);

  const visibleCards = useMemo(() => [...visibleIndexes]
    .sort((left, right) => left - right)
    .map((index) => placements[index])
    .filter((placement): placement is CardMasonryPlacement => Boolean(placement)), [placements, visibleIndexes]);
  const totalHeight = Math.max(0, ...lanes.map((lane) => lane.height));

  const captureScrollAnchor = useCallback(() => {
    const root = scrollRootRef.current;
    if (!root) return null;
    const rootRect = root.getBoundingClientRect();
    let anchor: ScrollAnchor | null = null;
    let anchorTop = Number.POSITIVE_INFINITY;
    for (const [noteId, element] of cardNodesRef.current) {
      const rect = element.getBoundingClientRect();
      if (rect.bottom <= rootRect.top || rect.top >= rootRect.bottom) continue;
      if (rect.top < anchorTop) {
        anchor = { noteId, top: rect.top };
        anchorTop = rect.top;
      }
    }
    return anchor;
  }, [scrollRootRef]);

  const applyViewport = useCallback((next: ViewportMetrics) => {
    const current = viewportRef.current;
    const widthChanged = Math.abs(current.contentWidth - next.contentWidth) >= 1 || current.viewportWidth !== next.viewportWidth;
    if (widthChanged) scrollAnchorRef.current ??= captureScrollAnchor();
    if (Math.abs(current.scrollTop - next.scrollTop) < 1
      && Math.abs(current.paddingTop - next.paddingTop) < 1
      && Math.abs(current.visibleHeight - next.visibleHeight) < 1
      && Math.abs(current.contentWidth - next.contentWidth) < 1
      && current.viewportWidth === next.viewportWidth) return;
    viewportRef.current = next;
    setViewport(next);
  }, [captureScrollAnchor]);

  const refreshViewport = useCallback(() => {
    const root = scrollRootRef.current;
    if (!root) return;
    applyViewport(readMetrics(root));
  }, [applyViewport, scrollRootRef]);

  const scheduleViewportRefresh = useCallback(() => {
    if (viewportFrameRef.current) return;
    viewportFrameRef.current = requestAnimationFrame(() => {
      viewportFrameRef.current = 0;
      refreshViewport();
    });
  }, [refreshViewport]);

  useEffect(() => {
    const root = scrollRootRef.current;
    if (!root) return;
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === root) {
          scheduleViewportRefresh();
          continue;
        }
        const noteId = (entry.target as HTMLElement).dataset.cardMasonryNoteId;
        if (!noteId) continue;
        const borderBox = entry.borderBoxSize as unknown as ResizeObserverSize | readonly ResizeObserverSize[] | undefined;
        const borderBoxBlockSize = Array.isArray(borderBox)
          ? borderBox[0]?.blockSize
          : (borderBox as ResizeObserverSize | undefined)?.blockSize;
        const height = typeof borderBoxBlockSize === "number" && borderBoxBlockSize > 0
          ? borderBoxBlockSize
          : (entry.target as HTMLElement).getBoundingClientRect().height;
        if (!height || !Number.isFinite(height)) continue;
        const previous = measuredHeightsRef.current.get(noteId);
        if (previous?.widthKey === widthKey && Math.abs(previous.height - height) < 0.75) continue;
        pendingMeasurementsRef.current.set(noteId, height);
      }

      if (!pendingMeasurementsRef.current.size || measurementFrameRef.current) return;
      measurementFrameRef.current = requestAnimationFrame(() => {
        measurementFrameRef.current = 0;
        if (!pendingMeasurementsRef.current.size) return;
        scrollAnchorRef.current ??= captureScrollAnchor();
        for (const [noteId, height] of pendingMeasurementsRef.current) measuredHeightsRef.current.set(noteId, { widthKey, height });
        pendingMeasurementsRef.current.clear();
        setMeasurementRevision((revision) => revision + 1);
      });
    });
    resizeObserverRef.current = resizeObserver;
    resizeObserver?.observe(root);
    for (const node of cardNodesRef.current.values()) resizeObserver?.observe(node);
    root.addEventListener("scroll", scheduleViewportRefresh, { passive: true });
    window.addEventListener("resize", scheduleViewportRefresh, { passive: true });
    refreshViewport();
    return () => {
      root.removeEventListener("scroll", scheduleViewportRefresh);
      window.removeEventListener("resize", scheduleViewportRefresh);
      resizeObserver?.disconnect();
      if (resizeObserverRef.current === resizeObserver) resizeObserverRef.current = null;
      if (measurementFrameRef.current) cancelAnimationFrame(measurementFrameRef.current);
      if (viewportFrameRef.current) cancelAnimationFrame(viewportFrameRef.current);
      measurementFrameRef.current = 0;
      viewportFrameRef.current = 0;
    };
  }, [captureScrollAnchor, isMobileViewport, refreshViewport, scheduleViewportRefresh, widthKey]);

  const getCardRef = useCallback((noteId: string): RefCallback<HTMLDivElement> => {
    const cached = cardRefCallbacksRef.current.get(noteId);
    if (cached) return cached;
    const callback: RefCallback<HTMLDivElement> = (element) => {
      const previous = cardNodesRef.current.get(noteId);
      if (element) {
        if (previous !== element) {
          cardNodesRef.current.set(noteId, element);
          resizeObserverRef.current?.observe(element);
        }
      } else if (previous) {
        resizeObserverRef.current?.unobserve(previous);
        cardNodesRef.current.delete(noteId);
        cardRefCallbacksRef.current.delete(noteId);
      }
    };
    cardRefCallbacksRef.current.set(noteId, callback);
    return callback;
  }, []);

  const onFocusCapture = useCallback((event: ReactFocusEvent<HTMLDivElement>) => {
    const slot = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-card-masonry-note-id]") : null;
    setFocusedNoteId(slot?.dataset.cardMasonryNoteId ?? null);
  }, []);

  const onBlurCapture = useCallback((event: ReactFocusEvent<HTMLDivElement>) => {
    const slot = event.relatedTarget instanceof Element ? event.relatedTarget.closest<HTMLElement>("[data-card-masonry-note-id]") : null;
    setFocusedNoteId(slot?.dataset.cardMasonryNoteId ?? null);
  }, []);

  const focusCardAtIndex = useCallback((index: number, backwards = false) => {
    const placement = placements[index];
    const root = scrollRootRef.current;
    if (!placement || !root) return;
    pendingFocusRef.current = { noteId: placement.note.id, backwards };
    const paddingTop = viewportRef.current.paddingTop;
    const margin = Math.max(0, Math.min(CARD_OVERSCAN_PX / 2, viewportRef.current.visibleHeight / 2));
    root.scrollTop = Math.max(0, placement.top + paddingTop - margin);
    refreshViewport();
    setFocusRevision((revision) => revision + 1);
  }, [placements, refreshViewport, scrollRootRef]);

  const onKeyDownCapture = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab" || !(event.target instanceof Element)) return;
    const slot = event.target.closest<HTMLElement>("[data-card-masonry-note-id]");
    const noteId = slot?.dataset.cardMasonryNoteId;
    if (!noteId) return;
    const currentIndex = indexById.get(noteId);
    if (currentIndex === undefined) return;
    const article = slot.querySelector<HTMLElement>(".note-card");
    if (!article) return;
    const tabStops = [
      ...(article.tabIndex >= 0 ? [article] : []),
      ...Array.from(article.querySelectorAll<HTMLElement>(TAB_STOP_SELECTOR)).filter((element) => element.tabIndex >= 0 && !element.closest("[inert]")),
    ];
    const targetIndex = tabStops.indexOf(event.target as HTMLElement);
    const crossesCardBoundary = event.shiftKey ? targetIndex === 0 : targetIndex === tabStops.length - 1;
    if (!crossesCardBoundary) return;
    const nextIndex = currentIndex + (event.shiftKey ? -1 : 1);
    if (nextIndex < 0 || nextIndex >= notes.length || cardNodesRef.current.has(notes[nextIndex].id)) return;
    event.preventDefault();
    focusCardAtIndex(nextIndex, event.shiftKey);
  }, [focusCardAtIndex, indexById, notes]);

  useLayoutEffect(() => {
    const anchor = scrollAnchorRef.current;
    if (anchor) {
      const root = scrollRootRef.current;
      const element = cardNodesRef.current.get(anchor.noteId);
      if (root && element) {
        const delta = element.getBoundingClientRect().top - anchor.top;
        if (Math.abs(delta) > 0.5 && (root.scrollTop > 1 || delta < 0)) root.scrollTop += delta;
      }
      scrollAnchorRef.current = null;
    }

    const pendingFocus = pendingFocusRef.current;
    if (!pendingFocus || !visibleIndexes.has(indexById.get(pendingFocus.noteId) ?? -1)) return;
    const slot = cardNodesRef.current.get(pendingFocus.noteId);
    const article = slot?.querySelector<HTMLElement>(".note-card");
    if (!article) return;
    const tabStops = [
      ...(article.tabIndex >= 0 ? [article] : []),
      ...Array.from(article.querySelectorAll<HTMLElement>(TAB_STOP_SELECTOR)).filter((element) => element.tabIndex >= 0 && !element.closest("[inert]")),
    ];
    const target = pendingFocus.backwards ? tabStops.at(-1) : tabStops[0];
    target?.focus({ preventScroll: true });
    pendingFocusRef.current = null;
  }, [focusRevision, indexById, lanes, scrollRootRef, visibleIndexes]);

  useLayoutEffect(() => {
    for (const noteId of measuredHeightsRef.current.keys()) {
      if (!indexById.has(noteId)) measuredHeightsRef.current.delete(noteId);
    }
  }, [indexById]);

  return {
    config,
    widthKey,
    totalHeight,
    visibleCards,
    getCardRef,
    refreshViewport,
    focusCardAtIndex,
    onFocusCapture,
    onBlurCapture,
    onKeyDownCapture,
  };
}
