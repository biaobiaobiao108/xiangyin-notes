import { CircleAlert, X } from "lucide-react";
import type { RefObject } from "react";
import { BrandMark } from "../brand-mark";
import { FloatingScrollbar } from "../floating-scrollbar";

export function EditorUploadNotice({
  message,
  messageId,
  messageRef,
  onDismiss,
}: {
  message: string;
  messageId: string;
  messageRef: RefObject<HTMLDivElement | null>;
  onDismiss: () => void;
}) {
  return (
    <div className="editor-upload-notice toast toast--error">
      <CircleAlert className="notice-icon" size={18} aria-hidden="true" />
      <div className="editor-upload-notice-body">
        <div
          id={messageId}
          ref={messageRef}
          className="notice-copy editor-upload-notice-copy floating-scrollbar-target"
          role="alert"
          aria-atomic="true"
        >
          {message}
        </div>
        <FloatingScrollbar
          scrollTargetRef={messageRef}
          controlsId={messageId}
          ariaLabel="图片上传提示滚动条"
          placement="right"
        />
      </div>
      <button
        type="button"
        className="notice-dismiss"
        aria-label="关闭图片上传提示"
        onClick={onDismiss}
      >
        <X size={16} />
      </button>
    </div>
  );
}

export function EditorSwitchOverlay({ label }: { label: string }) {
  return (
    <div
      className="editor-switch-overlay editor-switch-overlay--visible"
      role="status"
      aria-live="polite"
    >
      <div className="editor-switch-card">
        <BrandMark className="editor-switch-mark" />
        <div className="editor-switch-lines" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <strong>{label}</strong>
      </div>
    </div>
  );
}
