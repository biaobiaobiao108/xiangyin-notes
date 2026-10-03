import { useEffect, useState } from "react";
import { CircleAlert, Info, RefreshCw, TriangleAlert, X } from "lucide-react";
import type { Notice, NoticePauseSource } from "./use-notices";

export function SystemNotices({ notice, onDismiss, onPause, updateAvailable, onUpdate }: {
  notice: Notice | null; onDismiss: () => void; onPause: (paused: boolean, source: NoticePauseSource) => void;
  updateAvailable: boolean; onUpdate: () => void;
}) {
  const [updateDismissed, setUpdateDismissed] = useState(false);
  useEffect(() => { if (!updateAvailable) setUpdateDismissed(false); }, [updateAvailable]);
  const Icon = notice?.kind === "error" ? CircleAlert : notice?.kind === "warning" ? TriangleAlert : Info;
  return <div className="system-notices" aria-label="应用提示">
    {updateAvailable && !updateDismissed && <div className="update-notice" role="status">
      <RefreshCw size={18} aria-hidden="true" />
      <div className="notice-copy"><strong>发现新版本</strong><p>保存编辑后即可更新</p></div>
      <button className="text-button update-notice-action" type="button" onClick={onUpdate}>更新</button>
      <button className="notice-dismiss" type="button" aria-label="稍后提醒更新" onClick={() => setUpdateDismissed(true)}><X size={16} aria-hidden="true" /></button>
    </div>}
    {notice && <div key={notice.id} className={`toast toast--${notice.kind}`} onPointerEnter={(event) => { if (event.pointerType === "mouse") onPause(true, "pointer"); }} onPointerLeave={() => onPause(false, "pointer")} onFocusCapture={() => onPause(true, "focus")} onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) onPause(false, "focus"); }}>
      <Icon className="notice-icon" size={18} aria-hidden="true" />
      <span className="notice-copy" role={notice.kind === "error" ? "alert" : "status"} aria-atomic="true">{notice.message}</span>
      <button className="notice-dismiss" type="button" aria-label="关闭提示" onClick={onDismiss}><X size={16} aria-hidden="true" /></button>
    </div>}
  </div>;
}
