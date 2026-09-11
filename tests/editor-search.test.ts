import { describe, expect, test } from "bun:test";
import { findTextMatches, getSearchTerms } from "../app/editor-search";

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
});
