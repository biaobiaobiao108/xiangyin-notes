import { describe, expect, test } from "bun:test";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { createTableExtensions } from "../app/editor/table-extensions";
import { extractWikiLinks, formatWikiLink } from "../shared/wiki-links";
import { WikiLinkNode } from "../app/editor/wiki-link-node";
import { findWikiLinkSuggestionMatch } from "../app/editor/wiki-link-suggestion";

describe("WikiLinkNode markdown integration", () => {
  test("parses and serializes wiki links seamlessly with @tiptap/markdown", () => {
    const editor = new Editor({
      extensions: [StarterKit, Markdown, WikiLinkNode],
      content:
        "Hello [[11111111-1111-4111-8111-111111111111|目标笔记]] and [[11111111-1111-4111-8111-111111111111|目标笔记|别名展示]] world!",
      contentType: "markdown",
    });

    const json = editor.getJSON();
    expect((json.content?.[0].content?.[1] as any)?.type).toBe("wikiLink");
    expect((json.content?.[0].content?.[1] as any)?.attrs?.target).toBe(
      "11111111-1111-4111-8111-111111111111",
    );

    const markdown = (editor as any).getMarkdown();
    expect(markdown).toBe(
      "Hello [[11111111-1111-4111-8111-111111111111|目标笔记]] and [[11111111-1111-4111-8111-111111111111|目标笔记|别名展示]] world!",
    );
    editor.destroy();
  });

  test("round-trips UUID links in Markdown table cells", () => {
    const target = "11111111-1111-4111-8111-111111111111";
    const link = formatWikiLink(target, "带|符号", "表格别名");
    const source = `| 标题 |
| --- |
| ${link.replaceAll("|", "\\|")} |`;
    const editor = new Editor({
      extensions: [StarterKit, Markdown, WikiLinkNode, ...createTableExtensions()],
      content: source,
      contentType: "markdown",
    });
    try {
      expect(editor.state.doc.firstChild?.type.name).toBe("table");
      expect(extractWikiLinks(editor.getMarkdown())).toEqual([
        expect.objectContaining({ target, label: "带|符号", alias: "表格别名" }),
      ]);
    } finally {
      editor.destroy();
    }
  });

  test("leaves older title-only syntax in plain text", () => {
    const editor = new Editor({
      extensions: [StarterKit, Markdown, WikiLinkNode],
      content: "测试 [[标题]] 以及 【【全角标题】】",
      contentType: "markdown",
    });
    expect(editor.getJSON().content?.[0]?.content?.map(({ type }) => type)).toEqual(["text"]);
    editor.destroy();
  });
});

describe("findWikiLinkSuggestionMatch", () => {
  const fakePos = (text: string) =>
    ({
      pos: text.length,
      nodeBefore: { isText: true, text } as any,
    }) as any;

  test("matches [[ and 【【 triggers", () => {
    const matchEn = findWikiLinkSuggestionMatch({ $position: fakePos("[[") });
    expect(matchEn).toEqual({
      range: { from: 0, to: 2 },
      query: "",
      text: "[[",
    });

    const matchZh = findWikiLinkSuggestionMatch({ $position: fakePos("【【") });
    expect(matchZh).toEqual({
      range: { from: 0, to: 2 },
      query: "",
      text: "【【",
    });
  });

  test("matches queries with Chinese and English characters", () => {
    const matchZh = findWikiLinkSuggestionMatch({ $position: fakePos("前面文字【【中文 笔记") });
    expect(matchZh).toEqual({
      range: { from: 4, to: 11 },
      query: "中文 笔记",
      text: "【【中文 笔记",
    });

    const matchEn = findWikiLinkSuggestionMatch({ $position: fakePos("prefix [[English Note") });
    expect(matchEn).toEqual({
      range: { from: 7, to: 21 },
      query: "English Note",
      text: "[[English Note",
    });
  });

  test("returns null when already closed with brackets", () => {
    expect(findWikiLinkSuggestionMatch({ $position: fakePos("[[Closed]]") })).toBeNull();
    expect(findWikiLinkSuggestionMatch({ $position: fakePos("【【已闭合】】") })).toBeNull();
  });

  test("matches latest open trigger when multiple triggers exist on same line", () => {
    const match = findWikiLinkSuggestionMatch({
      $position: fakePos("[[已完成]] 以及 【【当前输入"),
    });
    expect(match).toEqual({
      range: { from: 11, to: 17 },
      query: "当前输入",
      text: "【【当前输入",
    });
  });
});
