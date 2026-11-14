import type { KeyboardEvent as ReactKeyboardEvent } from "react";

type KanbanCardKeyboardEvent = Pick<
  ReactKeyboardEvent<HTMLElement>,
  "key" | "target" | "currentTarget" | "preventDefault" | "stopPropagation"
>;

export function handleKanbanCardKeyDown(event: KanbanCardKeyboardEvent, onOpen: () => void) {
  if (event.target !== event.currentTarget) {
    if (event.key === "Enter" || event.key === " ") event.stopPropagation();
    return;
  }

  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    onOpen();
  }
}
