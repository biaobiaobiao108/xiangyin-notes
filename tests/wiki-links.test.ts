import { describe, expect, test } from "bun:test";
import {
  extractWikiLinks,
  extractWikiLinkTargets,
  findUnlinkedMentionsInMarkdown,
  linkMentionInMarkdown,
  replaceWikiLinkTarget,
} from "../shared/wiki-links";
import { cleanDisplayTitle, cleanSnippetForDisplay } from "../app/editor/backlinks-panel";

describe("wiki-links utility", () => {
  test("extracts basic and aliased wiki-links", () => {
    const md = "这是关于 [[象映笔记]] 的记录，也可以看看 [[技术架构|架构设计]]。";
    const links = extractWikiLinks(md);
    expect(links).toHaveLength(2);
    expect(links[0].target).toBe("象映笔记");
    expect(links[0].alias).toBeUndefined();
    expect(links[1].target).toBe("技术架构");
    expect(links[1].alias).toBe("架构设计");

    const targets = extractWikiLinkTargets(md);
    expect(targets).toEqual(["象映笔记", "技术架构"]);
  });

  test("ignores wiki-links inside code fences and inline code", () => {
    const md = `
正文中的 [[真实链接]]
\`\`\`ts
const code = "[[代码中的伪链接]]";
\`\`\`
行内代码 \`[[行内伪链接]]\` 应该被忽略。
还有另外一个 [[有效链接]]
`;
    const links = extractWikiLinks(md);
    expect(links.map((l) => l.target)).toEqual(["真实链接", "有效链接"]);
  });

  test("does not rewrite indented code or prematurely close a fenced code block", () => {
    const examples = [
      "    [[Alpha]]\n\n[[Alpha]]",
      "\t[[Alpha]]\n\n[[Alpha]]",
      "```md\n[[Alpha]]\n```not-closing\n[[Alpha]]\n```\n\n[[Alpha]]",
      "~~~md\n[[Alpha]]\n~~~not-closing\n[[Alpha]]\n~~~\n\n[[Alpha]]",
      "    [[Alpha]]\r\n\r\n[[Alpha]]",
      "```md\r\n[[Alpha]]\r\n```not-closing\r\n[[Alpha]]\r\n```\r\n\r\n[[Alpha]]",
    ];
    for (const markdown of examples) {
      const links = extractWikiLinks(markdown);
      expect(links).toHaveLength(1);
      expect(links[0].start).toBe(markdown.lastIndexOf("[[Alpha]]"));
      expect(replaceWikiLinkTarget(markdown, "Alpha", "Beta")).toEqual({
        content: markdown.slice(0, markdown.lastIndexOf("[[Alpha]]")) + "[[Beta]]",
        count: 1,
      });
    }
    expect(findUnlinkedMentionsInMarkdown("    Alpha\n\nAlpha", "Alpha")).toHaveLength(1);
    expect(extractWikiLinks("paragraph\n    [[Alpha]]")).toHaveLength(1);
  });

  test("ignores fenced code nested in block quotes and lists, including CRLF sources", () => {
    const markdown = [
      "> ~~~md",
      "> [[Alpha]]",
      "> ~~~",
      "",
      "- ~~~md",
      "  [[Alpha]]",
      "  ~~~",
      "",
      "> - ```md",
      ">   [[Alpha]]",
      ">   ```",
      "",
      "[[Alpha]]",
    ].join("\r\n");

    expect(extractWikiLinks(markdown).map((link) => link.target)).toEqual(["Alpha"]);
    const finalLink = markdown.lastIndexOf("[[Alpha]]");
    expect(replaceWikiLinkTarget(markdown, "Alpha", "Beta")).toEqual({
      content: markdown.slice(0, finalLink) + "[[Beta]]" + markdown.slice(finalLink + 9),
      count: 1,
    });
  });

  test("ends a nested fence when its Markdown container ends", () => {
    const markdown = "> ~~~md\n> [[Alpha]]\nordinary text and [[Alpha]]";
    expect(extractWikiLinks(markdown).map((link) => link.target)).toEqual(["Alpha"]);
    expect(replaceWikiLinkTarget(markdown, "Alpha", "Beta")).toEqual({
      content: "> ~~~md\n> [[Alpha]]\nordinary text and [[Beta]]",
      count: 1,
    });
  });

  test("keeps links after a deeply nested list fence in scope", () => {
    const markdown = "- outer\n  - ~~~\n    [[Alpha]]\n    ~~~\n\n[[Alpha]]";
    expect(extractWikiLinks(markdown).map((link) => link.target)).toEqual(["Alpha"]);
    expect(replaceWikiLinkTarget(markdown, "Alpha", "Beta")).toEqual({
      content: "- outer\n  - ~~~\n    [[Alpha]]\n    ~~~\n\n[[Beta]]",
      count: 1,
    });
  });

  test("maps list code block lines indented with tabs", () => {
    const markdown = "- ~~~md\n\t[[Alpha]]\n\t~~~\n\n[[Alpha]]";
    expect(extractWikiLinks(markdown).map((link) => link.target)).toEqual(["Alpha"]);
  });

  test("preserves code under task items and list markers with varying whitespace", () => {
    const examples = [
      "- [ ] todo\n\n  ~~~\n  [[Hidden]]\n  ~~~\n\n[[Visible]]",
      "-\t~~~\n\t[[Hidden]]\n\t~~~\n\n[[Visible]]",
      "-     ~~~\n      [[Hidden]]\n      ~~~\n\n[[Visible]]",
    ];
    for (const markdown of examples) {
      expect(extractWikiLinks(markdown).map((link) => link.target)).toEqual(["Visible"]);
      expect(replaceWikiLinkTarget(markdown, "Hidden", "Changed").content).toBe(markdown);
    }
  });

  test("maps code intervals to their exact source when code repeats a prior line", () => {
    const markdown = "[[Alpha]]\n\n    [[Alpha]]";
    expect(extractWikiLinks(markdown).map((link) => link.start)).toEqual([0]);
  });

  test("keeps block offsets exact when later paragraphs have multiple blank lines", () => {
    const markdown = "[[Visible]]\n\n~~~\n[[Hidden]]\n~~~\n\n\nlast paragraph";
    expect(extractWikiLinks(markdown).map((link) => link.target)).toEqual(["Visible"]);
  });

  test("preserves source boundaries with CR-only line endings", () => {
    const markdown = "> ~~~md\r> [[Alpha]]\rordinary text and [[Alpha]]";
    expect(extractWikiLinks(markdown).map((link) => link.target)).toEqual(["Alpha"]);
    expect(replaceWikiLinkTarget(markdown, "Alpha", "Beta").content).toBe(
      "> ~~~md\r> [[Alpha]]\rordinary text and [[Beta]]",
    );
  });

  test("preserves inline code with a shorter backtick run in its contents", () => {
    const markdown = "``example ` [[Alpha]]`` and [[Alpha]]";
    expect(extractWikiLinks(markdown)).toHaveLength(1);
    expect(replaceWikiLinkTarget(markdown, "Alpha", "Beta").content).toBe(
      "``example ` [[Alpha]]`` and [[Beta]]",
    );
  });

  test("replaces wiki link target correctly and preserves aliases", () => {
    const md = "参考 [[旧标题]] 和 [[旧标题|展示别名]]，以及无关的 [[其他标题]]。";
    const { content, count } = replaceWikiLinkTarget(md, "旧标题", "新标题");
    expect(count).toBe(2);
    expect(content).toBe("参考 [[新标题]] 和 [[新标题|展示别名]]，以及无关的 [[其他标题]]。");
  });

  test("finds unlinked mentions outside code, links, and images", () => {
    const md = `
象映笔记 是一个非常优秀的应用。
参考已有链接 [[象映笔记]] 和 [象映笔记](https://example.com)。
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
      "[[Alpha]]",
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

    const converted = linkMentionInMarkdown(md, mentions[0].start, mentions[0].end, target);
    expect(converted).toBe("我们来讨论 [[象映笔记]] 的新功能。");
  });

  test("extracts Chinese full-width bracket wiki-links and aliases", () => {
    const md = "这是关于 【【全角笔记】】 的记录，也可以看看 【【技术架构｜架构设计】】。";
    const links = extractWikiLinks(md);
    expect(links).toHaveLength(2);
    expect(links[0].target).toBe("全角笔记");
    expect(links[0].alias).toBeUndefined();
    expect(links[1].target).toBe("技术架构");
    expect(links[1].alias).toBe("架构设计");

    const targets = extractWikiLinkTargets(md);
    expect(targets).toEqual(["全角笔记", "技术架构"]);
  });

  test("cleanDisplayTitle strips outer brackets and provides fallback", () => {
    expect(cleanDisplayTitle("[[某个笔记]]")).toBe("某个笔记");
    expect(cleanDisplayTitle("【【某个笔记】】")).toBe("某个笔记");
    expect(cleanDisplayTitle("[[ 内部有空格的笔记 ]]")).toBe("内部有空格的笔记");
    expect(cleanDisplayTitle("正常笔记")).toBe("正常笔记");
    expect(cleanDisplayTitle("")).toBe("未命名笔记");
    expect(cleanDisplayTitle(null)).toBe("未命名笔记");
  });

  test("cleanSnippetForDisplay removes double brackets and normalizes aliases", () => {
    expect(cleanSnippetForDisplay("[[ 这就是一种自信 ]], 你信不i想你")).toBe(
      "这就是一种自信, 你信不i想你",
    );
    expect(cleanSnippetForDisplay("[[ 这就是一种自信 ]]你这么纠缠有意思么?")).toBe(
      "这就是一种自信你这么纠缠有意思么?",
    );
    expect(cleanSnippetForDisplay("【【全角笔记】】测试")).toBe("全角笔记测试");
    expect(cleanSnippetForDisplay("参考 [[这就是一种自信|自信心]] 详细介绍")).toBe(
      "参考 自信心 详细介绍",
    );
    expect(cleanSnippetForDisplay("参考 【【这就是一种自信｜自信心】】 详细介绍")).toBe(
      "参考 自信心 详细介绍",
    );
    expect(cleanSnippetForDisplay("### [[这就是一种自信]]")).toBe("这就是一种自信");
    expect(cleanSnippetForDisplay("")).toBe("");
  });
});
