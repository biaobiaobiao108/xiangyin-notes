import { describe, expect, test } from "bun:test";
import { cycleSearchMatchIndex, findTextMatches, getSearchTerms, normalizeSearchMatchIndex } from "../app/editor-search";

describe("editor search", () => {
  test("finds every Chinese match in document order", () => {
    expect(findTextMatches("绝对不是绝缘，绝对。绝对", "绝对")).toEqual([
      { start: 0, end: 2 },
      { start: 7, end: 9 },
      { start: 10, end: 12 },
    ]);
  });

  test("matches Latin text without case sensitivity", () => {
    expect(findTextMatches("Search the SEARCH result", "search")).toEqual([
      { start: 0, end: 6 },
      { start: 11, end: 17 },
    ]);
  });

  test("splits Latin queries into searchable terms and ignores punctuation", () => {
    expect(getSearchTerms("quiet,  THINKING")).toEqual(["quiet", "thinking"]);
    expect(findTextMatches("Quiet thinking keeps thinking clear", "quiet, thinking")).toEqual([
      { start: 0, end: 5 },
      { start: 6, end: 14 },
      { start: 21, end: 29 },
    ]);
  });

  test("deduplicates overlapping matches from repeated terms", () => {
    expect(findTextMatches("foobar foo", "foo foobar")).toEqual([
      { start: 0, end: 6 },
      { start: 7, end: 10 },
    ]);
  });

  test("returns no match for an empty or punctuation-only query", () => {
    expect(findTextMatches("anything", "")).toEqual([]);
    expect(findTextMatches("anything", "!!!")).toEqual([]);
  });

  test("normalizes and cycles match indexes with wraparound", () => {
    expect(normalizeSearchMatchIndex(0, 3)).toBe(0);
    expect(normalizeSearchMatchIndex(-1, 3)).toBe(2);
    expect(normalizeSearchMatchIndex(4, 3)).toBe(1);
    expect(normalizeSearchMatchIndex(4, 0)).toBe(0);
    expect(cycleSearchMatchIndex(0, 3, -1)).toBe(2);
    expect(cycleSearchMatchIndex(2, 3, 1)).toBe(0);
    expect(cycleSearchMatchIndex(1, 1, 1)).toBe(0);
  });
});
