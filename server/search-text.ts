function searchPattern(term: string) {
  return new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu");
}

export function searchContains(text: string, term: string) {
  return searchPattern(term).test(text);
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
