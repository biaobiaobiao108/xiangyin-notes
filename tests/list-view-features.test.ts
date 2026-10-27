import { describe, expect, it } from "bun:test";
import {
  NOTE_DRAG_MIME_TYPE,
  hasNoteDragType,
  registerDragOverGuard,
  setNoteDragImage,
} from "../app/workspace/note-drag-drop";

describe("列表视图与卡片视图专属功能与拖拽交互", () => {
  it("单篇使用原生预览，多篇使用笔记副本和数量标记", () => {
    const originalDocument = globalThis.document;
    const originalFrame = globalThis.requestAnimationFrame;
    const children: Array<{ className?: string; textContent?: string }> = [];
    const wrapper = {
      className: "",
      style: {} as Record<string, string>,
      appendChild: (child: object) => children.push(child),
      remove() {},
    };
    const source = {
      getBoundingClientRect: () => ({ width: 300, height: 100 }),
      cloneNode: () => ({ classList: { add() {}, remove() {} }, style: {} }),
    } as unknown as HTMLElement;
    let imageCount = 0;
    const transfer = {
      setDragImage: () => {
        imageCount++;
      },
    } as unknown as DataTransfer;
    (globalThis as unknown as { document: unknown }).document = {
      createElement: (tag: string) => (tag === "div" ? wrapper : {}),
      body: { appendChild() {} },
    };
    globalThis.requestAnimationFrame = () => 1;
    try {
      setNoteDragImage(transfer, source, 1);
      expect(imageCount).toBe(0);
      setNoteDragImage(transfer, source, 4);
      expect(imageCount).toBe(1);
      expect(children).toHaveLength(4);
      expect(children[3]?.textContent).toBe("4");
    } finally {
      (globalThis as unknown as { document: unknown }).document = originalDocument;
      globalThis.requestAnimationFrame = originalFrame;
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
