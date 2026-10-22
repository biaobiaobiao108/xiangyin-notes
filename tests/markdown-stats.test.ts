import { describe, expect, test } from "bun:test";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { countMarkdownStats } from "../shared/markdown-stats";
import { countTextStats } from "../shared/text-stats";
import { preserveEscapedHashtagsForEditor } from "../shared/tags";
import { encodeWikiLinkComponent } from "../shared/wiki-links";
import { countEditorText } from "../app/editor-metrics";
import { countEditorDocumentText } from "../app/editor-text-stats";
import { createMarkdownExtension } from "../app/editor/markdown-config";
import { CalloutNode } from "../app/editor/callout-node";
import { WikiLinkNode } from "../app/editor/wiki-link-node";
import { ImageNode } from "../app/editor/image-node";
import { createTableExtensions } from "../app/editor/table-extensions";

function countHeadlessDocument(markdown: string) {
  const editor = new Editor({
    element: null,
    extensions: [
      StarterKit,
      TaskList,
      TaskItem.configure({ nested: true }),
      ...createTableExtensions(),
      createMarkdownExtension(),
      CalloutNode,
      WikiLinkNode,
      ImageNode,
    ],
    content: markdown.trim()
      ? preserveEscapedHashtagsForEditor(markdown)
      : { type: "doc", content: [{ type: "paragraph" }] },
    contentType: "markdown",
  });
  try {
    return countEditorDocumentText(editor.state.doc, new WeakMap());
  } finally {
    editor.destroy();
  }
}

describe("shared text counting", () => {
  test("preserves the editor export and existing grapheme rules", () => {
    expect(countEditorText).toBe(countTextStats);
    expect(countTextStats("你好，cafe\u0301 42 👨‍👩‍👧‍👦！")).toEqual({
      wordCount: 5,
      characterCount: 11,
    });
    expect(countTextStats("  \n\t")).toEqual({ wordCount: 0, characterCount: 0 });
    expect(countTextStats("#\u2060标签 word\u2060run")).toEqual(countTextStats("#标签 wordrun"));
    expect(countTextStats("🇨🇳🇺🇸1️⃣2️⃣")).toEqual({ wordCount: 4, characterCount: 4 });
  });
});

describe("Markdown statistics", () => {
  test.each([
    "",
    " \n\t ",
    "# 标题\n\n正文 **判断：**已知人物。",
    "你好 cafe\u0301 👨‍👩‍👧‍👦 ✨ 123",
    "one**two**three\n\nfour",
    "- 第一项\n  - 子项\n- [x] done\n- [ ] pending",
    "> 引用\n>\n> 第二段\n\n> [!TIP]\n> **提示：**中文\n>\n> - 列表",
    "`**bold** &amp; <div>`\n\n```md\n# literal\n![alt](url)\n&lt; &amp;\n```",
    "    indented **code**\n    <span>literal</span>",
    "| 表头 | Second |\n| --- | --- |\n| **内容** | [label](https://example.com/path) |",
    '[显示文字](https://example.com/very-long-url "标题") [引用][ref]\n\n[ref]: https://example.com/reference',
    "[[目标]] [[目标|显示别名]] 【【目标｜别名】】",
    `[[${encodeWikiLinkComponent("含]分隔符")}|${encodeWikiLinkComponent("含]别名", "alias")}]]`,
    "![图片说明不计](https://example.com/image.png)",
    "before ![alt](https://example.com/image.png) after",
    "&lt; &gt; &quot; &amp; &amp;lt; &#65; &nbsp;",
    "\\#标签 \\*文字\\* #真实标签",
    "one  \ntwo\nthree\n\n---",
  ])("agrees with the editor document for %j", (markdown) => {
    const actual = countMarkdownStats(markdown);
    const editor = countHeadlessDocument(markdown);
    expect(actual.textCharacterCount).toBe(editor.characterCount);
    expect(actual.wordCount).toBe(editor.wordCount);
    expect(actual.markdownCharacterCount).toBe(Array.from(markdown).length);
  });

  test("counts raw code points including syntax and whitespace separately", () => {
    const markdown = "# e\u0301 😀\n";
    expect(countMarkdownStats(markdown)).toEqual({
      markdownCharacterCount: 7,
      textCharacterCount: 2,
      wordCount: 2,
    });
  });

  test("counts wiki-link display names and excludes image descriptions and URLs", () => {
    expect(
      countMarkdownStats("[[long target|别名]]\n\n![说明](https://example.com/p.png)"),
    ).toMatchObject({ textCharacterCount: 2, wordCount: 2 });
  });

  // Browser HTML uses a DOM parser; a headless Tiptap editor deliberately keeps
  // HTML literal. These test the server HTML parser policy independently.
  test.each([
    ["<p>Hello <b>world</b></p><p>你好</p>", "Hello world\n你好"],
    ["<span>A &amp; B &#65; &nbsp; &copy; &amp;lt;</span>", "A & B A \u00a0 © &lt;"],
    ['<p>a<img src="x" alt="description">b</p>', "a\nb"],
    ["<div>before<script>not counted</script><style>.hidden{}</style>after</div>", "beforeafter"],
    ["<span>a<!-- comment -->b</span>", "ab"],
    ["<enter foo bar>", "<enter foo bar>"],
    ["<p>**literal markup**</p>", "**literal markup**"],
    ["<span>e\u0301 &quot;quoted&quot;</span>", 'e\u0301 "quoted"'],
  ])("extracts text from HTML token %j", (markdown, text) => {
    const expected = countTextStats(text);
    expect(countMarkdownStats(markdown)).toMatchObject({
      textCharacterCount: expected.characterCount,
      wordCount: expected.wordCount,
    });
  });

  test("keeps inline HTML adjacent text in the same word", () => {
    expect(countMarkdownStats("one<b>two</b>three")).toMatchObject({
      textCharacterCount: 11,
      wordCount: 1,
    });
  });

  test("handles runs of unclosed inline tags without counting their markup", () => {
    expect(countMarkdownStats(`text${"<span>".repeat(1000)}`)).toMatchObject({
      textCharacterCount: 4,
      wordCount: 1,
    });
  });
});
