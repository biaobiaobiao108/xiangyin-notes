export const KANBAN_DRAG_MIME_TYPE = "application/x-xiangying-kanban-card";

export type KanbanDragPayload = {
  noteId: string;
};

export function parseKanbanDragPayload(
  dataTransfer: DataTransfer | null,
): KanbanDragPayload | null {
  if (!dataTransfer) return null;
  const raw = dataTransfer.getData(KANBAN_DRAG_MIME_TYPE);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { noteId?: unknown }).noteId === "string"
    ) {
      return parsed as KanbanDragPayload;
    }
  } catch {
    return null;
  }
  return null;
}
