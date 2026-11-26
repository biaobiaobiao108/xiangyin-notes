import { describe, expect, test } from "bun:test";
import {
  extractWikiLinks,
  findUnlinkedMentionsInMarkdown,
  linkMentionInMarkdown,
  formatWikiLink,
} from "../shared/wiki-links";
import { cleanDisplayTitle, cleanSnippetForDisplay } from "../app/editor/backlinks-panel";

describe("wiki-links utility", () => {
  test("extracts basic and aliased wiki-links", () => {
    const md =
      "这是关于 [[11111111-1111-4111-8111-111111111111|象映笔记]] 的记录，也可以看看 [[22222222-2222-4222-8222-222222222222|技术架构|架构设计]]。";
    const links = extractWikiLinks(md);
    expect(links).toHaveLength(2);
    expect(links[0].target).toBe("11111111-1111-4111-8111-111111111111");
    expect(links[0].alias).toBeUndefined();
    expect(links[1].target).toBe("22222222-2222-4222-8222-222222222222");
    expect(links[1].alias).toBe("架构设计");
  });

  test("ignores wiki-links inside code fences and inline code", () => {
    const md = `
正文中的 [[11111111-1111-4111-8111-111111111111|真实链接]]
\`\`\`ts
const code = "[[11111111-1111-4111-8111-111111111111|代码中的伪链接]]";
\`\`\`
行内代码 \`[[11111111-1111-4111-8111-111111111111|行内伪链接]]\` 应该被忽略。
还有另外一个 [[11111111-1111-4111-8111-111111111111|有效链接]]
`;
    const links = extractWikiLinks(md);
    expect(links.map((l) => l.label)).toEqual(["真实链接", "有效链接"]);
  });

  test("ignores indented code or prematurely close a fenced code block", () => {
    const examples = [
      "    [[11111111-1111-4111-8111-111111111111|Alpha]]\n\n[[11111111-1111-4111-8111-111111111111|Alpha]]",
      "\t[[11111111-1111-4111-8111-111111111111|Alpha]]\n\n[[11111111-1111-4111-8111-111111111111|Alpha]]",
      "```md\n[[11111111-1111-4111-8111-111111111111|Alpha]]\n```not-closing\n[[11111111-1111-4111-8111-111111111111|Alpha]]\n```\n\n[[11111111-1111-4111-8111-111111111111|Alpha]]",
      "~~~md\n[[11111111-1111-4111-8111-111111111111|Alpha]]\n~~~not-closing\n[[11111111-1111-4111-8111-111111111111|Alpha]]\n~~~\n\n[[11111111-1111-4111-8111-111111111111|Alpha]]",
      "    [[11111111-1111-4111-8111-111111111111|Alpha]]\r\n\r\n[[11111111-1111-4111-8111-111111111111|Alpha]]",
      "```md\r\n[[11111111-1111-4111-8111-111111111111|Alpha]]\r\n```not-closing\r\n[[11111111-1111-4111-8111-111111111111|Alpha]]\r\n```\r\n\r\n[[11111111-1111-4111-8111-111111111111|Alpha]]",
    ];
    for (const markdown of examples) {
      const links = extractWikiLinks(markdown);
      expect(links).toHaveLength(1);
      expect(links[0].start).toBe(
        markdown.lastIndexOf("[[11111111-1111-4111-8111-111111111111|Alpha]]"),
      );
    }
    expect(findUnlinkedMentionsInMarkdown("    Alpha\n\nAlpha", "Alpha")).toHaveLength(1);
    expect(
      extractWikiLinks("paragraph\n    [[11111111-1111-4111-8111-111111111111|Alpha]]"),
    ).toHaveLength(1);
  });

  test("ignores fenced code nested in block quotes and lists, including CRLF sources", () => {
    const markdown = [
      "> ~~~md",
      "> [[11111111-1111-4111-8111-111111111111|Alpha]]",
      "> ~~~",
      "",
      "- ~~~md",
      "  [[11111111-1111-4111-8111-111111111111|Alpha]]",
      "  ~~~",
      "",
      "> - ```md",
      ">   [[11111111-1111-4111-8111-111111111111|Alpha]]",
      ">   ```",
      "",
      "[[11111111-1111-4111-8111-111111111111|Alpha]]",
    ].join("\r\n");

    expect(extractWikiLinks(markdown).map((link) => link.label)).toEqual(["Alpha"]);
  });

  test("ends a nested fence when its Markdown container ends", () => {
    const markdown =
      "> ~~~md\n> [[11111111-1111-4111-8111-111111111111|Alpha]]\nordinary text and [[11111111-1111-4111-8111-111111111111|Alpha]]";
    expect(extractWikiLinks(markdown).map((link) => link.label)).toEqual(["Alpha"]);
  });

  test("keeps links after a deeply nested list fence in scope", () => {
    const markdown =
      "- outer\n  - ~~~\n    [[11111111-1111-4111-8111-111111111111|Alpha]]\n    ~~~\n\n[[11111111-1111-4111-8111-111111111111|Alpha]]";
    expect(extractWikiLinks(markdown).map((link) => link.label)).toEqual(["Alpha"]);
  });

  test("maps list code block lines indented with tabs", () => {
    const markdown =
      "- ~~~md\n\t[[11111111-1111-4111-8111-111111111111|Alpha]]\n\t~~~\n\n[[11111111-1111-4111-8111-111111111111|Alpha]]";
    expect(extractWikiLinks(markdown).map((link) => link.label)).toEqual(["Alpha"]);
  });

  test("preserves code under task items and list markers with varying whitespace", () => {
    const examples = [
      "- [ ] todo\n\n  ~~~\n  [[11111111-1111-4111-8111-111111111111|Hidden]]\n  ~~~\n\n[[11111111-1111-4111-8111-111111111111|Visible]]",
      "-\t~~~\n\t[[11111111-1111-4111-8111-111111111111|Hidden]]\n\t~~~\n\n[[11111111-1111-4111-8111-111111111111|Visible]]",
      "-     ~~~\n      [[11111111-1111-4111-8111-111111111111|Hidden]]\n      ~~~\n\n[[11111111-1111-4111-8111-111111111111|Visible]]",
    ];
    for (const markdown of examples) {
      expect(extractWikiLinks(markdown).map((link) => link.label)).toEqual(["Visible"]);
    }
  });

  test("maps code intervals to their exact source when code repeats a prior line", () => {
    const markdown =
      "[[11111111-1111-4111-8111-111111111111|Alpha]]\n\n    [[11111111-1111-4111-8111-111111111111|Alpha]]";
    expect(extractWikiLinks(markdown).map((link) => link.start)).toEqual([0]);
  });

  test("keeps block offsets exact when later paragraphs have multiple blank lines", () => {
    const markdown =
      "[[11111111-1111-4111-8111-111111111111|Visible]]\n\n~~~\n[[11111111-1111-4111-8111-111111111111|Hidden]]\n~~~\n\n\nlast paragraph";
    expect(extractWikiLinks(markdown).map((link) => link.label)).toEqual(["Visible"]);
  });

  test("preserves source boundaries with CR-only line endings", () => {
    const markdown =
      "> ~~~md\r> [[11111111-1111-4111-8111-111111111111|Alpha]]\rordinary text and [[11111111-1111-4111-8111-111111111111|Alpha]]";
    expect(extractWikiLinks(markdown).map((link) => link.label)).toEqual(["Alpha"]);
  });

  test("preserves inline code with a shorter backtick run in its contents", () => {
    const markdown =
      "``example ` [[11111111-1111-4111-8111-111111111111|Alpha]]`` and [[11111111-1111-4111-8111-111111111111|Alpha]]";
    expect(extractWikiLinks(markdown)).toHaveLength(1);
  });

  test("finds unlinked mentions outside code, links, and images", () => {
    const md = `
象映笔记 是一个非常优秀的应用。
参考已有链接 [[11111111-1111-4111-8111-111111111111|象映笔记]] 和 [象映笔记](https://example.com)。
\`\`\`
象映笔记 代码中
\`\`\`
行内 \`象映笔记\` 忽略。
结尾再次提到 象映笔记 结束。
`;
    const mentions = findUnlinkedMentionsInMarkdown(md, "象映笔记");
    expect(mentions).toHaveLength(2);
    expect(mentions[0].snippet).toContain("是一个非常优秀的应用");
    expect(mentions[1].snippet).toContain("结尾再次提到 象映笔记 结束");
  });

  test("keeps matches at exclusion boundaries while scanning many intervals", () => {
    const markdown = [
      "Alpha",
      "`Alpha`",
      "Alpha",
      "[Alpha](https://example.com)",
      "Alpha",
      "[[11111111-1111-4111-8111-111111111111|Alpha]]",
      "Alpha",
      "",
      "    Alpha",
      "",
      "Alpha",
    ].join("\n");

    expect(
      findUnlinkedMentionsInMarkdown(markdown, "Alpha").map((match) => match.matchText),
    ).toEqual(["Alpha", "Alpha", "Alpha", "Alpha", "Alpha"]);

    const repeatedIntervals = Array.from({ length: 128 }, () => "Alpha\n`Alpha`\nAlpha").join("\n");
    expect(findUnlinkedMentionsInMarkdown(repeatedIntervals, "Alpha")).toHaveLength(256);
  });

  test("converts unlinked mention to wiki-link", () => {
    const md = "我们来讨论 象映笔记 的新功能。";
    const target = "象映笔记";
    const mentions = findUnlinkedMentionsInMarkdown(md, target);
    expect(mentions).toHaveLength(1);

    const converted = linkMentionInMarkdown(
      md,
      mentions[0].start,
      mentions[0].end,
      "11111111-1111-4111-8111-111111111111",
      target,
    );
    expect(converted).toBe(
      "我们来讨论 [[11111111-1111-4111-8111-111111111111|象映笔记]] 的新功能。",
    );
  });

  test("ignores title-only syntax and round-trips literal delimiters", () => {
    expect(extractWikiLinks("[[标题]] [[标题|别名]] 【【全角标题】】")).toEqual([]);
    const link = formatWikiLink(
      "11111111-1111-4111-8111-111111111111",
      "标题 | ]",
      "别名 | ]\n多行",
    );
    expect(extractWikiLinks(link)).toEqual([
      expect.objectContaining({
        target: "11111111-1111-4111-8111-111111111111",
        label: "标题 | ]",
        alias: "别名 | ]\n多行",
      }),
    ]);
  });

  test("shows a fallback label or alias in snippets", () => {
    expect(cleanDisplayTitle("  正常笔记  ")).toBe("正常笔记");
    expect(cleanDisplayTitle(null)).toBe("未命名笔记");
    expect(
      cleanSnippetForDisplay(
        "### [[11111111-1111-4111-8111-111111111111|旧标题]]",
        "11111111-1111-4111-8111-111111111111",
        "新标题",
      ),
    ).toBe("新标题");
    expect(
      cleanSnippetForDisplay(
        "参考 [[11111111-1111-4111-8111-111111111111|旧标题|别名]]",
        "11111111-1111-4111-8111-111111111111",
        "新标题",
      ),
    ).toBe("参考 别名");
  });
});
