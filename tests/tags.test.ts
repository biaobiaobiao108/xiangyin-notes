import { describe, expect, test } from "bun:test";
import { extractTags, findTagRanges, hasTag, normalizeTag, parseTagQuery, removeTagsFromMarkdown } from "../shared/tags";

describe("note tags", () => {
  test("extracts unique tags in first-seen order", () => {
    expect(extractTags("中文#项目 #Tag #项目-资料 #Tag_2 #tag")).toEqual(["项目", "Tag", "项目-资料", "Tag_2"]);
  });

  test("returns exact ranges for visual decorations", () => {
    const markdown = "前#项目，后 #Tag";
    expect(findTagRanges(markdown)).toEqual([
      { start: 1, end: 4, tag: "项目" },
      { start: 7, end: 11, tag: "Tag" },
    ]);
  });

  test("ignores headings, malformed markers, and fenced code blocks", () => {
    expect(extractTags("# 标题\n##tagger\n###tag\n#tag\n\n```ts\n#hidden\n```\n~~~\n#also-hidden\n~~~")).toEqual(["tag"]);
  });

  test("ignores inline code spans, including multiline and mixed backtick runs", () => {
    const markdown = "正文 `#inline` #visible\n``code `#nested` `` #also-visible\n`跨行\n#hidden`\n#shown\n```ts\n#fenced\n```";
    expect(extractTags(markdown)).toEqual(["visible", "also-visible", "shown"]);
  });

  test("removes matching visible tag markers while preserving code examples", () => {
    expect(removeTagsFromMarkdown("前文 #移除 `#移除` #保留\n#移除", ["移除"])).toBe("前文  `#移除` #保留\n");
    expect(removeTagsFromMarkdown("第一行\n#单独标签行\n第三行", ["单独标签行"])).toBe("第一行\n第三行");
    expect(removeTagsFromMarkdown("第一行\n普通文字 #移除\n第三行", ["移除"])).toBe("第一行\n普通文字 \n第三行");
    expect(removeTagsFromMarkdown("#保留", [])).toBe("#保留");
  });

  test("parses exact tag queries and compares Latin letters case-insensitively", () => {
    expect(parseTagQuery("  #项目-资料 ")).toBe("项目-资料");
    expect(parseTagQuery("#Tag")).toBe("tag");
    expect(parseTagQuery("#tag other")).toBeNull();
    expect(normalizeTag("ＴＡＧ")).toBe("tag");
    expect(hasTag("正文 #Tagger", "tag")).toBe(false);
    expect(hasTag("正文 #Tagger #Tag", "tag")).toBe(true);
  });
});
