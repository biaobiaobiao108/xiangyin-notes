import { Trash2 } from "lucide-react";

type EmptyTrashButtonProps = {
  onClick: () => void;
  disabled?: boolean;
  iconSize?: number;
  className?: string;
};

/**
 * 清空回收站按钮。列表、卡片网格与移动端头部共用同一个实现，
 * 无障碍契约（固定 aria-label、无 title 提示、无可见文字）只在这里维护。
 */
export function EmptyTrashButton({ onClick, disabled, iconSize = 18, className }: EmptyTrashButtonProps) {
  return (
    <button
      className={className ? `icon-button empty-trash-button ${className}` : "icon-button empty-trash-button"}
      type="button"
      aria-label="清空回收站"
      onClick={onClick}
      disabled={disabled}
    >
      <Trash2 size={iconSize} aria-hidden="true" />
    </button>
  );
}
