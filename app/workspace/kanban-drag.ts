import type { KanbanCard, KanbanStatus } from "../../shared/types";
import { NOTE_DRAG_MIME_TYPE } from "./note-drag-drop";

export const KANBAN_DRAG_MIME_TYPE = "application/x-xiangying-kanban-card";

export type KanbanDragPayload = {
  noteId: string;
  sourceStatus: KanbanStatus;
  sortOrder: number;
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
      typeof (parsed as { noteId?: unknown }).noteId === "string" &&
      typeof (parsed as { sourceStatus?: unknown }).sourceStatus === "string"
    ) {
      return parsed as KanbanDragPayload;
    }
  } catch {
    return null;
  }
  return null;
}

export function parseNoteIdsFromDrag(dataTransfer: DataTransfer | null): string[] {
  if (!dataTransfer) return [];
  const raw = dataTransfer.getData(NOTE_DRAG_MIME_TYPE);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((id): id is string => typeof id === "string" && Boolean(id));
    }
  } catch {
    return [];
  }
  return [];
}

/**
 * Calculates a new sort_order value between beforeOrder and afterOrder.
 * If inserted at the start, picks before first - 1000.
 * If inserted at the end, picks after last + 1000.
 */
export function calculateTargetSortOrder(
  cardsInColumn: readonly KanbanCard[],
  targetIndex: number,
  draggedNoteId?: string,
): number {
  const filtered = cardsInColumn.filter((c) => c.noteId !== draggedNoteId);
  if (filtered.length === 0) return 1000;

  if (targetIndex <= 0) {
    const firstOrder = filtered[0]?.sortOrder ?? 1000;
    return firstOrder - 1000;
  }

  if (targetIndex >= filtered.length) {
    const lastOrder = filtered[filtered.length - 1]?.sortOrder ?? 1000;
    return lastOrder + 1000;
  }

  const prevOrder = filtered[targetIndex - 1].sortOrder;
  const nextOrder = filtered[targetIndex].sortOrder;
  return (prevOrder + nextOrder) / 2;
}
