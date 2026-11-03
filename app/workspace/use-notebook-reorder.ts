import {
  useLayoutEffect,
  useRef,
  type PointerEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";

export function calculateNotebookTargetIndex(
  slots: Array<{ top: number; height: number }>,
  sourceIndex: number,
  currentTarget: number,
  center: number,
  hysteresis = 8,
): number {
  const count = slots.length;
  if (count <= 1) return 0;
  if (currentTarget < 0 || currentTarget >= count) currentTarget = sourceIndex;

  const currentSlot = slots[currentTarget];
  const currentMid = currentSlot.top + currentSlot.height / 2;

  let upperThreshold = -Infinity;
  if (currentTarget > 0) {
    const prevSlot = slots[currentTarget - 1];
    const prevMid = prevSlot.top + prevSlot.height / 2;
    const boundary = (prevMid + currentMid) / 2;
    upperThreshold = boundary - hysteresis;
  }

  let lowerThreshold = Infinity;
  if (currentTarget < count - 1) {
    const nextSlot = slots[currentTarget + 1];
    const nextMid = nextSlot.top + nextSlot.height / 2;
    const boundary = (currentMid + nextMid) / 2;
    lowerThreshold = boundary + hysteresis;
  }

  if (center >= upperThreshold && center <= lowerThreshold) {
    return currentTarget;
  }

  let bestIndex = currentTarget;
  let minDistance = Infinity;
  for (let i = 0; i < count; i++) {
    const mid = slots[i].top + slots[i].height / 2;
    const dist = Math.abs(center - mid);
    if (dist < minDistance) {
      minDistance = dist;
      bestIndex = i;
    }
  }

  return bestIndex;
}

// Keep layout slots fixed; only transforms preview the proposed order.
export function useNotebookReorder(
  listRef: RefObject<HTMLElement | null>,
  ids: string[],
  onReorder: (ids: string[], expectedIds: string[]) => Promise<void>,
  disabled: boolean,
) {
  const cancelRef = useRef<(() => void) | null>(null);
  const suppressClick = useRef(false);
  const positions = useRef(new Map<string, number>());
  const signature = ids.join("\0");
  useLayoutEffect(() => {
    cancelRef.current?.();
    const rows = listRef.current?.querySelectorAll<HTMLElement>("[data-sort-id]");
    rows?.forEach((row) => {
      const id = row.dataset.sortId!;
      const top = row.getBoundingClientRect().top;
      const previous = positions.current.get(id);
      if (
        previous !== undefined &&
        Math.abs(previous - top) > 0.75 &&
        !matchMedia("(prefers-reduced-motion: reduce)").matches
      ) {
        row.animate(
          [{ transform: `translateY(${previous - top}px)` }, { transform: "translateY(0)" }],
          { duration: 180, easing: "cubic-bezier(.2,.7,.2,1)" },
        );
      }
    });
    positions.current.clear();
    return () => cancelRef.current?.();
  }, [signature, listRef]);

  function handlePointerDown(event: PointerEvent<HTMLButtonElement>, id: string) {
    if (disabled || ids.length < 2 || event.button !== 0 || !event.isPrimary) return;
    if (event.pointerType !== "touch") event.preventDefault();
    event.stopPropagation();
    const button = event.currentTarget;
    const list = listRef.current;
    const source = event.currentTarget.closest<HTMLElement>("[data-sort-id]");
    if (!list || !source) return;
    cancelRef.current?.();
    const original = [...ids];
    const startY = event.clientY;
    const rect = source.getBoundingClientRect();
    const grabOffset = startY - rect.top;
    const sourceIndex = original.indexOf(id);
    let y = startY;
    let x = event.clientX;
    let active = false;
    let armed = event.pointerType !== "touch";
    const holdTimer = window.setTimeout(() => {
      armed = true;
    }, 350);
    let target = sourceIndex;
    let frame = 0;
    let preview: HTMLElement | null = null;
    let dropping = false;
    let slots: Array<{ top: number; height: number }> = [];
    let initialScroll = 0;
    const rows = Array.from(list.querySelectorAll<HTMLElement>("[data-sort-id]"));
    const cleanup = () => {
      clearTimeout(holdTimer);
      setTimeout(() => {
        suppressClick.current = false;
      }, 0);
      window.removeEventListener("touchmove", preventScroll);
      cancelAnimationFrame(frame);
      preview?.remove();
      rows.forEach((row) => {
        row.style.removeProperty("transform");
        row.classList.remove("is-notebook-sorting");
      });
      source.classList.remove("is-notebook-dragging");
      document.body.classList.remove("is-sorting-notebooks");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", key, true);
      cancelRef.current = null;
    };
    const preventScroll = (e: TouchEvent) => {
      if (armed && e.cancelable) e.preventDefault();
    };
    const cancel = () => {
      if (dropping) return;
      if (active) {
        rows.forEach((row) =>
          positions.current.set(row.dataset.sortId!, row.getBoundingClientRect().top),
        );
      }
      cleanup();
      if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
        rows.forEach((row) => {
          const previous = positions.current.get(row.dataset.sortId!);
          const top = row.getBoundingClientRect().top;
          if (previous !== undefined && Math.abs(previous - top) > 0.75)
            row.animate(
              [{ transform: `translateY(${previous - top}px)` }, { transform: "translateY(0)" }],
              { duration: 180, easing: "cubic-bezier(.2,.7,.2,1)" },
            );
        });
      }
      positions.current.clear();
    };
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        e.stopImmediatePropagation();
        cancel();
      }
    };
    const tick = () => {
      if (!active) return;
      const bounds = list.getBoundingClientRect();
      const inside = x >= bounds.left - 48 && x <= bounds.right + 48;
      if (inside) {
        const speed = y < bounds.top + 28 ? -6 : y > bounds.bottom - 28 ? 6 : 0;
        list.scrollTop += speed;
      }
      const scrollDelta = list.scrollTop - initialScroll;
      const center = y - grabOffset + rect.height / 2 + scrollDelta;
      if (inside) {
        target = calculateNotebookTargetIndex(
          slots,
          sourceIndex,
          target >= 0 ? target : sourceIndex,
          center,
        );
      } else {
        target = sourceIndex;
      }
      const destination = target < 0 ? sourceIndex : target;
      rows.forEach((row, index) => {
        let nextIndex = index;
        if (index > sourceIndex && index <= destination) nextIndex--;
        if (index < sourceIndex && index >= destination) nextIndex++;
        const offset = slots[nextIndex]!.top - slots[index]!.top;
        row.style.transform = index === sourceIndex ? "" : `translateY(${offset}px)`;
      });
      preview!.style.transform = `translateY(${y - startY}px)`;
      frame = requestAnimationFrame(tick);
    };
    const move = (e: globalThis.PointerEvent) => {
      if (dropping || e.pointerId !== event.pointerId) return;
      y = e.clientY;
      x = e.clientX;
      if (!armed && Math.hypot(x - event.clientX, y - startY) > 6) {
        cleanup();
        return;
      }
      if (armed && !active && Math.abs(y - startY) >= 5) {
        suppressClick.current = true;
        active = true;
        initialScroll = list.scrollTop;
        slots = rows.map((row) => {
          const box = row.getBoundingClientRect();
          return { top: box.top, height: box.height };
        });
        rows.forEach((row) => row.classList.add("is-notebook-sorting"));
        preview = document.createElement("div");
        preview.setAttribute("aria-hidden", "true");
        preview.className = "notebook-drag-preview";
        preview.append(button.cloneNode(true));
        preview.style.cssText = `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px`;
        document.body.append(preview);
        source.classList.add("is-notebook-dragging");
        document.body.classList.add("is-sorting-notebooks");
        tick();
      }
    };
    const end = async (e: globalThis.PointerEvent) => {
      if (dropping || e.pointerId !== event.pointerId) return;
      if (!active) {
        cleanup();
        return;
      }
      y = e.clientY;
      x = e.clientX;
      cancelAnimationFrame(frame);
      tick();
      cancelAnimationFrame(frame);
      dropping = true;
      const destination = target < 0 ? sourceIndex : target;
      if (destination === sourceIndex) {
        const returnTop = slots[sourceIndex]!.top - (list.scrollTop - initialScroll);
        const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
        const animation = preview!.animate(
          [
            { transform: `translateY(${y - startY}px)` },
            { transform: `translateY(${returnTop - rect.top}px)` },
          ],
          { duration: reduced ? 0 : 160, easing: "cubic-bezier(.2,.7,.2,1)", fill: "forwards" },
        );
        await animation.finished.catch(() => {});
        if (cancelRef.current === cleanup) cancel();
        return;
      }
      const next = original.filter((value) => value !== id);
      next.splice(destination, 0, id);
      const finalTop = slots[destination]!.top - (list.scrollTop - initialScroll);
      const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
      const animation = preview!.animate(
        [
          { transform: `translateY(${y - startY}px)` },
          { transform: `translateY(${finalTop - rect.top}px)` },
        ],
        { duration: reduced ? 0 : 160, easing: "cubic-bezier(.2,.7,.2,1)", fill: "forwards" },
      );
      await animation.finished.catch(() => {});
      // Escape, a remote list update, or unmount may have ended the gesture.
      if (cancelRef.current !== cleanup) return;
      rows.forEach((row) =>
        positions.current.set(
          row.dataset.sortId!,
          row === source ? finalTop : row.getBoundingClientRect().top,
        ),
      );
      try {
        await onReorder(next, original);
      } catch {
        if (cancelRef.current === cleanup) cancel();
        return;
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (cancelRef.current === cleanup) {
        cleanup();
        positions.current.clear();
      }
    };
    cancelRef.current = cleanup;
    window.addEventListener("touchmove", preventScroll, { passive: false });
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", key, true);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, id: string) {
    if (disabled || !event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const index = ids.indexOf(id);
    const nextIndex = index + (event.key === "ArrowUp" ? -1 : 1);
    if (index < 0 || nextIndex < 0 || nextIndex >= ids.length) return;
    const next = [...ids];
    next.splice(index, 1);
    next.splice(nextIndex, 0, id);
    const rows = listRef.current?.querySelectorAll<HTMLElement>("[data-sort-id]");
    rows?.forEach((row) =>
      positions.current.set(row.dataset.sortId!, row.getBoundingClientRect().top),
    );
    void onReorder(next, ids);
  }
  return (id: string) => ({
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => handlePointerDown(event, id),
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => handleKeyDown(event, id),
    onClickCapture: (event: import("react").MouseEvent<HTMLButtonElement>) => {
      if (suppressClick.current) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
  });
}
