import { describe, expect, test } from "bun:test";
import { safeTextBoundary } from "../app/image-export/pagination";

describe("图片分页文本边界", () => {
  test("中文和表情分页不会拆开 UTF-16 代理对", () => {
    const text = "笔记😀正文📝结束";
    for (let requested = 0; requested <= text.length; requested++) {
      const boundary = safeTextBoundary(text, requested);
      const first = text.slice(0, boundary);
      const last = text.slice(boundary);
      expect(first + last).toBe(text);
      expect(first).not.toMatch(/[\uD800-\uDBFF]$/);
      expect(last).not.toMatch(/^[\uDC00-\uDFFF]/);
    }
  });

  test("边界超出文本时限制在完整文本范围内", () => {
    expect(safeTextBoundary("正文", -5)).toBe(0);
    expect(safeTextBoundary("正文", 99)).toBe(2);
    expect(safeTextBoundary("正文", 1)).toBe(1);
  });
});
