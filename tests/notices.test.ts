import { expect, test } from "bun:test";
import { nextNotice, noticeDuration, type Notice } from "../app/workspace/use-notices";

const error: Notice = { id: 1, message: "保存失败，请重试", kind: "error" };
test("routine feedback cannot replace an active error", () => {
  expect(nextNotice(error, { id: 2, message: "已复制", kind: "info" })).toBe(error);
  expect(nextNotice(error, { id: 3, message: "请先保存", kind: "warning" })).toBe(error);
});
test("errors replace lesser notices while duplicate failures don't stack or restart", () => {
  expect(nextNotice({ id: 2, message: "已复制", kind: "info" }, error)).toBe(error);
  expect(nextNotice(error, { ...error, id: 3 })).toBe(error);
  const different = { ...error, id: 4, message: "创建失败，请重试" };
  expect(nextNotice(error, different)).toBe(different);
  expect(nextNotice(null, error)).toBe(error);
});
test("important and long notices allow enough reading time", () => {
  expect(noticeDuration(error)).toBe(10000);
  expect(noticeDuration({ ...error, kind: "warning" })).toBe(8000);
  expect(noticeDuration({ id: 2, kind: "info", message: "已复制" })).toBe(3500);
  expect(noticeDuration({ ...error, message: "长提示".repeat(100) })).toBe(15000);
});
