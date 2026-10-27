import { describe, expect, it } from "bun:test";
import {
  NOTE_DRAG_MIME_TYPE,
  createNoteDragGhost,
  hasNoteDragType,
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

    // 验证不同环境下的 DataTransfer.types 识别
    const arrayDt = { types: [NOTE_DRAG_MIME_TYPE] } as unknown as DataTransfer;
    expect(hasNoteDragType(arrayDt)).toBe(true);

    const domListDt = {
      types: {
        contains: (v: string) => v === NOTE_DRAG_MIME_TYPE,
      },
    } as unknown as DataTransfer;
    expect(hasNoteDragType(domListDt)).toBe(true);

    const emptyDt = { types: [] } as unknown as DataTransfer;
    expect(hasNoteDragType(emptyDt)).toBe(false);
  });

  it("在捕获阶段接受笔记拖拽并在卸载时移除监听器", () => {
    const originalWindow = globalThis.window;
    const target = new EventTarget();
    (globalThis as unknown as { window: unknown }).window = target;
    try {
      const cleanup = registerDragOverGuard();
      // 单独派发可取消的事件，验证守卫只处理本应用的拖拽。
      const event = new Event("dragover", { cancelable: true });
      Object.defineProperty(event, "dataTransfer", {
        value: { types: [NOTE_DRAG_MIME_TYPE], dropEffect: "none" },
      });
      target.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect((event as DragEvent).dataTransfer?.dropEffect).toBe("move");
      const unrelated = new Event("dragenter", { cancelable: true });
      Object.defineProperty(unrelated, "dataTransfer", { value: { types: ["text/plain"] } });
      target.dispatchEvent(unrelated);
      expect(unrelated.defaultPrevented).toBe(false);
      cleanup();
      const afterCleanup = new Event("dragover", { cancelable: true });
      Object.defineProperty(afterCleanup, "dataTransfer", {
        value: { types: [NOTE_DRAG_MIME_TYPE] },
      });
      target.dispatchEvent(afterCleanup);
      expect(afterCleanup.defaultPrevented).toBe(false);
    } finally {
      (globalThis as unknown as { window: unknown }).window = originalWindow;
    }
  });
});
