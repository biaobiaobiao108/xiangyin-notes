import { useRef, type MouseEvent, type PointerEvent } from "react";

export function useDiagramActivation(activate: () => void, allowMouseDoubleClick: boolean) {
  const pointerType = useRef("");
  const isDiagramSurface = (event: MouseEvent<HTMLDivElement>) =>
    event.target instanceof Element && !event.target.closest("button, [role='scrollbar']");
  const isDirectPointer = () => pointerType.current === "touch" || pointerType.current === "pen";

  return {
    onPointerDownCapture: (event: PointerEvent<HTMLDivElement>) => {
      // The mouse events that follow pointerdown may not carry the pointer type.
      pointerType.current = event.pointerType;
    },
    onClick: (event: MouseEvent<HTMLDivElement>) => {
      if (isDirectPointer() && isDiagramSurface(event)) activate();
    },
    onDoubleClick: allowMouseDoubleClick
      ? (event: MouseEvent<HTMLDivElement>) => {
          if (isDirectPointer() || !isDiagramSurface(event)) return;
          event.stopPropagation();
          activate();
        }
      : undefined,
  };
}
