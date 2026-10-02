import { describe, expect, test } from "bun:test";
import { getMarkdownOutline, locateMarkdownSection, parseMarkdownSections } from "../server/mcp-sections";

describe("MCP Markdown sections", () => {
  test("ATX and setext sections include descendants and preserve the preamble", () => {
    const markdown = "前言\n\n# 第一章\n正文\n## 子节\n内容\n### 三级\n详情\n## 同级\n内容\n\n第二章\n=====\n尾声\n";
    const sections = parseMarkdownSections(markdown);
    expect(sections.map(({ level, text }) => ({ level, text }))).toEqual([
      { level: 1, text: "第一章" }, { level: 2, text: "子节" }, { level: 3, text: "三级" },
      { level: 2, text: "同级" }, { level: 1, text: "第二章" },
    ]);
    expect(markdown.slice(sections[0]!.start, sections[0]!.end)).toBe("# 第一章\n正文\n## 子节\n内容\n### 三级\n详情\n## 同级\n内容\n\n");
    expect(sections[1]!.end).toBe(sections[3]!.start);
    expect(sections[2]!.end).toBe(sections[3]!.start);
    expect(markdown.slice(sections[4]!.start, sections[4]!.end)).toBe("第二章\n=====\n尾声\n");
    expect(getMarkdownOutline(markdown)).toEqual(sections);
  });

  test("ignores fenced and indented code, quote/list headings and HTML blocks", () => {
    const markdown = "```md\n# 伪标题\n```\n\n~~~~\n围栏内容\n====\n~~~~\n\n    # 缩进\n\n\t# 制表缩进\n\n> # 引用\n\n- # 列表\n\n<div>\n# HTML\n</div>\n\n# 真标题 ###\n\n子标题\n---\n";
    expect(parseMarkdownSections(markdown).map(({ level, text }) => ({ level, text }))).toEqual([
      { level: 1, text: "真标题" }, { level: 2, text: "子标题" },
    ]);
    expect(parseMarkdownSections("```\n# 未闭合围栏\n")).toEqual([]);
  });

  test("maps CRLF and lone CR offsets to the original text including Unicode", () => {
    const markdown = "前言😀\r\n\r\n# 一\r\n正文\r\n\r\n二\r---\r末尾";
    const sections = parseMarkdownSections(markdown);
    expect(sections[0]!.start).toBe(markdown.indexOf("# 一"));
    expect(sections[1]!.start).toBe(markdown.indexOf("二\r"));
    expect(markdown.slice(sections[1]!.start, sections[1]!.end)).toBe("二\r---\r末尾");
  });

  test("repeated headings require explicit occurrence or section ID", () => {
    const markdown = "# 重复\n一\n# 重复\n二";
    const sections = parseMarkdownSections(markdown);
    expect(locateMarkdownSection(markdown, { heading: "重复" })).toEqual({
      error: { code: "SECTION_AMBIGUOUS", message: "标题存在多个匹配，请提供 occurrence 或使用大纲中的 sectionId。", candidates: sections },
    });
    expect(locateMarkdownSection(markdown, { heading: "重复", occurrence: 2 })).toEqual({ section: sections[1]! });
    expect(locateMarkdownSection(markdown, { sectionId: sections[1]!.sectionId })).toEqual({ section: sections[1]! });
    expect(locateMarkdownSection(markdown, { heading: "重复", occurrence: 3 })).toHaveProperty("error.code", "SECTION_NOT_FOUND");
  });

  test("IDs are stable for unchanged content and fail safely after any edit", () => {
    const markdown = "# 一\n内容\n# 二\n文本";
    const sections = parseMarkdownSections(markdown);
    expect(parseMarkdownSections(markdown)).toEqual(sections);
    for (const changed of ["# 新\n" + markdown, markdown + "新增", markdown.replace("内容", "更新")]) {
      expect(locateMarkdownSection(changed, { sectionId: sections[0]!.sectionId })).toHaveProperty("error.code", "SECTION_NOT_FOUND");
    }
  });

  test("validates selectors and handles empty/nonheading content", () => {
    expect(parseMarkdownSections("")).toEqual([]);
    expect(parseMarkdownSections("正文\n\n---\n")).toEqual([]);
    for (const selector of [{}, { heading: "" }, { heading: "一", sectionId: "id" }, { sectionId: "id", occurrence: 1 }, { heading: "一", occurrence: 0 }, { heading: "一", occurrence: 1.5 }]) {
      expect(locateMarkdownSection("# 一", selector)).toHaveProperty("error.code", "INVALID_ARGUMENT");
    }
    expect(locateMarkdownSection("# 一", { heading: "二" })).toHaveProperty("error.code", "SECTION_NOT_FOUND");
  });
});
