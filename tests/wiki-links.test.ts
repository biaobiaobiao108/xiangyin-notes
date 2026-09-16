import { describe, expect, test } from "bun:test";
import {
  extractWikiLinks,
  extractWikiLinkTargets,
  findUnlinkedMentionsInMarkdown,
  linkMentionInMarkdown,
  replaceWikiLinkTarget,
} from "../shared/wiki-links";
import { cleanDisplayTitle } from "../app/editor/backlinks-panel";

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
});
