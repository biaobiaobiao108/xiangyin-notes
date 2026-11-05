import { describe, expect, test } from "bun:test";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { createMarkdownExtension } from "../app/editor/markdown-config";
import {
  AnnotationBadgeExtension,
  createAnnotationBadgeDecorations,
  annotationIdsInRange,
  collectAnnotations,
  NoteAnnotation,
  NoteHighlight,
} from "../app/editor/highlight-annotation";
import { formatPreview } from "../server/core";
import { countMarkdownStats } from "../shared/markdown-stats";
import { extractTags } from "../shared/tags";
import { extractWikiLinks } from "../shared/wiki-links";

function createEditor(markdown: string) {
  return new Editor({
    extensions: [StarterKit, createMarkdownExtension(), NoteHighlight, NoteAnnotation],
    content: markdown,
    contentType: "markdown",
  });
}

function serialized(editor: Editor) {
  return (editor as Editor & { getMarkdown: () => string }).getMarkdown();
}

describe("colored highlights", () => {
  test("round-trips all six preset colors", () => {
    const source = [
      '<mark data-color="amber">琥珀</mark>',
      '<mark data-color="sage">草木</mark>',
      '<mark data-color="sky">雾蓝</mark>',
      '<mark data-color="rose">胭脂</mark>',
      '<mark data-color="lilac">紫藤</mark>',
      '<mark data-color="sand">麦沙</mark>',
    ].join(" ");
    const editor = createEditor(source);
    try {
      expect(serialized(editor)).toBe(source);
      const colors: string[] = [];
      editor.state.doc.descendants((node) => {
        const mark = node.marks.find((candidate) => candidate.type.name === "noteHighlight");
        if (mark) colors.push(mark.attrs.color);
      });
      expect(colors).toEqual(["amber", "sage", "sky", "rose", "lilac", "sand"]);
    } finally {
      editor.destroy();
    }
  });

  test("keeps inline formatting nested inside a highlight", () => {
    const source = '<mark data-color="rose">红色 **粗体** 与 *斜体*</mark>';
    const editor = createEditor(source);
    try {
      expect(serialized(editor)).toBe(source);
      const first = editor.state.doc.firstChild?.firstChild;
      expect(first?.marks.some((mark) => mark.type.name === "noteHighlight")).toBe(true);
    } finally {
      editor.destroy();
    }
  });

  test("accepts a plain mark element as the default amber highlight", () => {
    const editor = createEditor("<mark>普通高亮</mark>");
    try {
      const mark = editor.state.doc.firstChild?.firstChild?.marks.find(
        (candidate) => candidate.type.name === "noteHighlight",
      );
      expect(mark?.attrs.color).toBe("amber");
      expect(serialized(editor)).toBe('<mark data-color="amber">普通高亮</mark>');
    } finally {
      editor.destroy();
    }
  });
});

describe("annotations", () => {
  test("round-trips escaped note text and preserves one annotation across blocks", () => {
    const id = "9f2c50de-9c9c-4c88-a76f-a629a1ed5a3d";
    const source = `<span data-annotation-id="${id}" data-note="第一行&#10;第二行 &quot;引用&quot; &lt;标签&gt; &amp; 注解">跨段批注</span>\n\n<span data-annotation-id="${id}" data-note="第一行&#10;第二行 &quot;引用&quot; &lt;标签&gt; &amp; 注解">继续</span>`;
    const editor = createEditor(source);
    try {
      expect(serialized(editor)).toBe(source);
      const annotations = collectAnnotations(editor.state.doc);
      expect(annotations).toHaveLength(1);
      expect(annotations[0]?.note).toBe('第一行\n第二行 "引用" <标签> & 注解');
      expect(annotations[0]?.quote).toBe("跨段批注 继续");
    } finally {
      editor.destroy();
    }
  });

  test("keeps nested highlights and bold text inside an annotation", () => {
    const source =
      '<span data-annotation-id="a1" data-note="说明">前文 <mark data-color="sky">**雾蓝**</mark></span>';
    const editor = createEditor(source);
    try {
      expect(serialized(editor)).toBe(source);
      const annotation = collectAnnotations(editor.state.doc)[0];
      expect(annotation?.note).toBe("说明");
      expect(annotation?.quote).toBe("前文 雾蓝");
    } finally {
      editor.destroy();
    }
  });

  test("reports every annotation touched by a selection", () => {
    const source =
      '<span data-annotation-id="a1" data-note="甲">第一段</span><span data-annotation-id="a2" data-note="乙">第二段</span>';
    const editor = createEditor(source);
    try {
      const positions: Array<{ id: string; from: number; to: number }> = [];
      editor.state.doc.descendants((node, position) => {
        if (!node.isText) return;
        const mark = node.marks.find((candidate) => candidate.type.name === "noteAnnotation");
        if (mark?.attrs.id) positions.push({ id: mark.attrs.id, from: position, to: position + 1 });
      });
      const [first, second] = positions;
      expect(annotationIdsInRange(editor.state.doc, first!.from, first!.to)).toEqual(["a1"]);
      expect(annotationIdsInRange(editor.state.doc, second!.from, second!.to)).toEqual(["a2"]);
      expect(annotationIdsInRange(editor.state.doc, first!.from, second!.to).sort()).toEqual([
        "a1",
        "a2",
      ]);
    } finally {
      editor.destroy();
    }
  });
});

describe("annotation metadata does not leak into derived Markdown data", () => {
  const markdown =
    '<span data-annotation-id="a1" data-note="#隐藏标签 [[隐藏链接]]" data-note-extra="#另一个">正文 #真实标签</span>';

  test("preview and statistics only count visible text", () => {
    expect(formatPreview(markdown)).toBe("正文 #真实标签");
    const stats = countMarkdownStats(markdown);
    expect(stats.textCharacterCount).toBe(7);
  });

  test("preview strips annotations even when the scan window cuts inside a tag", () => {
    const source = `<span data-annotation-id="a1" data-note="短批注">第二条批注</span>应该显示在右侧，并且<span data-annotation-id="a2" data-note="${"另一条很长的批注".repeat(30)}">内容可以编辑</span>。`;
    const truncated = source.slice(0, 120);
    expect(formatPreview(truncated)).toBe("第二条批注应该显示在右侧，并且");
  });

  test("tags and wiki links ignore HTML attribute values", () => {
    expect(extractTags(markdown)).toEqual(["真实标签"]);
    expect(extractWikiLinks(markdown)).toEqual([]);
  });
});

describe("annotation inline badges", () => {
  test("creates widget decorations at annotation end positions with 1-based sequential indices", () => {
    const source =
      '<span data-annotation-id="a1" data-note="批注一">第一处批注</span>后续正文<span data-annotation-id="a2" data-note="批注二">第二处批注</span>';
    const editor = new Editor({
      extensions: [StarterKit, createMarkdownExtension(), NoteAnnotation, AnnotationBadgeExtension],
      content: source,
      contentType: "markdown",
    });
    try {
      const decorations = createAnnotationBadgeDecorations(editor.state.doc);
      const widgets = decorations.find();
      expect(widgets).toHaveLength(2);
      expect(widgets[0]?.spec.key).toBe("annotation-badge-a1");
      expect(widgets[0]?.spec.side).toBe(-1);
      expect(widgets[1]?.spec.key).toBe("annotation-badge-a2");
      expect(widgets[1]?.spec.side).toBe(-1);

      const mockDoc = {
        createElement: () => {
          const el = {
            className: "",
            dataset: {} as Record<string, string>,
            children: [] as any[],
            setAttribute(k: string, v: string) {
              (this as any)[k] = v;
            },
            appendChild(c: any) {
              this.children.push(c);
            },
          };
          return el;
        },
      };

      const originalDocument = globalThis.document;
      try {
        (globalThis as unknown as { document: unknown }).document = mockDoc;
        const badge1 = (widgets[0] as unknown as { type: { toDOM: () => any } }).type.toDOM();
        expect(badge1.className).toBe("annotation-badge");
        expect(badge1.dataset.annotationId).toBe("a1");
        expect(badge1.children[0].textContent).toBe("1");

        const badge2 = (widgets[1] as unknown as { type: { toDOM: () => any } }).type.toDOM();
        expect(badge2.className).toBe("annotation-badge");
        expect(badge2.dataset.annotationId).toBe("a2");
        expect(badge2.children[0].textContent).toBe("2");
      } finally {
        (globalThis as unknown as { document: unknown }).document = originalDocument;
      }
    } finally {
      editor.destroy();
    }
  });
});
