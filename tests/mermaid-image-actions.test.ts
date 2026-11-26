import { describe, expect, test } from "bun:test";
import {
  buildImageMenuItems,
  imageCopyGeometry,
  writeImageClipboard,
  type ClipboardItemConstructor,
} from "../app/image-actions";
import { buildMermaidExtraMenuItems, diagramCopyGeometry } from "../app/mermaid/image-actions";

function fakeClipboardItem(supported = true) {
  let created: { data: Record<string, Blob | Promise<Blob>> } | undefined;
  const Type = class {
    data: Record<string, Blob | Promise<Blob>>;
    static supports() {
      return supported;
    }
    constructor(data: Record<string, Blob | Promise<Blob>>) {
      this.data = data;
      created = this;
    }
  } as unknown as ClipboardItemConstructor;
  return { Type, created: () => created };
}

describe("Image actions", () => {
  test("builds exactly the copy and expand commands", async () => {
    const calls: string[] = [];
    const items = buildImageMenuItems("复制图片", {
      copy: () => {
        calls.push("copy");
      },
      expand: () => {
        calls.push("expand");
      },
    });

    expect(items.map((item) => item.label)).toEqual(["复制图片", "展开显示"]);
    await items[0]!.onSelect();
    await items[1]!.onSelect();
    expect(calls).toEqual(["copy", "expand"]);

    const mermaidItems = buildImageMenuItems(
      "复制为图片",
      {
        copy: () => {
          calls.push("copy-diagram");
        },
        expand: () => {
          calls.push("expand-diagram");
        },
      },
      buildMermaidExtraMenuItems(() => {
        calls.push("edit-source");
      }),
    );
    expect(mermaidItems.map((item) => item.label)).toEqual(["复制为图片", "展开显示", "编辑源码"]);
    expect(mermaidItems[2]!.separator).toBe(true);
    await mermaidItems[2]!.onSelect();
    expect(calls).toEqual(["copy", "expand", "edit-source"]);
  });

  test("adds paper padding at 2x and caps oversized diagrams", () => {
    expect(diagramCopyGeometry(100, 50)).toEqual({
      width: 264,
      height: 164,
      padding: 32,
      scale: 2,
    });

    const huge = diagramCopyGeometry(10_000, 10_000);
    expect(huge.width).toBeLessThanOrEqual(4096);
    expect(huge.height).toBeLessThanOrEqual(4096);
    expect(huge.width * huge.height).toBeLessThanOrEqual(16_000_000);
  });

  test("copies ordinary images at their original resolution", () => {
    expect(imageCopyGeometry(480, 320)).toEqual({
      width: 480,
      height: 320,
      padding: 0,
      scale: 1,
    });

    const huge = imageCopyGeometry(10_000, 10_000);
    expect(huge.width).toBeLessThanOrEqual(4096);
    expect(huge.height).toBeLessThanOrEqual(4096);
    expect(huge.width * huge.height).toBeLessThanOrEqual(16_000_000);
  });

  test("starts clipboard writing before the PNG promise resolves", async () => {
    let resolvePng!: (blob: Blob) => void;
    const png = new Promise<Blob>((resolve) => {
      resolvePng = resolve;
    });
    const item = fakeClipboardItem();
    let writeStarted = false;
    const result = writeImageClipboard(() => png, {
      ClipboardItemType: item.Type,
      clipboard: {
        async write(items) {
          writeStarted = true;
          expect(items).toHaveLength(1);
          expect(item.created()?.data["image/png"]).toBeInstanceOf(Promise);
        },
      },
    });

    expect(writeStarted).toBe(true);
    resolvePng(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));
    await result;
  });

  test("reports unsupported and denied image clipboard writes", async () => {
    await expect(
      writeImageClipboard(() => Promise.resolve(new Blob()), {
        ClipboardItemType: null,
        clipboard: { write: async () => {} },
      }),
    ).rejects.toThrow("当前浏览器不支持复制图片");

    const item = fakeClipboardItem();
    await expect(
      writeImageClipboard(() => Promise.resolve(new Blob()), {
        ClipboardItemType: item.Type,
        clipboard: {
          async write() {
            throw new DOMException("NotAllowedError");
          },
        },
      }),
    ).rejects.toThrow("浏览器未允许复制图片");
  });
});
