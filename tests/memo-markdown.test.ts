import { describe, expect, test } from "bun:test";
import { renderMemoMarkdown } from "../app/memos/memo-markdown";

describe("memo Markdown rendering", () => {
  test("renders supported Markdown without an editor instance", () => {
    const html = renderMemoMarkdown("**加粗** 与 `代码`\n\n- 一项\n- 两项");
    expect(html).toContain("<strong>加粗</strong>");
    expect(html).toContain("<code>代码</code>");
    expect(html).toContain("<li>一项</li>");
  });

  test("preserves additional empty paragraphs before Mermaid or other blocks", () => {
    const html = renderMemoMarkdown(
      "第一段 \r\n\r\n第二段 \r\n\r\n\r\n\r\n\\`\\`\\`mermaid\r\n\r\n```mermaid\r\nflowchart TD\r\n\r\n  A --> B\r\n```\r\n\r\n",
    );
    expect(html.match(/<p><br><\/p>/gu)).toHaveLength(1);
    expect(html).toContain("<p>第二段 </p>\n<p><br></p>\n<p>```mermaid</p>");
    expect(html).toContain("<code>flowchart TD\n\n  A --&gt; B\n</code>");
  });

  test("preserves the editor's explicit empty paragraph markers without escaping them as text", () => {
    const html = renderMemoMarkdown("上方\n\n\n\n&nbsp;\n\n\u00a0\n\n下方");
    expect(html).toBe("<p>上方</p>\n<p><br></p>\n<p><br></p>\n<p><br></p>\n<p>下方</p>\n");
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

  test("blocks unsafe link protocols split by control characters", () => {
    const html = renderMemoMarkdown("[危险](<java\tscript:alert(1)>)");
    expect(html).not.toContain('href="java');
    expect(html).not.toContain("javascript:");
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

  test("does not render Markdown titles as hover tooltips", () => {
    const html = renderMemoMarkdown(
      '[链接](https://example.com "链接标题") ![图片](/api/assets/00000000-0000-4000-8000-000000000000 "图片标题")',
    );
    expect(html).not.toContain(" title=");
    expect(html).not.toContain("链接标题");
    expect(html).not.toContain("图片标题");
  });

  test("renders body hashtags with the memo tag treatment", () => {
    const html = renderMemoMarkdown("今天 #工作，明天 #读书。");
    expect(html).toContain('<span class="memo-tag">#工作</span>');
    expect(html).toContain('<span class="memo-tag">#读书</span>');
  });

  test("renders UUID wiki links by their label or alias", () => {
    const html = renderMemoMarkdown(
      "参考 [[11111111-1111-4111-8111-111111111111|目标笔记]] 与 [[22222222-2222-4222-8222-222222222222|技术架构|架构设计]]",
    );
    expect(html).toContain('<span class="editor-wiki-link">目标笔记</span>');
    expect(html).toContain('<span class="editor-wiki-link">架构设计</span>');
    expect(html).not.toContain("【【");
  });

  test("uses the same task list structure as the note editor", () => {
    const html = renderMemoMarkdown("- [ ] 未完成\n- [x] 已完成 **重点**");
    expect(html).toContain('<ul data-type="taskList">');
    expect(html).toContain('<li data-checked="false" data-type="taskItem">');
    expect(html).toContain('<li data-checked="true" data-type="taskItem">');
    expect(html).toContain('type="checkbox" disabled');
    expect(html).toContain("<div><p>已完成 <strong>重点</strong></p></div>");
    expect(html).not.toContain("**重点**");
  });

  test("wraps tables in the note table scroll shell", () => {
    const html = renderMemoMarkdown("| 列一 | 列二 |\n| --- | --- |\n| 内容 | 示例 |");
    expect(html).toContain('<div class="table-scroll-shell"><table>');
    expect(html).toContain("<tbody>");
    expect(html).not.toContain("<thead>");
    expect(html).toContain("<th>列一</th>");
  });

  test("keeps the editor's saved column widths in preview", () => {
    const html = renderMemoMarkdown(
      "| 列一 | 列二 |\n| ------------- | -------------------- |\n| 内容 | 示例 |",
    );
    expect(html).toContain('<table style="width: 276px">');
    expect(html).toContain(
      '<colgroup><col style="width: 96px"><col style="width: 180px"></colgroup>',
    );
  });

  test("adds display breaks to long runs without changing their contents", () => {
    const hash = "0123456789abcdef".repeat(4);
    const html = renderMemoMarkdown(
      `hash = ${hash}\n\n~~~ts\nconst result = computeTotalPrice();\nhash = ${hash}\n~~~`,
    );
    expect(html.match(new RegExp(`<span class="long-text-run">${hash}</span>`, "gu"))).toHaveLength(
      2,
    );
    expect(html).toContain("const result = computeTotalPrice();");
  });

  test("labels fenced code blocks like the note editor", () => {
    const html = renderMemoMarkdown("```ts\nconst value = 1;\n```");
    expect(html).toContain('<span class="code-block-language" aria-hidden="true">ts</span>');
    expect(html).toContain('<code class="language-ts">const value = 1;');
    expect(html).toContain('class="code-block-copy-button"');
    expect(html).toContain('aria-label="复制代码"');
  });

  test("does not tag code, URL fragments, image alt text, or escaped hashtags", () => {
    const html = renderMemoMarkdown(
      "`#code` https://example.com/a#fragment ![#alt](https://example.com/a.png) \\#escaped",
    );
    expect(html).not.toContain("memo-tag");
  });
});
