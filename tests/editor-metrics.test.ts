import { describe, expect, test } from "bun:test";
import { buildOutlineItems, countEditorText, isMarkdownHeadingMarker, parseMarkdownHeadingPrefix } from "../app/editor-metrics";

describe("editor metrics", () => {
  test("counts Chinese characters, word runs, emoji, and non-whitespace characters", () => {
    expect(countEditorText("你好，Lumen Notes 2 ✨！")).toEqual({ wordCount: 6, characterCount: 16 });
  });

  test("ignores whitespace for both text statistics", () => {
    expect(countEditorText("  first\n\nsecond\tthird  ")).toEqual({ wordCount: 3, characterCount: 16 });
  });

  test("counts the plain text returned by the editor", () => {
    expect(countEditorText("标题\n正文内容")).toEqual({ wordCount: 6, characterCount: 6 });
  });

  test("builds a hierarchical outline with unique ids", () => {
    const items = buildOutlineItems([
      { level: 1, title: "开始" },
      { level: 2, title: "开始" },
      { level: 3, title: "  " },
    ]);
    expect(items.map(({ id, level, title }) => ({ id, level, title }))).toEqual([
      { id: "lumen-heading-1-开始", level: 1, title: "开始" },
      { id: "lumen-heading-2-开始", level: 2, title: "开始" },
      { id: "lumen-heading-3-section", level: 3, title: "  " },
    ]);
  });

  test("recognizes only supported Markdown heading markers", () => {
    expect(isMarkdownHeadingMarker("#")).toBe(true);
    expect(isMarkdownHeadingMarker("###")).toBe(true);
    expect(isMarkdownHeadingMarker("####")).toBe(false);
    expect(isMarkdownHeadingMarker("## title")).toBe(false);
    expect(parseMarkdownHeadingPrefix("## ")).toEqual({ level: 2, length: 3 });
    expect(parseMarkdownHeadingPrefix("### title")).toEqual({ level: 3, length: 4 });
    expect(parseMarkdownHeadingPrefix("#title")).toBeNull();
  });
});
