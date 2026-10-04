import type { NoteSummary } from "../../shared/types";

export type CardLaneConfig = {
  width: number;
  laneWidth: number;
  laneCount: number;
  gap: number;
};

export type CardMasonryAssignment = {
  note: NoteSummary;
  index: number;
  estimatedHeight: number;
};

export type CardMasonryPlacement = CardMasonryAssignment & {
  lane: number;
  top: number;
  height: number;
};

export type CardMasonryLane = {
  cards: CardMasonryPlacement[];
  height: number;
};

export type MeasuredCardHeight = {
  widthKey: number;
  height: number;
};

const DESKTOP_MIN_LANE_WIDTH = 280;
const DESKTOP_MAX_LANES = 3;
const MAX_ESTIMATED_TITLE_LINES = 3;

export function cardLaneConfig(contentWidth: number, viewportWidth: number, isMobileViewport: boolean): CardLaneConfig {
  const width = Math.max(0, Math.min(1240, contentWidth));
  const gap = isMobileViewport ? 12 : 18;
  let laneCount: number;
  if (isMobileViewport) {
    laneCount = viewportWidth <= 359 ? 1 : viewportWidth >= 600 ? 3 : 2;
  } else {
    laneCount = Math.max(1, Math.min(DESKTOP_MAX_LANES, Math.floor((width + gap) / (DESKTOP_MIN_LANE_WIDTH + gap))));
  }
  const laneWidth = laneCount > 0 ? Math.max(1, (width - gap * (laneCount - 1)) / laneCount) : width;
  return { width, laneWidth, laneCount, gap };
}

function visualLength(value: string) {
  let length = 0;
  for (const character of value) length += /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff]/u.test(character) ? 1 : 0.55;
  return length;
}

function estimateLines(value: string, width: number, fontSize: number, maxLines: number) {
  if (!value) return 1;
  const charactersPerLine = Math.max(8, width / (fontSize * 0.56));
  const lines = value.split(/\r?\n/u).reduce((sum, line) => sum + Math.max(1, Math.ceil(visualLength(line) / charactersPerLine)), 0);
  return Math.min(maxLines, lines);
}

export function estimateCardHeight(note: NoteSummary, laneWidth: number, isMobileViewport: boolean) {
  const horizontalPadding = isMobileViewport ? 24 : 44;
  const width = Math.max(1, laneWidth - horizontalPadding);
  const titleLines = estimateLines(note.title || "未命名笔记", width, isMobileViewport ? 16 : 17, MAX_ESTIMATED_TITLE_LINES);
  const previewLines = estimateLines(note.preview, width, isMobileViewport ? 13 : 14, isMobileViewport ? 6 : 10);
  const coverHeight = note.thumbnail ? isMobileViewport ? 116 : 140 : 0;
  const titleHeight = titleLines * (isMobileViewport ? 23 : 24);
  const previewHeight = previewLines * (isMobileViewport ? 22 : 24);
  const footerHeight = isMobileViewport ? 42 + (note.tags.length > 3 ? 22 : 0) : 34;
  const bodyPadding = isMobileViewport ? 26 : 38;
  const bodyGaps = isMobileViewport ? 20 : 24;
  return Math.ceil(coverHeight + titleHeight + previewHeight + footerHeight + bodyPadding + bodyGaps + 4);
}

/** Assign lanes from stable estimates; later DOM measurements refine positions without moving cards between lanes. */
export function assignCardMasonryLanes(notes: NoteSummary[], config: CardLaneConfig, isMobileViewport: boolean) {
  const lanes: CardMasonryAssignment[][] = Array.from({ length: config.laneCount }, () => []);
  const laneHeights = Array.from({ length: config.laneCount }, () => 0);
  notes.forEach((note, index) => {
    let laneIndex = 0;
    for (let candidate = 1; candidate < laneHeights.length; candidate += 1) {
      if (laneHeights[candidate] < laneHeights[laneIndex]) laneIndex = candidate;
    }
    const estimatedHeight = estimateCardHeight(note, config.laneWidth, isMobileViewport);
    lanes[laneIndex].push({ note, index, estimatedHeight });
    laneHeights[laneIndex] += estimatedHeight + config.gap;
  });
  return lanes;
}

export function positionCardMasonryLanes(
  assignments: CardMasonryAssignment[][],
  measuredHeights: ReadonlyMap<string, MeasuredCardHeight>,
  widthKey: number,
  gap: number,
) {
  return assignments.map((assignmentsInLane, lane): CardMasonryLane => {
    let top = 0;
    const cards = assignmentsInLane.map((assignment) => {
      const measured = measuredHeights.get(assignment.note.id);
      const height = measured?.widthKey === widthKey ? measured.height : assignment.estimatedHeight;
      const card = { ...assignment, lane, top, height };
      top += height + gap;
      return card;
    });
    return { cards, height: Math.max(0, top - (cards.length ? gap : 0)) };
  });
}

function firstCardEndingAfter(cards: CardMasonryPlacement[], top: number) {
  let low = 0;
  let high = cards.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (cards[middle].top + cards[middle].height < top) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function visibleCardIndexes(lanes: CardMasonryLane[], top: number, bottom: number) {
  const visible = new Set<number>();
  for (const lane of lanes) {
    for (let index = firstCardEndingAfter(lane.cards, top); index < lane.cards.length; index += 1) {
      const card = lane.cards[index];
      if (card.top > bottom) break;
      visible.add(card.index);
    }
  }
  return visible;
}
