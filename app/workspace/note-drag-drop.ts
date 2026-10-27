export const NOTE_DRAG_MIME_TYPE = "application/x-xiangying-note-ids";

/**
 * 检查 DataTransfer 中是否包含象映笔记专有的拖拽 MIME 类型。
 * 兼容 DOMStringList.contains 与 Array.includes。
 */
export function hasNoteDragType(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer || !dataTransfer.types) return false;
  const types = dataTransfer.types as unknown as {
    includes?: (value: string) => boolean;
    contains?: (value: string) => boolean;
    length?: number;
  };
  if (typeof types.contains === "function" && types.contains(NOTE_DRAG_MIME_TYPE)) {
    return true;
  }
  if (typeof types.includes === "function" && types.includes(NOTE_DRAG_MIME_TYPE)) {
    return true;
  }
  return Array.from(dataTransfer.types).some(
    (t) => t === NOTE_DRAG_MIME_TYPE || t.toLowerCase() === NOTE_DRAG_MIME_TYPE,
  );
}

export function setNoteDragImage(dataTransfer: DataTransfer, source: HTMLElement, count: number) {
  if (count <= 1) return;
  const wrapper = document.createElement("div");
  wrapper.className = "note-drag-ghost-shell";
  const bounds = source.getBoundingClientRect();
  wrapper.style.width = `${Math.min(bounds.width, 280) + 28}px`;
  for (let index = Math.min(count, 3) - 1; index >= 0; index--) {
    const card = source.cloneNode(true) as HTMLElement;
    card.classList.remove("is-dragging");
    card.classList.add("note-drag-copy");
    card.style.width = `${Math.min(bounds.width, 280)}px`;
    card.style.transform = `translate(${index * 5}px, ${index * 5}px)`;
    wrapper.appendChild(card);
  }
  const badge = document.createElement("span");
  badge.className = "note-drag-stack-badge";
  badge.textContent = String(count);
  wrapper.appendChild(badge);
  document.body.appendChild(wrapper);
  dataTransfer.setDragImage(
    wrapper,
    Math.min(36, Math.min(bounds.width, 280) / 2),
    Math.min(36, bounds.height / 2),
  );
  requestAnimationFrame(() => wrapper.remove());
}

/**
 * 在捕获阶段处理内部拖拽，即使子组件阻止冒泡也能保持拖拽过程。
 * 不阻止事件传播，侧栏仍负责处理实际放置。
 */
export function registerDragOverGuard(): () => void {
  if (typeof window === "undefined") return () => undefined;

  const handleGlobalDrag = (event: DragEvent) => {
    if (hasNoteDragType(event.dataTransfer)) {
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "move";
      }
    }
  };

  window.addEventListener("dragenter", handleGlobalDrag, true);
  window.addEventListener("dragover", handleGlobalDrag, true);
  return () => {
    window.removeEventListener("dragenter", handleGlobalDrag, true);
    window.removeEventListener("dragover", handleGlobalDrag, true);
  };
}
