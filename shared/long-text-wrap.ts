// Give long Latin-script runs (including URLs, hashes and identifiers) more
// display breakpoints without changing ordinary words or the source text.
export function findLongTextRuns(text: string, inlineCode = false) {
  return text.matchAll(
    inlineCode ? /[!-~\p{Script=Latin}\p{Mark}]{28,}/gu : /[!-~\p{Script=Latin}\p{Mark}]{40,}/gu,
  );
}
