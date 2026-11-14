import { describe, expect, test } from "bun:test";
import { renderMemoMarkdown } from "../app/memos/memo-markdown";

describe("memo Markdown rendering", () => {
  test("renders supported Markdown without an editor instance", () => {
    const html = renderMemoMarkdown("**加粗** 与 `代码`\n\n- 一项\n- 两项");
    expect(html).toContain("<strong>加粗</strong>");
    expect(html).toContain("<code>代码</code>");
    expect(html).toContain("<li>一项</li>");
  });

  test("escapes raw HTML and blocks unsafe link protocols", () => {
    const html = renderMemoMarkdown(
      "<script>alert(1)</script>\n\n[危险](javascript:alert(1))\n\n[正常](https://example.com)",
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  test("never auto-loads external images", () => {
    const external = renderMemoMarkdown("![外站](https://example.com/a.png)");
    expect(external).not.toContain("<img");
    expect(external).toContain("memo-image-placeholder");

    const internal = renderMemoMarkdown(
      "![本地](/api/assets/00000000-0000-4000-8000-000000000000)",
    );
    expect(internal).toContain("<img");
    expect(internal).toContain('loading="lazy"');
  });

  test("renders body hashtags with the memo tag treatment", () => {
    const html = renderMemoMarkdown("今天 #工作，明天 #读书。");
    expect(html).toContain('<span class="memo-tag">#工作</span>');
    expect(html).toContain('<span class="memo-tag">#读书</span>');
  });

  test("does not tag code, URL fragments, image alt text, or escaped hashtags", () => {
    const html = renderMemoMarkdown(
      "`#code` https://example.com/a#fragment ![#alt](https://example.com/a.png) \\#escaped",
    );
    expect(html).not.toContain("memo-tag");
  });
});
