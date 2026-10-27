import { describe, expect, it } from "bun:test";
import { NOTE_DRAG_MIME_TYPE, createNoteDragGhost } from "../app/workspace/note-drag-drop";

describe("列表视图与卡片视图专属功能与拖拽交互", () => {
  it("生成符合象映笔记视觉规范的拖拽跟随卡片 Ghost", () => {
    const originalDocument = (globalThis as unknown as { document?: unknown }).document;
    try {
      (globalThis as unknown as { document: unknown }).document = {
        createElement: () => {
          const el: Record<string, unknown> = {
            className: "",
            style: {},
            innerHTML: "",
            remove() {},
          };
          return el;
        },
        body: {
          appendChild() {},
        },
      };

      const singleGhost = createNoteDragGhost("测试笔记", 1);
      expect(singleGhost.className).toBe("note-drag-ghost");
      expect(singleGhost.innerHTML).toContain("测试笔记");
      expect(singleGhost.innerHTML).not.toContain("note-drag-ghost-badge");
      singleGhost.remove();

      const multiGhost = createNoteDragGhost("长标题笔记测试长标题笔记", 3);
      expect(multiGhost.innerHTML).toContain("等 3 篇");
      expect(multiGhost.innerHTML).toContain("note-drag-ghost-badge");
      multiGhost.remove();
    } finally {
      (globalThis as unknown as { document?: unknown }).document = originalDocument;
    }
  });

  it("支持拖拽数据的标准 MIME 类型", () => {
    expect(NOTE_DRAG_MIME_TYPE).toBe("application/x-xiangying-note-ids");
  });
});
