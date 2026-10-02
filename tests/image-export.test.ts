import { describe, expect, test } from "bun:test";
import { imageExportFilename } from "../app/image-export/filename";
import { collectExportArchive } from "../app/image-export/stream";
import { createSnapshotEditor, waitForExport } from "../app/image-export/render";

describe("image export", () => {
  test("preserves Chinese filenames and removes path/control characters", () => {
    expect(imageExportFilename('标题/副题:示例\n', 1)).toBe("标题_副题_示例_-002.png");
    expect(imageExportFilename(" . ")).toBe("未命名笔记.png");
    expect(imageExportFilename("标题")).toBe("标题.png");
  });
  test("snapshot parser preserves note structures without mounting an editor", () => {
    const editor = createSnapshotEditor('中文 **强调**\n\n- [x] 完成\n- [ ] 待办\n\n> [!NOTE]\n> 提示\n\n| 列一 | 列二 |\n| --- | --- |\n| 内容 | 示例 |\n\n```ts\nconst a = 1;\n```\n\n![图片](/api/assets/example#width=300&height=200)\n\n[[其他笔记|别名]]');
    try {
      const json = editor.getJSON();
      const types = json.content!.map((node) => node.type);
      expect(types).toContain("taskList"); expect(types).toContain("callout");
      expect(types).toContain("table"); expect(types).toContain("codeBlock");
      expect(types).toContain("image");
      expect(JSON.stringify(json)).toContain('"type":"wikiLink"');
      expect(JSON.stringify(json)).toContain('"type":"bold"');
      expect(editor.options.element).toBeNull();
    } finally { editor.destroy(); }
  });
  test("abort stops waiting for pending image or font decoding", async () => {
    const controller = new AbortController();
    const result = waitForExport(new Promise<void>(() => {}), controller.signal);
    controller.abort();
    await expect(result).rejects.toHaveProperty("name", "AbortError");
  });
  test("archive byte collection preserves data and rejects over its memory bound", async () => {
    const stream = () => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.close(); } });
    const blob = await collectExportArchive(stream(), new AbortController().signal, 3);
    expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual([1, 2, 3]);
    await expect(collectExportArchive(stream(), new AbortController().signal, 2)).rejects.toThrow("128 MiB");
  });
  test("archive cancellation releases a pending reader", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const controller = new AbortController();
    const result = collectExportArchive(stream, controller.signal, 100);
    controller.abort();
    await expect(result).rejects.toHaveProperty("name", "AbortError");
    expect(cancelled).toBe(true);
    expect(stream.locked).toBe(false);
  });
});
