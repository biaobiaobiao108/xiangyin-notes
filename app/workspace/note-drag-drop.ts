export const NOTE_DRAG_MIME_TYPE = "application/x-xiangying-note-ids";

export function createNoteDragGhost(title: string, count = 1): HTMLElement {
  if (typeof document === "undefined") {
    return {
      className: "note-drag-ghost",
      innerHTML: "",
      remove() {},
    } as unknown as HTMLElement;
  }
  const ghost = document.createElement("div");
  ghost.className = "note-drag-ghost";
  ghost.style.position = "fixed";
  ghost.style.top = "-9999px";
  ghost.style.left = "-9999px";
  ghost.style.zIndex = "99999";
  ghost.style.pointerEvents = "none";

  const displayTitle = (title.trim() || "未命名笔记").slice(0, 18);
  const text = count > 1 ? `${displayTitle}… 等 ${count} 篇` : displayTitle;

  ghost.innerHTML = `
    <div class="note-drag-ghost-body">
      <svg class="note-drag-ghost-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/>
        <polyline points="14 2 14 8 20 8"/>
      </svg>
      <span class="note-drag-ghost-title">${escapeHtml(text)}</span>
      ${count > 1 ? `<span class="note-drag-ghost-badge">${count}</span>` : ""}
    </div>
  `;

  document.body.appendChild(ghost);
  return ghost;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
