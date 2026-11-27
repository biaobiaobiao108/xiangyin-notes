import { describe, expect, test } from "bun:test";
import { Editor } from "@tiptap/core";
import { createReadOnlyExtensions } from "../app/editor/read-only-markdown";
import { isMermaidLanguage } from "../app/mermaid/protocol";
import {
  normalizeSvgColor,
  renderDiagram,
  resolveCssVars,
  resolveLightDark,
} from "../app/mermaid/render";
import { renderMemoMarkdown } from "../app/memos/memo-markdown";

const MERMAID_EXAMPLE = "flowchart TD\n  A[开始] --> B[完成]";

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

  test("the app renderer draws Chinese labels and omits links", async () => {
    const source = `${MERMAID_EXAMPLE}\nclick A "https://example.com"`;
    const layout = { width: 320, fontFamily: "sans-serif", fontFamilyMono: "monospace" };
    const { svg, width, height } = await renderDiagram(
      { ...layout, source },
      new AbortController().signal,
    );
    expect(svg).toContain("开始");
    expect(svg).toContain("完成");
    expect(svg).not.toContain("https://example.com");
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);

    const controller = new AbortController();
    const canceled = renderDiagram({ ...layout, source }, controller.signal);
    controller.abort(new Error("preview removed"));
    await expect(canceled).rejects.toThrow("preview removed");
  });

  test("resolves light-dark and CSS variables into standalone SVG colors", () => {
    expect(resolveLightDark("light-dark(#faf9f6, #1f2224)", true)).toBe("#1f2224");
    expect(resolveLightDark("light-dark(#faf9f6, #1f2224)", false)).toBe("#faf9f6");
    expect(resolveLightDark("light-dark(rgba(0, 0, 0, 0.1), rgba(255, 255, 255, 0.2))", true)).toBe(
      "rgba(255, 255, 255, 0.2)",
    );

    const vars = new Map<string, string>([
      ["--pele-bg", resolveLightDark("light-dark(#faf9f6, #1f2224)", true)],
      ["--pele-surface", resolveLightDark("light-dark(#f2efe8, #262a2c)", true)],
      ["--_bg", "var(--pele-bg,#fff)"],
      ["--_s", "var(--pele-surface,#f3f3f3)"],
    ]);
    expect(resolveCssVars("var(--_bg)", vars)).toBe("#1f2224");
    expect(resolveCssVars("var(--_s)", vars)).toBe("#262a2c");
    expect(resolveCssVars("var(--_r,4px)", vars)).toBe("4px");
    expect(normalizeSvgColor("rgba(78, 138, 110, 0.16)", "#1f2224")).toBe("#273330");
  });
});
