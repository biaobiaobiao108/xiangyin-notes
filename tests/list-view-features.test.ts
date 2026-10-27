import { describe, expect, it } from "bun:test";
import {
  NOTE_DRAG_MIME_TYPE,
  createNoteDragGhost,
  registerDragOverGuard,
} from "../app/workspace/note-drag-drop";

describe("列表视图与卡片视图专属功能与拖拽交互", () => {
  it("生成符合象映笔记桌面规范的真实微缩卡片与 Card Stack 拖拽预览", () => {
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

      // 单选卡片预览
      const singleGhost = createNoteDragGhost("测试笔记", 1);
      expect(singleGhost.className).toBe("note-drag-ghost-shell");
      expect(singleGhost.innerHTML).toContain("测试笔记");
      expect(singleGhost.innerHTML).toContain("note-drag-card-top");
      expect(singleGhost.innerHTML).toContain("拖拽至侧栏以移动");
      expect(singleGhost.innerHTML).not.toContain("note-drag-stack-badge");
      singleGhost.remove();

      // 多选 Card Stack 层叠预览
      const multiGhost = createNoteDragGhost("孙笑川人物传记选题报告", 3);
      expect(multiGhost.innerHTML).toContain("孙笑川人物传记选题报告");
      expect(multiGhost.innerHTML).toContain("note-drag-card-layer");
      expect(multiGhost.innerHTML).toContain("note-drag-stack-badge");
      expect(multiGhost.innerHTML).toContain("3");
      expect(multiGhost.innerHTML).toContain("已多选 3 篇笔记");
      multiGhost.remove();
    } finally {
      (globalThis as unknown as { document?: unknown }).document = originalDocument;
    }
  });

  it("支持拖拽数据的标准 MIME 类型并提供全局 dragover 保护避免禁止光标", () => {
    expect(NOTE_DRAG_MIME_TYPE).toBe("application/x-xiangying-note-ids");

    const cleanup = registerDragOverGuard();
    expect(typeof cleanup).toBe("function");
    cleanup();
  });
});
