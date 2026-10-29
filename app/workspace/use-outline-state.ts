import { useCallback, useRef, useState } from "react";
import type { OutlineItem } from "../editor-metrics";

export function useOutlineState() {
  const [items, setItems] = useState<OutlineItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const navigateRef = useRef<((id: string) => void) | null>(null);

  const onItemsChange = useCallback((nextItems: OutlineItem[]) => {
    setItems((current) => {
      const unchanged =
        current.length === nextItems.length &&
        current.every((item, index) => {
          const next = nextItems[index];
          return (
            next && item.id === next.id && item.level === next.level && item.title === next.title
          );
        });
      return unchanged ? current : nextItems;
    });
  }, []);
  const onActiveChange = useCallback((id: string | null) => setActiveId(id), []);
  const onNavigationReady = useCallback((navigate: ((id: string) => void) | null) => {
    navigateRef.current = navigate;
  }, []);
  const reset = useCallback(() => {
    setItems([]);
    setActiveId(null);
    navigateRef.current = null;
  }, []);

  return { items, activeId, navigateRef, onItemsChange, onActiveChange, onNavigationReady, reset };
}
