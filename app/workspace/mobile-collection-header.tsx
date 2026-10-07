import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ArrowDownWideNarrow, ChevronDown, ChevronLeft, LayoutGrid, List, Trash2 } from "lucide-react";
import type { NoteSort } from "./helpers";

const SORT_OPTIONS: Array<{ value: NoteSort; label: string }> = [
  { value: "updated", label: "最近更新" },
  { value: "created", label: "创建时间" },
  { value: "title", label: "标题排序" },
];

type MobileCollectionHeaderProps = {
  heading: string;
  total: number;
  shown: number;
  query: string;
  sort: NoteSort;
  onSort: (sort: NoteSort) => void;
  onBack: () => void;
  layout: "three-column" | "cards";
  onToggleLayout?: () => void;
  onEmptyTrash?: () => void;
  trashBusy?: boolean;
  active?: boolean;
};

export function MobileCollectionHeader({ heading, total, shown, query, sort, onSort, onBack, layout, onToggleLayout, onEmptyTrash, trashBusy = false, active = true }: MobileCollectionHeaderProps) {
  const id = useId();
  const [sortOpen, setSortOpen] = useState(false);
  const sortRef = useRef<HTMLDivElement>(null);
  const sortTriggerRef = useRef<HTMLButtonElement>(null);
  const sortOptionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const focusFrameRef = useRef<number | null>(null);

  const restoreTriggerFocus = () => {
    if (focusFrameRef.current !== null) cancelAnimationFrame(focusFrameRef.current);
    focusFrameRef.current = requestAnimationFrame(() => {
      focusFrameRef.current = null;
      sortTriggerRef.current?.focus();
    });
  };
  const closeSortMenu = () => {
    setSortOpen(false);
    restoreTriggerFocus();
  };

  useEffect(() => () => {
    if (focusFrameRef.current !== null) cancelAnimationFrame(focusFrameRef.current);
  }, []);
  useEffect(() => { if (!active) setSortOpen(false); }, [active]);

  useEffect(() => {
    if (!sortOpen || !active) return;
    const selectedOptionIndex = Math.max(0, SORT_OPTIONS.findIndex((option) => option.value === sort));
    const focusFrame = requestAnimationFrame(() => sortOptionRefs.current[selectedOptionIndex]?.focus());
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !sortRef.current?.contains(event.target)) closeSortMenu();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        closeSortMenu();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [active, sort, sortOpen]);

  const handleSortOptionKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault();
      sortOptionRefs.current[(index + 1) % SORT_OPTIONS.length]?.focus();
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault();
      sortOptionRefs.current[(index + SORT_OPTIONS.length - 1) % SORT_OPTIONS.length]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      sortOptionRefs.current[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      sortOptionRefs.current[SORT_OPTIONS.length - 1]?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeSortMenu();
    }
  };

  const layoutLabel = layout === "cards" ? "切换为列表视图" : "切换为卡片视图";
  const LayoutIcon = layout === "cards" ? List : LayoutGrid;
  return <header className="list-header mobile-collection-header">
    <button className="mobile-list-back" type="button" aria-label="返回笔记本首页" onClick={onBack}><ChevronLeft size={22} aria-hidden="true" /><span>笔记本</span></button>
    <div className="list-header-main"><h2 tabIndex={-1}>{heading}</h2><p>{query ? `包含“${query}”的笔记` : `${total} 篇笔记`}{shown < total && <> · 已显示 {shown} 篇</>}</p></div>
    <div className="list-header-controls">
      {onEmptyTrash && <button className="icon-button empty-trash-button" type="button" aria-label="清空回收站" onClick={onEmptyTrash} disabled={trashBusy || total === 0}><Trash2 size={20} aria-hidden="true" /></button>}
      <div className="sort-menu-wrap" ref={sortRef}>
        <button ref={sortTriggerRef} id={`${id}-sort-trigger`} className="sort-button" type="button" aria-label={`笔记排序：${SORT_OPTIONS.find((option) => option.value === sort)?.label}`} aria-haspopup="listbox" aria-controls={`${id}-sort-options`} aria-expanded={sortOpen} onClick={() => setSortOpen((open) => !open)}>
          <ArrowDownWideNarrow className="mobile-sort-icon" size={20} aria-hidden="true" /><span className="sort-button-label">{SORT_OPTIONS.find((option) => option.value === sort)?.label}</span><ChevronDown size={14} className="sort-button-arrow" aria-hidden="true" />
        </button>
        {sortOpen && <div id={`${id}-sort-options`} className="sort-dropdown" role="listbox" aria-label="笔记排序方式">
          {SORT_OPTIONS.map((option, index) => {
            const isSelected = sort === option.value;
            return <button ref={(element) => { sortOptionRefs.current[index] = element; }} id={`${id}-sort-${option.value}`} key={option.value} type="button" className={`sort-option ${isSelected ? "is-active" : ""}`} role="option" aria-selected={isSelected} tabIndex={isSelected ? 0 : -1} onClick={() => { onSort(option.value); closeSortMenu(); }} onKeyDown={(event) => handleSortOptionKeyDown(event, index)}>{option.label}</button>;
          })}
        </div>}
      </div>
      {onToggleLayout && <button className="icon-button mobile-layout-toggle" type="button" aria-label={layoutLabel} onClick={onToggleLayout}><LayoutIcon size={20} aria-hidden="true" /></button>}
    </div>
  </header>;
}
