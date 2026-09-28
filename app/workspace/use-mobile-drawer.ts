import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

export type MobileDrawer = "sidebar" | "list" | null;

type UseMobileDrawerOptions = {
  drawer: MobileDrawer;
  setDrawer: (drawer: MobileDrawer) => void;
  sidebarRef: RefObject<HTMLElement | null>;
  listRef: RefObject<HTMLElement | null>;
  sidebarInitialFocusRef: RefObject<HTMLInputElement | null>;
  fallbackFocusRef: RefObject<HTMLElement | null>;
};

const MOBILE_VIEWPORT = "(max-width: 900px)";
const FOCUSABLE_SELECTOR = "a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])";

function matchesMobileViewport() {
  return typeof window !== "undefined" && window.matchMedia(MOBILE_VIEWPORT).matches;
}

function getFocusableElements(panel: HTMLElement) {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) => {
    if (element.closest("[inert], [aria-hidden='true']") || element.getAttribute("aria-hidden") === "true") return false;
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
  });
}

function isAvailableFocusTarget(element: HTMLElement) {
  if (!element.isConnected || element.closest("[inert], [aria-hidden='true']")) return false;
  let current: HTMLElement | null = element;
  while (current) {
    const style = window.getComputedStyle(current);
    if (style.display === "none" || style.visibility === "hidden") return false;
    current = current.parentElement;
  }
  return true;
}

export function useMobileDrawer(options: UseMobileDrawerOptions) {
  const { drawer, setDrawer, sidebarRef, listRef, sidebarInitialFocusRef, fallbackFocusRef } = options;
  const [isMobileViewport, setIsMobileViewport] = useState(matchesMobileViewport);
  const drawerStateRef = useRef(drawer);
  drawerStateRef.current = drawer;
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const activeMobileDrawerRef = useRef<MobileDrawer>(null);

  useEffect(() => {
    const media = window.matchMedia(MOBILE_VIEWPORT);
    const update = () => setIsMobileViewport(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const openDrawer = useCallback((next: Exclude<MobileDrawer, null>) => {
    if (!isMobileViewport) return;
    if (drawerStateRef.current === null) {
      const active = document.activeElement;
      returnFocusRef.current = active instanceof HTMLElement ? active : null;
    }
    setDrawer(next);
  }, [isMobileViewport, setDrawer]);

  const closeDrawer = useCallback(() => setDrawer(null), [setDrawer]);
  const activeDrawer = isMobileViewport ? drawer : null;

  useLayoutEffect(() => {
    const previous = activeMobileDrawerRef.current;
    if (previous === activeDrawer) return;
    activeMobileDrawerRef.current = activeDrawer;

    if (activeDrawer) {
      if (!returnFocusRef.current) {
        const active = document.activeElement;
        returnFocusRef.current = active instanceof HTMLElement ? active : null;
      }
      const panel = activeDrawer === "sidebar" ? sidebarRef.current : listRef.current;
      const frame = requestAnimationFrame(() => {
        if (!panel) return;
        const preferred = activeDrawer === "sidebar" ? sidebarInitialFocusRef.current : null;
        const listRow = activeDrawer === "list" ? panel.querySelector<HTMLElement>(".note-row") : null;
        const target = preferred && panel.contains(preferred)
          ? preferred
          : listRow ?? getFocusableElements(panel)[0] ?? panel;
        target.focus({ preventScroll: true });
      });
      return () => cancelAnimationFrame(frame);
    }

    if (previous) {
      const returnTarget = returnFocusRef.current;
      returnFocusRef.current = null;
      const frame = requestAnimationFrame(() => {
        if (returnTarget && isAvailableFocusTarget(returnTarget)) {
          returnTarget.focus({ preventScroll: true });
          return;
        }
        fallbackFocusRef.current?.focus({ preventScroll: true });
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [activeDrawer, fallbackFocusRef, listRef, sidebarInitialFocusRef, sidebarRef]);

  useEffect(() => {
    if (!activeDrawer) return;
    const panelRef = activeDrawer === "sidebar" ? sidebarRef : listRef;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      const panel = panelRef.current;
      if (!panel) return;

      if (event.key === "Escape") {
        const nestedDialogOpen = Array.from(document.querySelectorAll<HTMLDialogElement>("dialog[open]")).some(
          (dialog) => !panel.contains(dialog),
        );
        const nestedPopupOpen = Boolean(panel.querySelector(".sort-dropdown, [role='listbox'], [role='menu']"));
        if (nestedDialogOpen || nestedPopupOpen) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        closeDrawer();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = getFocusableElements(panel);
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus({ preventScroll: true });
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [activeDrawer, closeDrawer, listRef, sidebarRef]);

  return { isMobileViewport, activeDrawer, openDrawer, closeDrawer };
}
