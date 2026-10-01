import { describe, expect, test } from "bun:test";
import { extractTags, findTagRanges, findTrailingTagFooterStart, hasTag, normalizeTag, parseTagQuery, preserveEscapedHashtagsForEditor, removeTagsFromMarkdown } from "../shared/tags";

describe("note tags", () => {
  test("extracts unique tags in first-seen order", () => {
    expect(extractTags("中文#项目 #Tag #项目-资料 #Tag_2 #tag")).toEqual(["项目", "Tag", "项目-资料", "Tag_2"]);
  });

  test("uses the explicit 40-code-unit tag limit for body hashtags", () => {
    const withinLimit = `#${"界".repeat(40)}`;
    const overLimit = `#${"界".repeat(41)}`;
    expect(extractTags(withinLimit)).toEqual(["界".repeat(40)]);
    expect(extractTags(`${overLimit} #后续标签`)).toEqual(["后续标签"]);
    const supplementaryLetters = String.fromCodePoint(0x10400);
    expect(extractTags(`#${supplementaryLetters.repeat(20)}`)).toEqual([supplementaryLetters.repeat(20)]);
    expect(extractTags(`#${supplementaryLetters.repeat(21)}`)).toEqual([]);
  });

  test("returns exact ranges for visual decorations", () => {
    const markdown = "前#项目，后 #Tag";
    expect(findTagRanges(markdown)).toEqual([
      { start: 1, end: 4, tag: "项目" },
      { start: 7, end: 11, tag: "Tag" },
    ]);
  });

  test("finds a trailing standalone tag footer, including surrounding blank lines", () => {
    expect(findTrailingTagFooterStart("正文\n#标签")).toBe(3);
    expect(findTrailingTagFooterStart("正文\r\n#标签\r\n\r\n")).toBe(4);
    expect(findTrailingTagFooterStart("正文 #行内标签")).toBeNull();
    expect(findTrailingTagFooterStart("正文\n#标签\n普通正文")).toBeNull();
  });

  test("ignores headings, malformed markers, and fenced code blocks", () => {
    expect(extractTags("# 标题\n##tagger\n###tag\n#tag\n\n```ts\n#hidden\n```\n~~~\n#also-hidden\n~~~")).toEqual(["tag"]);
  });

  test("ignores inline code spans, including multiline and mixed backtick runs", () => {
    const markdown = "正文 `#inline` #visible\n``code `#nested` `` #also-visible\n`跨行\n#hidden`\n#shown\n```ts\n#fenced\n```";
    expect(extractTags(markdown)).toEqual(["visible", "also-visible", "shown"]);
  });

  test("ignores escaped hashtags and preserves their meaning through editor Markdown parsing", () => {
    const markdown = "C\\#Sharp，话题 \\#技术，标签 #真实标签，\\#仍是标签";
    expect(extractTags(markdown)).toEqual(["真实标签"]);
    const doubleSlash = "双反斜杠 \\\\#字面量";
    expect(extractTags(doubleSlash)).toEqual(["字面量"]);
    expect(preserveEscapedHashtagsForEditor(doubleSlash)).toBe(doubleSlash);
    expect(removeTagsFromMarkdown(markdown, ["Sharp", "技术", "真实标签"])).toBe("C\\#Sharp，话题 \\#技术，标签，\\#仍是标签");

    const editorMarkdown = preserveEscapedHashtagsForEditor(markdown);
    expect(editorMarkdown).toContain(`#\u2060Sharp`);
    expect(editorMarkdown).toContain(`#\u2060技术`);
    expect(extractTags(editorMarkdown)).toEqual(["真实标签"]);
  });

  test("removes matching visible tag markers while preserving code examples", () => {
    expect(removeTagsFromMarkdown("前文 #移除 `#移除` #保留\n#移除", ["移除"])).toBe("前文 `#移除` #保留");
    expect(removeTagsFromMarkdown("第一行\n#单独标签行\n第三行", ["单独标签行"])).toBe("第一行\n第三行");
    expect(removeTagsFromMarkdown("第一行\n普通文字 #移除\n第三行", ["移除"])).toBe("第一行\n普通文字\n第三行");
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
