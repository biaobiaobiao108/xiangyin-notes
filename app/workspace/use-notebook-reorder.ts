import {
  useLayoutEffect,
  useRef,
  type PointerEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";

// Rows stay in document flow throughout the gesture; only the floating copy moves.
export function useNotebookReorder(
  listRef: RefObject<HTMLElement | null>,
  ids: string[],
  onReorder: (ids: string[], expectedIds: string[]) => Promise<void>,
  disabled: boolean,
) {
  const cancelRef = useRef<(() => void) | null>(null);
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
        previous !== top &&
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
    event.preventDefault();
    event.stopPropagation();
    const list = listRef.current;
    const source = event.currentTarget.closest<HTMLElement>("[data-sort-id]");
    if (!list || !source) return;
    cancelRef.current?.();
    const original = [...ids];
    const startY = event.clientY;
    const rect = source.getBoundingClientRect();
    let y = startY;
    let x = event.clientX;
    let active = false;
    let target = -1;
    let frame = 0;
    let preview: HTMLElement | null = null;
    let line: HTMLElement | null = null;
    const rows = Array.from(list.querySelectorAll<HTMLElement>("[data-sort-id]"));
    const cleanup = () => {
      cancelAnimationFrame(frame);
      preview?.remove();
      line?.remove();
      source.classList.remove("is-notebook-dragging");
      document.body.classList.remove("is-sorting-notebooks");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", key, true);
      cancelRef.current = null;
    };
    const cancel = () => cleanup();
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        e.stopImmediatePropagation();
        cleanup();
      }
    };
    const tick = () => {
      if (!active) return;
      const bounds = list.getBoundingClientRect();
      const inside =
        x >= bounds.left - 24 &&
        x <= bounds.right + 24 &&
        y >= bounds.top - 24 &&
        y <= bounds.bottom + 24;
      if (inside) {
        const speed = y < bounds.top + 28 ? -6 : y > bounds.bottom - 28 ? 6 : 0;
        list.scrollTop += speed;
      }
      const others = rows.filter((row) => row !== source);
      target = inside
        ? others.findIndex((row) => y < row.getBoundingClientRect().top + row.offsetHeight / 2)
        : -1;
      if (inside && target === -1) target = others.length;
      preview!.style.transform = `translateY(${y - startY}px)`;
      line!.style.display = target < 0 || target === original.indexOf(id) ? "none" : "block";
      if (target >= 0) {
        const anchor = others[target] ?? others.at(-1);
        if (anchor) {
          const box = anchor.getBoundingClientRect();
          const top = target === others.length ? box.bottom : box.top;
          line!.style.cssText += `;left:${bounds.left + 8}px;width:${bounds.width - 16}px;top:${Math.max(bounds.top, Math.min(bounds.bottom, top))}px`;
        }
      }
      frame = requestAnimationFrame(tick);
    };
    const move = (e: globalThis.PointerEvent) => {
      if (e.pointerId !== event.pointerId) return;
      y = e.clientY;
      x = e.clientX;
      if (!active && Math.abs(y - startY) >= 5) {
        active = true;
        preview = source.cloneNode(true) as HTMLElement;
        preview.removeAttribute("id");
        preview.setAttribute("aria-hidden", "true");
        preview.classList.add("notebook-drag-preview");
        preview.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px`;
        document.body.append(preview);
        line = document.createElement("div");
        line.className = "notebook-sort-line";
        document.body.append(line);
        source.classList.add("is-notebook-dragging");
        document.body.classList.add("is-sorting-notebooks");
        tick();
      }
    };
    const end = (e: globalThis.PointerEvent) => {
      if (e.pointerId !== event.pointerId) return;
      if (active) {
        y = e.clientY;
        x = e.clientX;
        cancelAnimationFrame(frame);
        tick();
      }
      const next = original.filter((value) => value !== id);
      if (active && target >= 0) next.splice(target, 0, id);
      const changed =
        active && target >= 0 && next.some((value, index) => value !== original[index]);
      if (changed)
        rows.forEach((row) =>
          positions.current.set(row.dataset.sortId!, row.getBoundingClientRect().top),
        );
      cleanup();
      if (changed) void onReorder(next, original);
    };
    cancelRef.current = cleanup;
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
    void onReorder(next, ids);
  }
  return (id: string) => ({
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => handlePointerDown(event, id),
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => handleKeyDown(event, id),
    disabled: disabled || ids.length < 2,
    "aria-label": "拖动排序，或按 Alt 加上下方向键调整顺序",
    className: "notebook-sort-handle",
    type: "button" as const,
  });
}
