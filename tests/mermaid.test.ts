import { describe, expect, test } from "bun:test";
import { Editor } from "@tiptap/core";
import { createReadOnlyExtensions } from "../app/editor/read-only-markdown";
import { isMermaidLanguage, MERMAID_EXAMPLE } from "../app/mermaid/protocol";
import { renderMemoMarkdown } from "../app/memos/memo-markdown";
import { render } from "pele";

function parseMarkdown(markdown: string) {
  return new Editor({
    element: null,
    extensions: createReadOnlyExtensions(),
    content: markdown,
    contentType: "markdown",
  });
}

describe("Mermaid Markdown", () => {
  test("identifies Mermaid language markers without matching similarly named languages", () => {
    expect(isMermaidLanguage(" Mermaid sample ")).toBe(true);
    expect(isMermaidLanguage("mermaid-js")).toBe(false);
    expect(isMermaidLanguage(null)).toBe(false);
  });

  test("round-trips indented and nested Mermaid fences containing literal closing markers", () => {
    const source = [
      "  ~~~mermaid",
      `  ${MERMAID_EXAMPLE.replaceAll("\n", "\n  ")}`,
      "  ~~~",
      "",
      "- 一项",
      "  ~~~~MERMAID",
      "  flowchart TD",
      "",
      '    A["<资料> & #标签"] --> B[复查]',
      "  ```",
      "  ~~~~",
      "",
      "> ```mermaid",
      "> sequenceDiagram",
      ">   A->>B: 完成",
      "> ```",
      "",
      "```text",
      "保留普通代码",
      "```",
    ].join("\n");
    const document = parseMarkdown(source);
    try {
      const serialized = document.getMarkdown();
      const reopened = parseMarkdown(serialized);
      try {
        expect(document.state.doc.childCount).toBe(4);
        expect(document.state.doc.firstChild?.textContent).toBe(MERMAID_EXAMPLE);
        expect(document.state.doc.child(1).textContent).toContain("\n\n  A[");
        expect(reopened.getJSON()).toEqual(document.getJSON());
      } finally {
        reopened.destroy();
      }
    } finally {
      document.destroy();
    }
  });

  test("puts escaped Mermaid source in the memo's preview fallback", () => {
    const html = renderMemoMarkdown('```MERMAID\nflowchart TD\n A["<b>资料</b> & 文本"]\n```');
    expect(html).toContain("data-mermaid-preview");
    expect(html).toContain("查看源码");
    expect(html).toContain("&lt;b&gt;资料&lt;/b&gt; &amp; 文本");
    expect(renderMemoMarkdown("```mermaid-js\n普通代码\n```")).not.toContain(
      "data-mermaid-preview",
    );
  });

  test("the pinned renderer draws Chinese labels and applies the app's no-link policy", () => {
    const { svg, links } = render(`${MERMAID_EXAMPLE}\nclick A "https://example.com"`, {
      maxWidth: 320,
      links: false,
      images: false,
    });
    expect(svg).toContain("开始");
    expect(svg).toContain("完成");
    expect(svg).not.toContain("https://example.com");
    expect(links).toEqual([]);
  });
});
