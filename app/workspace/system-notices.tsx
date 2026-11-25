import { CircleAlert, Info, TriangleAlert, X } from "lucide-react";
import type { Notice, NoticePauseSource } from "./use-notices";

export function SystemNotices({
  notice,
  onDismiss,
  onPause,
}: {
  notice: Notice | null;
  onDismiss: () => void;
  onPause: (paused: boolean, source: NoticePauseSource) => void;
}) {
  const Icon =
    notice?.kind === "error" ? CircleAlert : notice?.kind === "warning" ? TriangleAlert : Info;
  return (
    <div className="system-notices">
      {notice && (
        <div
          key={notice.id}
          className={`toast toast--${notice.kind}`}
          onPointerEnter={(event) => {
            if (event.pointerType === "mouse") onPause(true, "pointer");
          }}
          onPointerLeave={() => onPause(false, "pointer")}
          onFocusCapture={() => onPause(true, "focus")}
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) onPause(false, "focus");
          }}
        >
          <Icon className="notice-icon" size={18} aria-hidden="true" />
          <span
            className="notice-copy"
            role={notice.kind === "error" ? "alert" : "status"}
            aria-atomic="true"
          >
            {notice.message}
          </span>
          <button
            className="notice-dismiss"
            type="button"
            aria-label="关闭提示"
            onClick={onDismiss}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
