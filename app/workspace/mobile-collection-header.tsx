import { ChevronLeft } from "lucide-react";
import { EmptyTrashButton } from "./empty-trash-button";
import { searchResultLabel } from "./helpers";

type MobileCollectionHeaderProps = {
  heading: string;
  total: number;
  shown: number;
  query: string;
  onBack: () => void;
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
  onEmptyTrash,
  trashBusy = false,
}: MobileCollectionHeaderProps) {
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
          {query ? searchResultLabel(query, total) : `${total} 篇笔记`}
          {shown < total && <> · 已显示 {shown} 篇</>}
        </p>
      </div>
      {onEmptyTrash && (
        <div className="list-header-controls">
          <EmptyTrashButton
            onClick={onEmptyTrash}
            disabled={trashBusy || total === 0}
            iconSize={20}
          />
        </div>
      )}
    </header>
  );
}
