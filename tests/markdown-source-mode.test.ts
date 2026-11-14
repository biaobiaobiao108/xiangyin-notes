import { describe, expect, test } from "bun:test";
import {
  markdownSourceModeNotice,
  markdownSourceModeReason,
  RICH_MARKDOWN_MAX_CHARACTERS,
} from "../app/editor/markdown-source-mode";

describe("Markdown source mode detection", () => {
  test("keeps ordinary Markdown and app-generated markup in the rich editor", () => {
    expect(markdownSourceModeReason("# 标题\n\n正文 **加粗** 与 [[双链]]")).toBeNull();
    expect(
      markdownSourceModeReason(
        '正文 <mark data-color="yellow">高亮</mark> 与 <span data-annotation-id="a1">批注</span>',
      ),
    ).toBeNull();
    expect(markdownSourceModeReason("访问 <https://example.com> 和 <mailto:a@b.com>")).toBeNull();
  });

  test("routes unsupported syntax to source mode", () => {
    expect(markdownSourceModeReason("---\ntitle: 测试\n---\n\n正文")).toBe("frontmatter");
    expect(markdownSourceModeReason("正文[^1]\n\n[^1]: 脚注")).toBe("footnote");
    expect(markdownSourceModeReason("[docs]: https://example.com\n\n查看 [docs]。")).toBe(
      "reference-link",
    );
    expect(markdownSourceModeReason("前文 <div>块</div> 后文")).toBe("html");
    expect(markdownSourceModeReason("前文 <br> 后文")).toBe("html");
  });

  test("routes very large documents to source mode", () => {
    expect(markdownSourceModeReason("a".repeat(RICH_MARKDOWN_MAX_CHARACTERS + 1))).toBe("large");
    expect(markdownSourceModeReason("a".repeat(RICH_MARKDOWN_MAX_CHARACTERS))).toBeNull();
  });

  test("has a user-facing notice for every reason", () => {
    expect(markdownSourceModeNotice("frontmatter")).toContain("frontmatter");
    expect(markdownSourceModeNotice("large")).toContain("源码模式");
    expect(markdownSourceModeNotice(null)).toBe("");
  });
});
