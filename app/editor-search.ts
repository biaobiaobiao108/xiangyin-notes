import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { changedDocumentRange, expandRangeToTextNodes } from "./editor/changed-range";

export type TextSearchMatch = {
  start: number;
  end: number;
};

export type EditorSearchMatch = {
  from: number;
  to: number;
};

export type SearchMatchSummary<TMatch> = {
  matches: TMatch[];
  totalMatchCount: number;
};

export type SearchHighlightState = SearchMatchSummary<EditorSearchMatch> & {
  query: string;
  activeIndex: number;
  decorations: DecorationSet;
};

export type SearchHighlightMeta =
  | { type: "query"; query: string; activeIndex?: number }
  | { type: "activeIndex"; index: number };

export const MAX_SEARCH_HIGHLIGHTS = 500;
export const searchHighlightPluginKey = new PluginKey<SearchHighlightState>("editorSearchHighlight");

const HAN_RE = /\p{Script=Han}/u;

type CaseExpansion = {
  normalizedStart: number;
  normalizedEnd: number;
  sourceStart: number;
  sourceEnd: number;
  deltaBefore: number;
};

function createSourceOffsetMapper(source: string, normalized: string) {
  if (source.length === normalized.length) return null;

  const expansions: CaseExpansion[] = [];
  let sourceOffset = 0;
  let normalizedOffset = 0;
  for (const character of source) {
    const lowered = character.toLocaleLowerCase("zh-CN");
    if (lowered.length !== character.length) {
      expansions.push({
        normalizedStart: normalizedOffset,
        normalizedEnd: normalizedOffset + lowered.length,
        sourceStart: sourceOffset,
        sourceEnd: sourceOffset + character.length,
        deltaBefore: normalizedOffset - sourceOffset,
      });
    }
    sourceOffset += character.length;
    normalizedOffset += lowered.length;
  }

  // Locale lower-casing can expand a character (for example, U+0130).
  // If the per-codepoint lengths do not match the full-string result, keep
  // offsets safe by falling back to the original one-to-one mapping.
  if (normalizedOffset !== normalized.length || expansions.length === 0) return null;

  const findExpansion = (offset: number) => {
    let low = 0;
    let high = expansions.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const expansion = expansions[middle];
      if (offset < expansion.normalizedStart) high = middle - 1;
      else if (offset > expansion.normalizedEnd) low = middle + 1;
      else return expansion;
    }
    return null;
  };

  const toSourceStart = (offset: number) => {
    const expansion = findExpansion(offset);
    if (expansion) return offset === expansion.normalizedEnd ? expansion.sourceEnd : expansion.sourceStart;
    return offset - findPreviousDelta(offset);
  };

  const findPreviousDelta = (offset: number) => {
    let low = 0;
    let high = expansions.length - 1;
    let previous: CaseExpansion | null = null;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const expansion = expansions[middle];
      if (expansion.normalizedEnd <= offset) {
        previous = expansion;
        low = middle + 1;
      } else high = middle - 1;
    }
    return previous
      ? previous.deltaBefore + (previous.normalizedEnd - previous.normalizedStart) - (previous.sourceEnd - previous.sourceStart)
      : 0;
  };

  const toSourceEnd = (offset: number) => {
    const expansion = findExpansion(offset);
    if (expansion) return offset === expansion.normalizedStart ? expansion.sourceStart : expansion.sourceEnd;
    return offset - findPreviousDelta(offset);
  };

  return { toSourceStart, toSourceEnd };
}

export function getSearchTerms(query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const normalized = trimmed.toLocaleLowerCase("zh-CN");
  if (HAN_RE.test(trimmed)) return [normalized];

  return normalized
    .split(/\s+/u)
    .map((term) => term.replace(/[^\p{L}\p{N}_-]/gu, ""))
    .filter(Boolean);
}

function collectTextMatchSummary(text: string, terms: string[], maxMatches: number): SearchMatchSummary<TextSearchMatch> {
  if (!text || !terms.length) return { matches: [], totalMatchCount: 0 };

  const normalizedText = text.toLocaleLowerCase("zh-CN");
  const offsetMapper = createSourceOffsetMapper(text, normalizedText);
  const streams: Array<{ term: string; next: number }> = [];
  const streamComesFirst = (left: (typeof streams)[number], right: (typeof streams)[number]) => {
    if (left.next !== right.next) return left.next < right.next;
    return left.term.length > right.term.length;
  };
  const pushStream = (stream: (typeof streams)[number]) => {
    let index = streams.push(stream) - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (!streamComesFirst(streams[index], streams[parent])) break;
      [streams[index], streams[parent]] = [streams[parent], streams[index]];
      index = parent;
    }
  };
  const popStream = () => {
    const first = streams[0];
    const last = streams.pop();
    if (!last || streams.length === 0) return first;
    streams[0] = last;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let firstChild = index;
      if (left < streams.length && streamComesFirst(streams[left], streams[firstChild])) firstChild = left;
      if (right < streams.length && streamComesFirst(streams[right], streams[firstChild])) firstChild = right;
      if (firstChild === index) break;
      [streams[index], streams[firstChild]] = [streams[firstChild], streams[index]];
      index = firstChild;
    }
    return first;
  };
  for (const term of terms) {
    const stream = { term, next: normalizedText.indexOf(term) };
    if (stream.next >= 0) pushStream(stream);
  }
  const matches: TextSearchMatch[] = [];
  const limit = Number.isFinite(maxMatches) ? Math.max(0, Math.floor(maxMatches)) : Number.POSITIVE_INFINITY;
  let totalMatchCount = 0;
  let pendingStart = -1;
  let pendingEnd = -1;

  const flushPending = () => {
    if (pendingStart < 0) return;
    totalMatchCount += 1;
    if (matches.length < limit) {
      matches.push({
        start: offsetMapper?.toSourceStart(pendingStart) ?? pendingStart,
        end: offsetMapper?.toSourceEnd(pendingEnd) ?? pendingEnd,
      });
    }
  };

  while (streams.length) {
    const stream = popStream()!;
    const start = stream.next;
    const end = start + stream.term.length;
    stream.next = normalizedText.indexOf(stream.term, start + Math.max(stream.term.length, 1));
    if (stream.next >= 0) pushStream(stream);

    if (pendingStart < 0) {
      pendingStart = start;
      pendingEnd = end;
    } else if (start <= pendingEnd) {
      pendingEnd = Math.max(pendingEnd, end);
    } else {
      flushPending();
      pendingStart = start;
      pendingEnd = end;
    }
  }
  flushPending();

  return { matches, totalMatchCount };
}

export function findTextMatchSummary(text: string, query: string, maxMatches = Number.POSITIVE_INFINITY): SearchMatchSummary<TextSearchMatch> {
  return collectTextMatchSummary(text, getSearchTerms(query), maxMatches);
}

export function findTextMatches(text: string, query: string): TextSearchMatch[] {
  return findTextMatchSummary(text, query).matches;
}

function findEditorSearchMatchSummaryInRange(doc: ProseMirrorNode, terms: string[], from: number, to: number, maxMatches: number): SearchMatchSummary<EditorSearchMatch> {
  const matches: EditorSearchMatch[] = [];
  let totalMatchCount = 0;
  if (!terms.length || from > to) return { matches, totalMatchCount };

  doc.nodesBetween(from, to, (node, position) => {
    if (!node.isText || !node.text) return;
    const summary = collectTextMatchSummary(node.text, terms, maxMatches - matches.length);
    totalMatchCount += summary.totalMatchCount;
    for (const match of summary.matches) {
      const candidate = { from: position + match.start, to: position + match.end };
      if (candidate.to > from && candidate.from < to) matches.push(candidate);
    }
  });
  return { matches, totalMatchCount };
}

export function findEditorSearchMatchSummary(doc: ProseMirrorNode, query: string, maxMatches = MAX_SEARCH_HIGHLIGHTS): SearchMatchSummary<EditorSearchMatch> {
  const terms = getSearchTerms(query);
  return findEditorSearchMatchSummaryInRange(doc, terms, 0, doc.content.size, maxMatches);
}

export function findEditorSearchMatches(doc: ProseMirrorNode, query: string): EditorSearchMatch[] {
  return findEditorSearchMatchSummary(doc, query).matches;
}

export function normalizeSearchMatchIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return ((index % count) + count) % count;
}

export function cycleSearchMatchIndex(currentIndex: number, count: number, direction: -1 | 1): number {
  return normalizeSearchMatchIndex(currentIndex + direction, count);
}

function createSearchHighlightState(doc: ProseMirrorNode, query: string, requestedIndex = 0): SearchHighlightState {
  const summary = findEditorSearchMatchSummary(doc, query);
  return createSearchHighlightStateFromMatches(doc, query, summary.matches, summary.totalMatchCount, requestedIndex);
}

function createSearchHighlightStateFromMatches(doc: ProseMirrorNode, query: string, matches: EditorSearchMatch[], totalMatchCount: number, requestedIndex = 0): SearchHighlightState {
  const activeIndex = normalizeSearchMatchIndex(requestedIndex, matches.length);
  const decorations = DecorationSet.create(doc, matches.map((match, index) => createSearchMatchDecoration(match, index === activeIndex)));
  return { query, matches, totalMatchCount, activeIndex, decorations };
}

function createSearchMatchDecoration(match: EditorSearchMatch, active: boolean) {
  return Decoration.inline(
    match.from,
    match.to,
    { class: active ? "editor-search-match editor-search-match--active" : "editor-search-match" },
  );
}

function updateActiveSearchMatch(doc: ProseMirrorNode, previous: SearchHighlightState, requestedIndex: number): SearchHighlightState {
  const activeIndex = normalizeSearchMatchIndex(requestedIndex, previous.matches.length);
  if (activeIndex === previous.activeIndex) return previous;

  const previousMatch = previous.matches[previous.activeIndex];
  const nextMatch = previous.matches[activeIndex];
  const remove: Decoration[] = [];
  const add: Decoration[] = [];
  if (previousMatch) {
    remove.push(createSearchMatchDecoration(previousMatch, true));
    add.push(createSearchMatchDecoration(previousMatch, false));
  }
  if (nextMatch) {
    remove.push(createSearchMatchDecoration(nextMatch, false));
    add.push(createSearchMatchDecoration(nextMatch, true));
  }

  return {
    query: previous.query,
    matches: previous.matches,
    totalMatchCount: previous.totalMatchCount,
    activeIndex,
    decorations: previous.decorations.remove(remove).add(doc, add),
  };
}

function searchPadding(terms: string[]) {
  return Math.max(2, ...terms.map((term) => term.length + 2));
}

function mapSearchMatch(transaction: Transaction, match: EditorSearchMatch) {
  const from = transaction.mapping.map(match.from, 1);
  const to = transaction.mapping.map(match.to, -1);
  return from < to ? { from, to } : null;
}

function mergeSearchMatches(matches: EditorSearchMatch[]) {
  matches.sort((left, right) => left.from - right.from || left.to - right.to);
  const merged: EditorSearchMatch[] = [];
  for (const match of matches) {
    const previous = merged[merged.length - 1];
    if (!previous || match.from > previous.to) merged.push(match);
    else if (match.to > previous.to) previous.to = match.to;
  }
  return merged.length > MAX_SEARCH_HIGHLIGHTS ? merged.slice(0, MAX_SEARCH_HIGHLIGHTS) : merged;
}

function findEditorSearchMatchesInRange(doc: ProseMirrorNode, terms: string[], from: number, to: number, maxMatches = MAX_SEARCH_HIGHLIGHTS) {
  return findEditorSearchMatchSummaryInRange(doc, terms, from, to, maxMatches);
}

function updateSearchHighlightState(transaction: Transaction, previous: SearchHighlightState) {
  const terms = getSearchTerms(previous.query);
  const rawRange = changedDocumentRange(transaction, searchPadding(terms));
  if (!rawRange) return createSearchHighlightState(transaction.doc, previous.query, previous.activeIndex);
  const range = expandRangeToTextNodes(transaction.doc, rawRange);
  const inverse = transaction.mapping.invert();
  const oldFrom = Math.max(0, Math.min(transaction.before.content.size, inverse.map(range.from, -1)));
  const oldTo = Math.max(oldFrom, Math.min(transaction.before.content.size, inverse.map(range.to, 1)));
  const oldRange = expandRangeToTextNodes(transaction.before, { from: oldFrom, to: oldTo });
  const oldSummary = findEditorSearchMatchesInRange(transaction.before, terms, oldRange.from, oldRange.to, 0);
  const addedSummary = findEditorSearchMatchesInRange(transaction.doc, terms, range.from, range.to);
  let totalMatchCount = Math.max(0, previous.totalMatchCount - oldSummary.totalMatchCount + addedSummary.totalMatchCount);

  const mappedMatches = previous.matches.map((match) => mapSearchMatch(transaction, match)).filter((match): match is EditorSearchMatch => Boolean(match));
  const keptMatches = mappedMatches.filter((match) => match.to <= range.from || match.from >= range.to);
  const matches = mergeSearchMatches([...keptMatches, ...addedSummary.matches]);
  const expectedVisibleCount = Math.min(totalMatchCount, MAX_SEARCH_HIGHLIGHTS);
  const previousWindowEnd = previous.matches[previous.matches.length - 1]?.to ?? -1;
  const changedInsideVisibleWindow = previous.matches.length === MAX_SEARCH_HIGHLIGHTS && totalMatchCount > MAX_SEARCH_HIGHLIGHTS && range.from < previousWindowEnd;
  let visibleMatches = matches;
  if (matches.length < expectedVisibleCount || changedInsideVisibleWindow) {
    const summary = findEditorSearchMatchSummary(transaction.doc, previous.query, MAX_SEARCH_HIGHLIGHTS);
    visibleMatches = summary.matches;
    totalMatchCount = summary.totalMatchCount;
  }
  const previousActive = previous.matches[previous.activeIndex];
  const mappedActive = previousActive ? mapSearchMatch(transaction, previousActive) : null;
  const activeIndex = mappedActive
    ? Math.max(0, visibleMatches.findIndex((match) => match.from === mappedActive.from && match.to === mappedActive.to))
    : normalizeSearchMatchIndex(previous.activeIndex, visibleMatches.length);
  return createSearchHighlightStateFromMatches(transaction.doc, previous.query, visibleMatches, totalMatchCount, activeIndex);
}

export function createSearchHighlightPlugin() {
  return new Plugin<SearchHighlightState>({
    key: searchHighlightPluginKey,
    state: {
      init: () => ({ query: "", matches: [], totalMatchCount: 0, activeIndex: 0, decorations: DecorationSet.empty }),
      apply: (transaction, previous) => {
        const meta = transaction.getMeta(searchHighlightPluginKey) as SearchHighlightMeta | undefined;
        if (meta?.type === "query") return createSearchHighlightState(transaction.doc, meta.query, meta.activeIndex);
        if (meta?.type === "activeIndex") return updateActiveSearchMatch(transaction.doc, previous, meta.index);
        if (transaction.docChanged && previous.query) return updateSearchHighlightState(transaction, previous);
        return previous;
      },
    },
    props: {
      decorations: (state) => searchHighlightPluginKey.getState(state)?.decorations ?? DecorationSet.empty,
    },
  });
}

export const SearchHighlightExtension = Extension.create({
  name: "editorSearchHighlight",

  addProseMirrorPlugins() {
    return [createSearchHighlightPlugin()];
  },
});
