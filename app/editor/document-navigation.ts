type BoundaryKey = Pick<
  KeyboardEvent,
  | "key"
  | "ctrlKey"
  | "metaKey"
  | "altKey"
  | "shiftKey"
  | "isComposing"
  | "keyCode"
  | "defaultPrevented"
  | "preventDefault"
>;

type DocumentScrollTarget = Pick<HTMLElement, "scrollHeight" | "clientHeight" | "scrollTop"> & {
  scrollTo(options: { top: number; behavior: ScrollBehavior }): void;
};

// 这些按键浏览整篇笔记；带修饰键的光标移动与选择交给输入控件。
export function scrollNoteNavigation(
  event: BoundaryKey,
  target: DocumentScrollTarget,
  behavior: ScrollBehavior = "smooth",
): boolean {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.keyCode === 229 ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.shiftKey
  )
    return false;
  const isDocumentNavigation =
    event.key === "Home" ||
    event.key === "End" ||
    event.key === "PageUp" ||
    event.key === "PageDown";
  if (!isDocumentNavigation) return false;

  const maxScroll = Math.max(0, target.scrollHeight - target.clientHeight);
  const scrollTop =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? maxScroll
        : target.scrollTop + (event.key === "PageUp" ? -1 : 1) * target.clientHeight * 0.85;
  event.preventDefault();
  target.scrollTo({
    top: Math.min(maxScroll, Math.max(0, scrollTop)),
    behavior,
  });
  return true;
}
