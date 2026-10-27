import { ChevronLeft, LayoutGrid, List } from "lucide-react";
import { EmptyTrashButton } from "./empty-trash-button";

type MobileCollectionHeaderProps = {
  heading: string;
  total: number;
  shown: number;
  query: string;
  onBack: () => void;
  layout: "three-column" | "cards";
  onToggleLayout?: () => void;
  onEmptyTrash?: () => void;
  trashBusy?: boolean;
  active?: boolean;
};

export function MobileCollectionHeader({
  heading,
  total,
  shown,
  query,
  onBack,
  layout,
  onToggleLayout,
  onEmptyTrash,
  trashBusy = false,
}: MobileCollectionHeaderProps) {
  const layoutLabel = layout === "cards" ? "切换为列表视图" : "切换为卡片视图";
  const LayoutIcon = layout === "cards" ? List : LayoutGrid;

  return (
    <header className="list-header mobile-collection-header">
      <button
        className="mobile-list-back"
        type="button"
        aria-label="返回笔记本首页"
        onClick={onBack}
      >
        <ChevronLeft size={22} aria-hidden="true" />
        <span>笔记本</span>
      </button>
      <div className="list-header-main">
        <h2 tabIndex={-1}>{heading}</h2>
        <p>
          {query ? `包含“${query}”的笔记` : `${total} 篇笔记`}
          {shown < total && <> · 已显示 {shown} 篇</>}
        </p>
      </div>
      <div className="list-header-controls">
        {onEmptyTrash && (
          <EmptyTrashButton
            onClick={onEmptyTrash}
            disabled={trashBusy || total === 0}
            iconSize={20}
          />
        )}
        {onToggleLayout && (
          <button
            className="icon-button mobile-layout-toggle"
            type="button"
            aria-label={layoutLabel}
            onClick={onToggleLayout}
          >
            <LayoutIcon size={20} aria-hidden="true" />
          </button>
        )}
      </div>
    </header>
  );
}
