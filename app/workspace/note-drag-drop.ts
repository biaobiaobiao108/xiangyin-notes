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
  if (typeof types.includes === "function") {
    return types.includes(NOTE_DRAG_MIME_TYPE);
  }
  if (typeof types.contains === "function") {
    return types.contains(NOTE_DRAG_MIME_TYPE);
  }
  return Array.from(dataTransfer.types).includes(NOTE_DRAG_MIME_TYPE);
}

/**
 * 创建高对比度、物理级层叠与明确状态的桌面级拖拽跟随预览（单选为独立实体卡片，多选为错落 Card Stack 层叠）。
 */
export function createNoteDragGhost(title: string, count = 1): HTMLElement {
  if (typeof document === "undefined") {
    return {
      className: "note-drag-ghost-shell",
      innerHTML: "",
      remove() {},
    } as unknown as HTMLElement;
  }

  const wrapper = document.createElement("div");
  wrapper.className = "note-drag-ghost-shell";
  wrapper.style.position = "fixed";
  wrapper.style.top = "0";
  wrapper.style.left = "0";
  wrapper.style.zIndex = "-999";
  wrapper.style.pointerEvents = "none";
  wrapper.style.opacity = "0.99";

  const displayTitle = (title.trim() || "未命名笔记").slice(0, 22);
  const isMulti = count > 1;

  wrapper.innerHTML = `
    <div class="note-drag-stack ${isMulti ? "is-multi" : ""}">
      ${
        isMulti && count >= 3
          ? `<div class="note-drag-card-layer is-layer-back" aria-hidden="true"></div>`
          : ""
      }
      ${
        isMulti && count >= 2
          ? `<div class="note-drag-card-layer is-layer-middle" aria-hidden="true"></div>`
          : ""
      }
      <div class="note-drag-card-top">
        <div class="note-drag-card-header">
          <svg class="note-drag-card-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/>
            <polyline points="14 2 14 8 20 8"/>
          </svg>
          <span class="note-drag-card-title">${escapeHtml(displayTitle)}</span>
        </div>
        <div class="note-drag-card-info" aria-hidden="true">
          <span class="note-drag-card-count-text">${
            isMulti ? `已多选 ${count} 篇笔记` : "拖拽至侧栏以移动"
          }</span>
        </div>
        ${isMulti ? `<div class="note-drag-stack-badge" aria-hidden="true">${count}</div>` : ""}
      </div>
    </div>
  `;

  document.body.appendChild(wrapper);
  // 强制触发一次同步布局计算，确保浏览器位图捕获前所有元素完成几何渲染
  void wrapper.offsetWidth;

  // 400ms 后自动卸载，给浏览器留足捕获时间，绝不在当前渲染帧前提前移除
  setTimeout(() => {
    wrapper.remove();
  }, 400);

  return wrapper;
}

/**
 * 全局消除拖拽时 Windows/Chromium 出现的红色禁止图标（not-allowed cursor）。
 * 只要正在拖拽象映笔记内部项，在捕获阶段拦截 dragenter 与 dragover，并将 dropEffect 置为 "move"。
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

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
