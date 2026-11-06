import { expect, test } from "bun:test";
import { cleanSnippetForDisplay, highlightSnippetParts } from "../app/editor/backlinks-panel";

test("backlink snippets drop annotation markup while keeping visible text", () => {
  const snippet =
    '前文 <span data-annotation-id="11111111-1111-4111-8111-111111111111" data-note="隐藏批注">[[目标笔记]]</span> 后文';
  expect(cleanSnippetForDisplay(snippet)).toBe("前文 目标笔记 后文");
});

test("backlink highlighting marks every occurrence of the target title", () => {
  const parts = highlightSnippetParts("目标 前文 目标 后文 目标", "目标");
  expect(parts.filter((part) => part.highlighted).map((part) => part.text)).toEqual([
    "目标",
    "目标",
    "目标",
  ]);
});
