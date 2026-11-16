import { useCallback, useEffect } from "react";
import type { Editor } from "@tiptap/core";
import { shouldUpdateActiveOutlineFromViewport, type OutlineItem } from "../editor-metrics";

type Ref<T> = { current: T };
const OUTLINE_HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6";
export function getOutlineHeadingElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(OUTLINE_HEADING_SELECTOR)).filter(
    (element) => Boolean(element.textContent?.trim()),
  );
}

export function useEditorOutlineNavigation({
  editor,
  editorScrollRef,
  outlineFallbackSyncRef,
  outlineItemsRef,
  outlineHeadingElementsRef,
  outlineSelectionSynchronizedRef,
  programmaticOutlineScrollIdRef,
  outlineScrollAnimRef,
  outlineItems,
  outlineStructureKey,
  cancelOutlineSmoothScroll,
  onOutlineActiveChange,
}: {
  editor: Editor | null;
  editorScrollRef: Ref<HTMLDivElement | null>;
  outlineFallbackSyncRef: Ref<(() => void) | null>;
  outlineItemsRef: Ref<OutlineItem[]>;
  outlineHeadingElementsRef: Ref<Map<string, HTMLElement>>;
  outlineSelectionSynchronizedRef: Ref<boolean>;
  programmaticOutlineScrollIdRef: Ref<string | null>;
  outlineScrollAnimRef: Ref<number | null>;
  outlineItems: OutlineItem[];
  outlineStructureKey: string;
  cancelOutlineSmoothScroll: () => void;
  onOutlineActiveChange: (id: string | null) => void;
}) {
  useEffect(() => {
    const root = editorScrollRef.current;
    outlineFallbackSyncRef.current = null;
    if (!root || outlineItemsRef.current.length === 0) {
      onOutlineActiveChange(null);
      return;
    }

    let activeFrame: number | null = null;
    const getCurrentHeadings = () => {
      // 元素映射有效时直接复用；缺失或被替换后才扫描正文补齐。
      let domHeadings: HTMLElement[] | undefined;
      const headings = new Map<string, HTMLElement>();
      for (const [index, item] of outlineItemsRef.current.entries()) {
        const mappedElement = outlineHeadingElementsRef.current.get(item.id);
        const element =
          mappedElement && root.contains(mappedElement)
            ? mappedElement
            : (domHeadings ??= getOutlineHeadingElements(root))[index];
        if (element) {
          headings.set(item.id, element);
          if (mappedElement !== element) outlineHeadingElementsRef.current.set(item.id, element);
        }
      }
      return headings;
    };
    const updateActiveHeading = () => {
      if (programmaticOutlineScrollIdRef.current) return;
      const editorFocused = Boolean(editor && !editor.isDestroyed && editor.view.hasFocus());
      if (
        !shouldUpdateActiveOutlineFromViewport(
          editorFocused,
          outlineSelectionSynchronizedRef.current,
        )
      )
        return;
      const currentHeadings = getCurrentHeadings();
      const rootTop = root.getBoundingClientRect().top;
      const activationLine = rootTop + 32;
      let currentId: string | null = null;
      const maxScrollTop = Math.max(0, root.scrollHeight - root.clientHeight);
      const items = outlineItemsRef.current;
      for (const item of items) {
        const element = currentHeadings.get(item.id);
        if (element && element.getBoundingClientRect().top <= activationLine) currentId = item.id;
        else if (currentId) break;
      }
      if (!currentId && root.scrollTop >= maxScrollTop - 1) {
        currentId = items[items.length - 1]?.id ?? null;
      }
      const nextId = currentId ?? items[0]?.id ?? null;
      onOutlineActiveChange(nextId);
    };
    const scheduleActiveHeading = () => {
      if (activeFrame !== null) return;
      activeFrame = requestAnimationFrame(() => {
        activeFrame = null;
        updateActiveHeading();
      });
    };
    outlineFallbackSyncRef.current = scheduleActiveHeading;

    const handleUserScroll = (event?: Event) => {
      cancelOutlineSmoothScroll();
      if (
        event?.type === "pointerdown" &&
        event.target instanceof Element &&
        event.target.closest("h1, h2, h3, h4, h5, h6")
      )
        return;
      outlineSelectionSynchronizedRef.current = false;
      scheduleActiveHeading();
    };

    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(scheduleActiveHeading, {
            root,
            rootMargin: "-12% 0px -68% 0px",
            threshold: [0, 1],
          });
    for (const element of getCurrentHeadings().values()) {
      observer?.observe(element);
    }
    root.addEventListener("scroll", scheduleActiveHeading, { passive: true });
    root.addEventListener("wheel", handleUserScroll, { passive: true });
    root.addEventListener("touchstart", handleUserScroll, { passive: true });
    root.addEventListener("pointerdown", handleUserScroll, { passive: true });
    scheduleActiveHeading();
    return () => {
      observer?.disconnect();
      root.removeEventListener("scroll", scheduleActiveHeading);
      root.removeEventListener("wheel", handleUserScroll);
      root.removeEventListener("touchstart", handleUserScroll);
      root.removeEventListener("pointerdown", handleUserScroll);
      if (activeFrame !== null) cancelAnimationFrame(activeFrame);
      if (outlineFallbackSyncRef.current === scheduleActiveHeading)
        outlineFallbackSyncRef.current = null;
      cancelOutlineSmoothScroll();
    };
  }, [cancelOutlineSmoothScroll, editor, onOutlineActiveChange, outlineStructureKey]);

  const scrollToOutlineItem = useCallback(
    (id: string) => {
      const scrollRoot = editorScrollRef.current;
      if (!scrollRoot) return;

      const mappedElement = outlineHeadingElementsRef.current.get(id);
      const element =
        mappedElement && scrollRoot.contains(mappedElement)
          ? mappedElement
          : getOutlineHeadingElements(scrollRoot)[outlineItems.findIndex((item) => item.id === id)];
      if (!element) return;

      cancelOutlineSmoothScroll();

      const rootRect = scrollRoot.getBoundingClientRect();
      const elementRect = element.getBoundingClientRect();
      const maxScrollTop = Math.max(0, scrollRoot.scrollHeight - scrollRoot.clientHeight);
      const targetTop = Math.min(
        maxScrollTop,
        Math.max(0, scrollRoot.scrollTop + elementRect.top - rootRect.top - 24),
      );

      onOutlineActiveChange(id);
      programmaticOutlineScrollIdRef.current = id;

      const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const startTop = scrollRoot.scrollTop;
      const distance = targetTop - startTop;

      if (prefersReducedMotion || Math.abs(distance) < 2) {
        scrollRoot.scrollTop = targetTop;
        programmaticOutlineScrollIdRef.current = null;
        return;
      }

      // 参照搜索导航的平滑过渡动画，并针对大纲跳转场景进行速度加快与敏捷调校（160ms ~ 240ms），
      // 配合 quartic ease-out 缓动曲线，比浏览器原生固定约 400~600ms 的平滑滚动更加轻快且视觉连贯。
      const duration = Math.min(240, Math.max(160, Math.round(Math.abs(distance) * 0.08 + 140)));
      const startTime = performance.now();
      const easeOutQuart = (t: number) => 1 - Math.pow(1 - t, 4);

      const step = (now: number) => {
        const elapsed = now - startTime;
        const progress = Math.min(1, elapsed / duration);
        const eased = easeOutQuart(progress);
        scrollRoot.scrollTop = Math.round(startTop + distance * eased);

        if (progress < 1) {
          outlineScrollAnimRef.current = requestAnimationFrame(step);
        } else {
          scrollRoot.scrollTop = targetTop;
          outlineScrollAnimRef.current = null;
          programmaticOutlineScrollIdRef.current = null;
        }
      };

      outlineScrollAnimRef.current = requestAnimationFrame(step);
    },
    [cancelOutlineSmoothScroll, onOutlineActiveChange, outlineItems],
  );

  return scrollToOutlineItem;
}
