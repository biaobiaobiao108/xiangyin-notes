import { describe, expect, test } from "bun:test";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { ImageNode } from "../app/editor/image-node";
import { createMarkdownExtension } from "../app/editor/markdown-config";
import {
  isExternalImageSource,
  normalizeImagesInEmptyListItems,
  parseImageSource,
  serializeImageSource,
} from "../app/image-markdown";

describe("image markdown helpers", () => {
  test("round-trips display dimensions while preserving other URL parts", () => {
    const source = "/api/assets/image.png?download=1#preview";
    const serialized = serializeImageSource(source, 480, 320);
    expect(serialized).toBe("/api/assets/image.png?download=1&w=480&h=320#preview");
    expect(parseImageSource(serialized)).toEqual({ src: source, width: 480, height: 320 });
  });

  test("preserves raw encoding in local query parameters when extracting display dimensions", () => {
    const source = "/api/image.png?download=a%2Fb&w=480&h=320&token=x+y";
    expect(parseImageSource(source)).toEqual({
      src: "/api/image.png?download=a%2Fb&token=x+y",
      width: 480,
      height: 320,
    });
  });

  test("preserves external image URLs and query strings byte-for-byte", () => {
    const source =
      "https://images.example/photo.png?signature=a%2Fb&w=original&h=auto&x=1+2#preview";
    expect(parseImageSource(source)).toEqual({ src: source, width: null, height: null });
    expect(serializeImageSource(source, 480, 320)).toBe(source);
  });

  test("preserves nonnumeric size parameters and encoding in local source queries", () => {
    const source = "/api/image.png?download=a%2Fb&w=original&h=auto&token=x+y";
    expect(parseImageSource(source)).toEqual({ src: source, width: null, height: null });
    expect(parseImageSource("/api/image.png?w=480&h=auto")).toEqual({
      src: "/api/image.png?w=480&h=auto",
      width: null,
      height: null,
    });
  });

  test("identifies remote image URLs while keeping uploaded asset paths local", () => {
    expect(isExternalImageSource("https://images.example/photo.png")).toBe(true);
    expect(isExternalImageSource("https:/images.example/photo.png")).toBe(true);
    expect(isExternalImageSource("//images.example/photo.png")).toBe(true);
    expect(isExternalImageSource("/api/assets/photo.png")).toBe(false);
    expect(isExternalImageSource("blob:https://app.example/image-id")).toBe(false);
  });

  test("parses an indented image after an empty list marker as an image node", () => {
    const source =
      "- **L4 技能库**：成功轨迹蒸馏为原子执行宏。\n- \n  ![images (2)](/api/assets/image.jpg?w=480&h=639)\n\n---";
    const editor = new Editor({
      extensions: [StarterKit, createMarkdownExtension(), ImageNode],
      content: normalizeImagesInEmptyListItems(source),
      contentType: "markdown",
    });

    try {
      const image = editor.state.doc.firstChild?.lastChild?.firstChild?.firstChild;
      expect(image?.type.name).toBe("image");
      expect(image?.attrs).toMatchObject({
        src: "/api/assets/image.jpg",
        alt: "images (2)",
        width: 480,
        height: 639,
      });
    } finally {
      editor.destroy();
    }
  });

  test("round-trips images in deeply nested empty list items", () => {
    const sourceEditor = new Editor({
      extensions: [StarterKit, createMarkdownExtension(), ImageNode],
      content: {
        type: "doc",
        content: [
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [
                  { type: "paragraph", content: [{ type: "text", text: "outer" }] },
                  {
                    type: "bulletList",
                    content: [
                      {
                        type: "listItem",
                        content: [
                          { type: "paragraph", content: [{ type: "text", text: "middle" }] },
                          {
                            type: "bulletList",
                            content: [
                              {
                                type: "listItem",
                                content: [
                                  { type: "paragraph" },
                                  {
                                    type: "image",
                                    attrs: {
                                      src: "/api/assets/image.jpg",
                                      alt: "deep",
                                      width: 480,
                                      height: 320,
                                    },
                                  },
                                ],
                              },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    });

    try {
      const markdown = (sourceEditor as Editor & { getMarkdown: () => string }).getMarkdown();
      expect(markdown).toContain("    - \n      ![deep]");
      const editor = new Editor({
        extensions: [StarterKit, createMarkdownExtension(), ImageNode],
        content: normalizeImagesInEmptyListItems(markdown),
        contentType: "markdown",
      });

      try {
        let image = editor.state.doc.firstChild;
        editor.state.doc.descendants((node) => {
          if (node.type.name === "image") image = node;
        });
        expect(image?.type.name).toBe("image");
        expect(image?.attrs).toMatchObject({ alt: "deep", width: 480, height: 320 });
      } finally {
        editor.destroy();
      }
    } finally {
      sourceEditor.destroy();
    }
  });

  test("round-trips escaped closing brackets and backslashes in image alt text", () => {
    const sourceEditor = new Editor({
      extensions: [StarterKit, createMarkdownExtension(), ImageNode],
      content: {
        type: "doc",
        content: [
          {
            type: "image",
            attrs: { src: "/api/assets/image.jpg", alt: "a]b \\c" },
          },
        ],
      },
    });

    try {
      const markdown = (sourceEditor as Editor & { getMarkdown: () => string }).getMarkdown();
      const editor = new Editor({
        extensions: [StarterKit, createMarkdownExtension(), ImageNode],
        content: markdown,
        contentType: "markdown",
      });

      try {
        let image = editor.state.doc.firstChild;
        editor.state.doc.descendants((node) => {
          if (node.type.name === "image") image = node;
        });
        expect(image?.attrs.alt).toBe("a]b \\c");
      } finally {
        editor.destroy();
      }
    } finally {
      sourceEditor.destroy();
    }
  });

  test("does not normalize image-like code inside fenced blocks", () => {
    const source = "```markdown\n- \n  ![image](/api/assets/image.jpg)\n```";
    expect(normalizeImagesInEmptyListItems(source)).toBe(source);
  });

  test("does not normalize image-like text in indented code blocks", () => {
    const source = "    - \n      ![image](/api/assets/image.jpg)";
    expect(normalizeImagesInEmptyListItems(source)).toBe(source);
  });
});
