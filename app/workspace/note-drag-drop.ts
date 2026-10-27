export const NOTE_DRAG_MIME_TYPE = "application/x-xiangying-note-ids";

/**
 * 创建符合象映笔记审美与桌面规范的拖拽跟随卡片（单选为真实卡片，多选为错落层叠 Card Stack）。
 */
export function createNoteDragGhost(title: string, count = 1): HTMLElement {
  if (typeof document === "undefined") {
    return {
      className: "note-drag-ghost",
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

  const displayTitle = (title.trim() || "未命名笔记").slice(0, 24);
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
          <svg class="note-drag-card-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/>
            <polyline points="14 2 14 8 20 8"/>
          </svg>
          <span class="note-drag-card-title">${escapeHtml(displayTitle)}</span>
        </div>
        <div class="note-drag-card-preview-lines" aria-hidden="true">
          <span class="line-1"></span>
          <span class="line-2"></span>
        </div>
        ${isMulti ? `<div class="note-drag-stack-badge" aria-hidden="true">${count}</div>` : ""}
      </div>
    </div>
  `;

  document.body.appendChild(wrapper);
  return wrapper;
}

/**
 * 全局消除拖拽时 Windows/Chromium 出现的红色禁止图标（not-allowed cursor）。
 * 只要正在拖拽象映笔记内部项，阻止默认事件并将 dropEffect 置为 "move"。
 */
export function registerDragOverGuard(): () => void {
  if (typeof window === "undefined") return () => undefined;

  const handleDragOver = (event: DragEvent) => {
    if (event.dataTransfer?.types.includes(NOTE_DRAG_MIME_TYPE)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    }
  };

  window.addEventListener("dragover", handleDragOver);
  return () => {
    window.removeEventListener("dragover", handleDragOver);
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
