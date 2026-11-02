const SEARCH_PATTERN_CACHE_LIMIT = 256;
// Patterns are non-global, so reused expressions keep no match state.
const searchPatterns = new Map<string, RegExp>();

function searchPattern(term: string) {
  const cached = searchPatterns.get(term);
  if (cached) {
    searchPatterns.delete(term);
    searchPatterns.set(term, cached);
    return cached;
  }

  const hasNonAscii = /[^\x00-\x7F]/.test(term);
  const pattern = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), hasNonAscii ? "iu" : "i");
  if (searchPatterns.size >= SEARCH_PATTERN_CACHE_LIMIT)
    searchPatterns.delete(searchPatterns.keys().next().value!);
  searchPatterns.set(term, pattern);
  return pattern;
}

export function searchContains(text: string, term: string) {
  if (!text || !term) return false;
  return searchPattern(term).test(text);
}

// `instr` is case-sensitive. Only use it when no character in the term has a
// case mapping, so it is equivalent to the case-insensitive regex.
export function searchTermNeedsCaseFolding(term: string) {
  return Array.from(term).some(
    (character) => character.toLowerCase() !== character || character.toUpperCase() !== character,
  );
}

function quoteFtsTerm(term: string) {
  return `"${term.replaceAll('"', '""')}"`;
}

function simpleCaseVariants(character: string) {
  // Unicode simple case folding does not equate dotless i with ASCII I.
  if (character === "ı") return [character];
  const variants = new Set([character]);
  const pending = [character];
  while (pending.length) {
    const current = pending.shift()!;
    for (const candidate of [current.toLowerCase(), current.toUpperCase()]) {
      if (Array.from(candidate).length !== 1 || variants.has(candidate)) continue;
      variants.add(candidate);
      pending.push(candidate);
    }
  }
  return [...variants];
}

function ftsTermExpression(term: string) {
  let variants = [""];
  let expanded = false;
  for (const character of term) {
    const choices =
      (character.codePointAt(0) ?? 0) > 0x7f ? simpleCaseVariants(character) : [character];
    if (choices.length > 1) expanded = true;
    if (variants.length * choices.length > 32) {
      variants = [...new Set([term, term.toLowerCase(), term.toUpperCase()])];
      break;
    }
    variants = variants.flatMap((prefix) => choices.map((choice) => prefix + choice));
  }
  if (!expanded) return quoteFtsTerm(term);
  return `(${variants.map(quoteFtsTerm).join(" OR ")})`;
}

/** Builds an AND query while covering simple Unicode case-fold differences in trigram FTS. */
export function buildFtsMatchQuery(tokens: readonly string[]) {
  return tokens.map(ftsTermExpression).join(" AND ");
}

export function searchSnippet(text: string, termsJson: string) {
  const terms = JSON.parse(termsJson) as string[];
  let match = -1;
  for (const term of terms) {
    const index = text.search(searchPattern(term));
    if (index !== -1 && (match === -1 || index < match)) match = index;
  }
  let start = Math.max(0, match);
  for (let count = 0; count < 60 && start > 0; count++) {
    start--;
    if (start > 0 && text.charCodeAt(start) >= 0xdc00 && text.charCodeAt(start) <= 0xdfff) start--;
  }
  let end = start;
  for (let count = 0; count < 200 && end < text.length; count++) {
    end += (text.codePointAt(end) ?? 0) > 0xffff ? 2 : 1;
  }
  return text.slice(start, end);
}
