import type { OutlineItem } from "../editor-metrics";
import { NoteOutlinePanel } from "../workspace/panels";

export function CardOutline({ outlineItems, activeOutlineId, onNavigate, onClose }: {
  outlineItems: OutlineItem[];
  activeOutlineId: string | null;
  onNavigate: (id: string) => void;
  onClose: () => void;
}) {
  return <div className="editor-floating-outline">
    <NoteOutlinePanel outlineItems={outlineItems} activeOutlineId={activeOutlineId}
      onScrollToOutlineItem={onNavigate} onCloseOutline={onClose} isFloating />
  </div>;
}
