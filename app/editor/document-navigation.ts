type BoundaryKey = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "isComposing" | "keyCode" | "defaultPrevented" | "preventDefault">;

// Home / End 浏览整篇笔记；带修饰键的光标移动与选择交给输入控件。
export function scrollNoteBoundary(event: BoundaryKey, target: Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight">): boolean {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229
    || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
  if (event.key !== "Home" && event.key !== "End") return false;
  event.preventDefault();
  target.scrollTop = event.key === "Home" ? 0 : Math.max(0, target.scrollHeight - target.clientHeight);
  return true;
}
