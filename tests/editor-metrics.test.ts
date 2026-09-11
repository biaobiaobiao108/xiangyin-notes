import { describe, expect, test } from "bun:test";
import { buildOutlineItems, countEditorText, detectLeakedImePrefix, isMarkdownHeadingMarker, parseMarkdownBlockShortcut, parseMarkdownHeadingPrefix, shouldParseMarkdownPaste } from "../app/editor-metrics";
import { healLeakedImePrefix } from "../app/ime-markdown-safe-extension";

describe("editor metrics", () => {
  test("counts Chinese characters, word runs, emoji, and non-whitespace characters", () => {
    expect(countEditorText("你好，象映笔记 2 ✨！")).toEqual({ wordCount: 8, characterCount: 10 });
  });

  test("ignores whitespace for both text statistics", () => {
    expect(countEditorText("  first\n\nsecond\tthird  ")).toEqual({ wordCount: 3, characterCount: 16 });
  });

  test("counts the plain text returned by the editor", () => {
    expect(countEditorText("标题\n正文内容")).toEqual({ wordCount: 6, characterCount: 6 });
  });

  test("counts long text without changing the result", () => {
    expect(countEditorText("a".repeat(100_000))).toEqual({ wordCount: 1, characterCount: 100_000 });
  });

  test("builds a hierarchical outline with unique ids", () => {
    const items = buildOutlineItems([
      { level: 1, title: "开始" },
      { level: 2, title: "开始" },
      { level: 3, title: "  " },
    ]);
    expect(items.map(({ id, level, title }) => ({ id, level, title }))).toEqual([
      { id: "xiangying-heading-1-开始", level: 1, title: "开始" },
      { id: "xiangying-heading-2-开始", level: 2, title: "开始" },
      { id: "xiangying-heading-3-section", level: 3, title: "  " },
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

  test("parses all supported block-level Markdown shortcut prefixes including full-width punctuation", () => {
    expect(parseMarkdownBlockShortcut("# ")).toEqual({ type: "heading", level: 1, length: 2 });
    expect(parseMarkdownBlockShortcut("## ")).toEqual({ type: "heading", level: 2, length: 3 });
    expect(parseMarkdownBlockShortcut("### ")).toEqual({ type: "heading", level: 3, length: 4 });
    expect(parseMarkdownBlockShortcut("#### ")).toBeNull();
    // Full-width hash and full-width space
    expect(parseMarkdownBlockShortcut("＃ ")).toEqual({ type: "heading", level: 1, length: 2 });
    expect(parseMarkdownBlockShortcut("＃＃ ")).toEqual({ type: "heading", level: 2, length: 3 });
    expect(parseMarkdownBlockShortcut("##\u3000")).toEqual({ type: "heading", level: 2, length: 3 });
    expect(parseMarkdownBlockShortcut("＃＃\u3000")).toEqual({ type: "heading", level: 2, length: 3 });

    expect(parseMarkdownBlockShortcut("- ")).toEqual({ type: "bulletList", length: 2 });
    expect(parseMarkdownBlockShortcut("* ")).toEqual({ type: "bulletList", length: 2 });
    expect(parseMarkdownBlockShortcut("+ ")).toEqual({ type: "bulletList", length: 2 });
    expect(parseMarkdownBlockShortcut("1. ")).toEqual({ type: "orderedList", length: 3 });
    expect(parseMarkdownBlockShortcut("１. ")).toEqual({ type: "orderedList", length: 3 });
    expect(parseMarkdownBlockShortcut("1、 ")).toEqual({ type: "orderedList", length: 3 });
    expect(parseMarkdownBlockShortcut("2. ")).toBeNull();
    expect(parseMarkdownBlockShortcut("> ")).toEqual({ type: "blockquote", length: 2 });
    expect(parseMarkdownBlockShortcut("＞ ")).toEqual({ type: "blockquote", length: 2 });
    expect(parseMarkdownBlockShortcut("＞\u3000")).toEqual({ type: "blockquote", length: 2 });
    expect(parseMarkdownBlockShortcut("[] ")).toEqual({ type: "taskList", length: 3 });
    expect(parseMarkdownBlockShortcut("[ ] ")).toEqual({ type: "taskList", length: 4 });
    expect(parseMarkdownBlockShortcut("【】 ")).toEqual({ type: "taskList", length: 3 });
    expect(parseMarkdownBlockShortcut("【 】 ")).toEqual({ type: "taskList", length: 4 });
    expect(parseMarkdownBlockShortcut("``` ")).toEqual({ type: "codeBlock", length: 4 });
    expect(parseMarkdownBlockShortcut("｀｀｀ ")).toEqual({ type: "codeBlock", length: 4 });
    expect(parseMarkdownBlockShortcut("普通段落 ")).toBeNull();
  });

  test("detects Markdown clipboard text without overriding ordinary rich text", () => {
    expect(shouldParseMarkdownPaste("普通文本\n下一行", false)).toBe(true);
    expect(shouldParseMarkdownPaste("# 一级标题\n\n- 列表项", true)).toBe(true);
    expect(shouldParseMarkdownPaste("> 引用\n\n```ts\nconst answer = 42\n```", true)).toBe(true);
    expect(shouldParseMarkdownPaste("网页复制的普通富文本", true)).toBe(false);
    expect(shouldParseMarkdownPaste("   ", false)).toBe(false);
  });

  test("detects and removes leaked IME first-letter prefix accurately", () => {
    // Leaked letter with committed Chinese text
    expect(detectLeakedImePrefix("b标题", "b", "标题")).toBe(1);
    expect(detectLeakedImePrefix("b标题", "KeyB", "标题")).toBe(1);
    expect(detectLeakedImePrefix("B标题", "b", "标题")).toBe(1);
    expect(detectLeakedImePrefix("x项目", "x", "项目")).toBe(1);
    expect(detectLeakedImePrefix("c测试", "c", "测试")).toBe(1);
    expect(detectLeakedImePrefix("1一个", "Digit1", "一个")).toBe(1);

    // Leaked letter without committedText (Han character following prefix)
    expect(detectLeakedImePrefix("b标题", "b", undefined)).toBe(1);
    expect(detectLeakedImePrefix("x项目", "x")).toBe(1);

    // Fallback when candidateKey is missing/null, but committedText is Chinese
    expect(detectLeakedImePrefix("b标题", null, "标题")).toBe(1);
    expect(detectLeakedImePrefix("s说明", undefined, "说明")).toBe(1);

    // Leaked letter when committing pinyin text directly with Enter
    expect(detectLeakedImePrefix("aapple", "a", "apple")).toBe(1);
    expect(detectLeakedImePrefix("bbiaoti", "b", "biaoti")).toBe(1);

    // Normal typing with NO leak
    expect(detectLeakedImePrefix("标题", "b", "标题")).toBeNull();
    expect(detectLeakedImePrefix("标题", null, "标题")).toBeNull();
    expect(detectLeakedImePrefix("项目", "x", "项目")).toBeNull();

    // English word without leak
    expect(detectLeakedImePrefix("apple", "a", "apple")).toBeNull();
    expect(detectLeakedImePrefix("banana", "b", "banana")).toBeNull();

    // Intentional prefix that does not match committed text
    expect(detectLeakedImePrefix("A级", null, "A级")).toBeNull();
    expect(detectLeakedImePrefix("A级", "a", "A级")).toBeNull();

    // Empty or single character without remainder
    expect(detectLeakedImePrefix("", "b", "标题")).toBeNull();
    expect(detectLeakedImePrefix("b", "b", "")).toBeNull();
  });

  test("heals leaked IME prefix while strictly preserving normal words and uppercase terms", () => {
    // Leaked lowercase pinyin letter preceding Han characters
    expect(healLeakedImePrefix("b标题")).toEqual({ leaked: "b", healed: "标题" });
    expect(healLeakedImePrefix("x项目")).toEqual({ leaked: "x", healed: "项目" });
    expect(healLeakedImePrefix("c测试")).toEqual({ leaked: "c", healed: "测试" });
    expect(healLeakedImePrefix("a计划")).toEqual({ leaked: "a", healed: "计划" });

    // Uppercase terms (protected, e.g. B站, C语言)
    expect(healLeakedImePrefix("B站")).toBeNull();
    expect(healLeakedImePrefix("C语言")).toBeNull();
    expect(healLeakedImePrefix("H5页面")).toBeNull();

    // Pure English words (protected, e.g. app, book)
    expect(healLeakedImePrefix("app")).toBeNull();
    expect(healLeakedImePrefix("book")).toBeNull();

    // English letter followed by space then Han (protected, e.g. a 计划)
    expect(healLeakedImePrefix("a 计划")).toBeNull();
    expect(healLeakedImePrefix("b 标题")).toBeNull();

    // Pure Han characters or numbers
    expect(healLeakedImePrefix("标题")).toBeNull();
    expect(healLeakedImePrefix("1. 标题")).toBeNull();
    expect(healLeakedImePrefix("")).toBeNull();
  });
});
