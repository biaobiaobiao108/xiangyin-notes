const SEARCH_PATTERN_CACHE_LIMIT = 64;
// Patterns are non-global, so reused expressions keep no match state.
const searchPatterns = new Map<string, RegExp>();

function searchPattern(term: string) {
  const cached = searchPatterns.get(term);
  if (cached) return cached;

  const pattern = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu");
  if (searchPatterns.size >= SEARCH_PATTERN_CACHE_LIMIT)
    searchPatterns.delete(searchPatterns.keys().next().value!);
  searchPatterns.set(term, pattern);
  return pattern;
}

export function searchContains(text: string, term: string) {
  return searchPattern(term).test(text);
}

// `instr` is case-sensitive. Only use it when no character in the term has a
// case mapping, so it is equivalent to the case-insensitive regex.
export function searchTermNeedsCaseFolding(term: string) {
  return Array.from(term).some(
    (character) => character.toLowerCase() !== character || character.toUpperCase() !== character,
  );
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
