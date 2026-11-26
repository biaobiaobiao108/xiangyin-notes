import { describe, expect, test } from "bun:test";
import {
  buildDiagramImageMenuItems,
  diagramCopyGeometry,
  writeDiagramClipboard,
  type ClipboardItemConstructor,
} from "../app/mermaid/image-actions";

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

describe("Mermaid image actions", () => {
  test("builds exactly the copy and expand commands", async () => {
    const calls: string[] = [];
    const items = buildDiagramImageMenuItems({
      copy: () => {
        calls.push("copy");
      },
      expand: () => {
        calls.push("expand");
      },
    });

    expect(items.map((item) => item.label)).toEqual(["复制为图片", "展开显示"]);
    await items[0]!.onSelect();
    await items[1]!.onSelect();
    expect(calls).toEqual(["copy", "expand"]);
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

  test("starts clipboard writing before the PNG promise resolves", async () => {
    let resolvePng!: (blob: Blob) => void;
    const png = new Promise<Blob>((resolve) => {
      resolvePng = resolve;
    });
    const item = fakeClipboardItem();
    let writeStarted = false;
    const result = writeDiagramClipboard(() => png, {
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
      writeDiagramClipboard(() => Promise.resolve(new Blob()), {
        ClipboardItemType: null,
        clipboard: { write: async () => {} },
      }),
    ).rejects.toThrow("当前浏览器不支持复制图片");

    const item = fakeClipboardItem();
    await expect(
      writeDiagramClipboard(() => Promise.resolve(new Blob()), {
        ClipboardItemType: item.Type,
        clipboard: {
          async write() {
            throw new DOMException("NotAllowedError");
          },
        },
      }),
    ).rejects.toThrow("浏览器未允许复制图表图片");
  });
});
