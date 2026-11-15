import type { MutableRefObject, RefObject } from "react";
import {
  ArrowLeftRight,
  CheckCircle,
  ChevronLeft,
  CircleAlert,
  Columns2,
  LayoutGrid,
  LoaderCircle,
  RefreshCw,
  SquareKanban,
  Star,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import type { ImageAssetSummary, Note } from "../../shared/types";
import { relativeDate } from "../format";
import { MobileEditorHeader } from "./mobile-editor-controls";

export type EditorSaveState = "idle" | "saving" | "saved" | "conflict" | "error";

type EditorHeaderProps = {
  isMobileViewport: boolean;
  note: Note;
  mobileBackLabel: string;
  editorLocked: boolean;
  trashBusy: boolean;
  backlinkCount: number;
  backlinksOpen: boolean;
  saveState: EditorSaveState;
  saveLabel: string;
  imageUploadState: "idle" | "uploading" | "error";
  imageUploadMessage: string;
  imageFileInputRef: RefObject<HTMLInputElement | null>;
  uploadImageFilesRef: MutableRefObject<(files: File[]) => void>;
  focusMode: boolean;
  autoReadingMode: boolean;
  isSplitActive: boolean;
  onUploadImage?: (
    file: File,
    dimensions: { width: number; height: number },
  ) => Promise<{ asset: ImageAssetSummary }>;
  onCloseSplit?: () => void;
  onToggleSplit?: () => void;
  onBackToKanban?: () => void;
  onBackToCards?: () => void;
  onOpenList?: () => void;
  onNavigateToNote?: (id: string) => void;
  onOpenBacklinks: () => void;
  onToggleFavorite: () => void;
  onMoveToTrash: () => void;
  onRestore: () => void;
  onPermanentDelete?: () => void;
  onToggleAutoReadingMode?: () => void;
  onExportImage: () => void;
  onSaveNow: () => void;
  onReloadNote: () => void;
};

function SaveStatusIcon({ state }: { state: Exclude<EditorSaveState, "idle"> }) {
  const iconProps = {
    className: "save-status-icon",
    size: 16,
    strokeWidth: 1.9,
    "aria-hidden": true,
  } as const;
  switch (state) {
    case "saving":
      return <LoaderCircle {...iconProps} />;
    case "conflict":
      return <RefreshCw {...iconProps} />;
    case "error":
      return <CircleAlert {...iconProps} />;
    case "saved":
    default:
      return <CheckCircle {...iconProps} />;
  }
}

export function EditorHeader({
  isMobileViewport,
  note,
  mobileBackLabel,
  editorLocked,
  trashBusy,
  backlinkCount,
  backlinksOpen,
  saveState,
  saveLabel,
  imageUploadState,
  imageUploadMessage,
  imageFileInputRef,
  uploadImageFilesRef,
  focusMode,
  autoReadingMode,
  isSplitActive,
  onUploadImage,
  onCloseSplit,
  onToggleSplit,
  onBackToKanban,
  onBackToCards,
  onOpenList,
  onNavigateToNote,
  onOpenBacklinks,
  onToggleFavorite,
  onMoveToTrash,
  onRestore,
  onPermanentDelete,
  onToggleAutoReadingMode,
  onExportImage,
  onSaveNow,
  onReloadNote,
}: EditorHeaderProps) {
  const handleSaveNow = onSaveNow;

  return isMobileViewport ? (
    <MobileEditorHeader
      noteId={note.id}
      title={note.title.trim() || "未命名笔记"}
      backLabel={mobileBackLabel}
      locked={editorLocked}
      trashBusy={trashBusy}
      deleted={Boolean(note.deletedAt)}
      favorite={note.isFavorite}
      backlinkCount={backlinkCount}
      onBack={onOpenList}
      canUpload={Boolean(onUploadImage) && !note.deletedAt && imageUploadState !== "uploading"}
      onUpload={() => imageFileInputRef.current?.click()}
      autoReadingMode={autoReadingMode}
      onToggleAutoReading={onToggleAutoReadingMode}
      onExport={onExportImage}
      onFavorite={onToggleFavorite}
      onBacklinks={onNavigateToNote ? () => onOpenBacklinks() : undefined}
      onTrash={onMoveToTrash}
      onRestore={onRestore}
      onPermanentDelete={onPermanentDelete}
      status={
        <>
          {saveState === "error" ? (
            <button
              className="save-status save-status--error save-status--icon"
              type="button"
              aria-label="重试保存"
              onClick={handleSaveNow}
            >
              <SaveStatusIcon state="error" />
            </button>
          ) : saveState === "conflict" ? (
            <button
              className="save-status save-status--conflict save-status--icon"
              type="button"
              aria-label="重新载入最新版本"
              onClick={onReloadNote}
            >
              <SaveStatusIcon state="conflict" />
            </button>
          ) : saveState !== "idle" ? (
            <span
              className={`save-status save-status--${saveState} save-status--icon`}
              role="status"
              aria-label={saveLabel}
            >
              <SaveStatusIcon state={saveState} />
            </span>
          ) : null}
          {imageUploadState !== "idle" && (
            <span
              className={`save-status save-status--${imageUploadState === "uploading" ? "saving" : "error"} save-status--icon mobile-upload-status`}
              role="status"
              aria-label={
                imageUploadState === "uploading"
                  ? "正在上传图片"
                  : imageUploadMessage || "图片上传失败"
              }
            >
              <SaveStatusIcon state={imageUploadState === "uploading" ? "saving" : "error"} />
            </span>
          )}
        </>
      }
    />
  ) : (
    <header className="editor-header">
      <div className="editor-header-start">
        {onBackToKanban && !focusMode && (
          <button
            className="icon-button editor-back-kanban"
            type="button"
            aria-label="返回看板"
            onClick={onBackToKanban}
            disabled={editorLocked}
          >
            <SquareKanban size={18} strokeWidth={1.8} />
          </button>
        )}
        {!onBackToKanban && onBackToCards && !focusMode && (
          <button
            className="icon-button editor-back-cards"
            type="button"
            aria-label="返回卡片视图"
            onClick={onBackToCards}
            disabled={editorLocked}
          >
            <LayoutGrid size={18} strokeWidth={1.8} />
          </button>
        )}
        {onOpenList && !focusMode && (
          <button
            className="icon-button mobile-only editor-back"
            type="button"
            aria-label="返回笔记列表"
            onClick={onOpenList}
            disabled={editorLocked}
          >
            <ChevronLeft size={20} />
          </button>
        )}
        <div className="editor-meta" aria-label={`最后编辑于${relativeDate(note.updatedAt)}`}>
          <span>最后编辑于 {relativeDate(note.updatedAt)}</span>
        </div>
      </div>
      <div
        className="editor-header-title"
        aria-label={`当前文档：${note.title.trim() || "未命名笔记"}`}
      >
        {note.title.trim() || "未命名笔记"}
      </div>
      <div className="editor-actions">
        {saveState === "error" ? (
          <button
            className="save-status save-status--error save-status--action save-status--icon"
            type="button"
            aria-label="重试保存"
            onClick={handleSaveNow}
          >
            <SaveStatusIcon state="error" />
          </button>
        ) : saveState === "conflict" ? (
          <button
            className="save-status save-status--conflict save-status--action save-status--icon"
            type="button"
            aria-label="重新载入最新版本"
            onClick={onReloadNote}
          >
            <SaveStatusIcon state="conflict" />
          </button>
        ) : saveState === "idle" ? null : (
          <span
            className={`save-status save-status--${saveState} save-status--icon`}
            role="status"
            aria-label={saveLabel}
            aria-live="polite"
          >
            <SaveStatusIcon state={saveState} />
          </span>
        )}
        {onUploadImage && !note.deletedAt && (
          <input
            ref={imageFileInputRef}
            className="visually-hidden"
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            multiple
            tabIndex={-1}
            aria-label="选择要上传的图片文件"
            onChange={(event) => {
              uploadImageFilesRef.current(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
          />
        )}
        {imageUploadState === "uploading" && (
          <span
            className="save-status save-status--saving save-status--icon"
            role="status"
            aria-label="正在上传图片"
            aria-live="polite"
          >
            <SaveStatusIcon state="saving" />
          </span>
        )}
        {imageUploadState === "error" && (
          <span
            className="save-status save-status--error save-status--icon"
            role="alert"
            aria-label={imageUploadMessage || "图片上传失败"}
          >
            <SaveStatusIcon state="error" />
          </span>
        )}
        {!note.deletedAt && onNavigateToNote && (
          <button
            className={`icon-button ${backlinksOpen ? "is-active" : ""}`}
            type="button"
            aria-label={`反向链接${backlinkCount > 0 ? ` (${backlinkCount})` : ""}`}
            onClick={() => onOpenBacklinks()}
            disabled={editorLocked}
          >
            <ArrowLeftRight size={18} strokeWidth={1.8} />
            {backlinkCount > 0 && <span className="icon-badge">{backlinkCount}</span>}
          </button>
        )}
        <button
          className={`icon-button favorite-toggle ${note.isFavorite ? "is-active" : ""}`}
          type="button"
          aria-label={note.isFavorite ? "取消收藏" : "收藏笔记"}
          aria-pressed={note.isFavorite}
          onClick={onToggleFavorite}
          disabled={editorLocked}
        >
          <Star
            size={19}
            strokeWidth={1.8}
            fill={note.isFavorite ? "currentColor" : "none"}
            aria-hidden="true"
          />
        </button>
        {note.deletedAt ? (
          <>
            <button
              className="icon-button"
              type="button"
              aria-label="恢复笔记"
              onClick={onRestore}
              disabled={editorLocked || trashBusy}
            >
              <Undo2 size={18} strokeWidth={1.8} />
            </button>
            {onPermanentDelete && (
              <button
                className="icon-button danger-button"
                type="button"
                aria-label="彻底删除"
                onClick={onPermanentDelete}
                disabled={editorLocked || trashBusy}
              >
                <Trash2 size={18} strokeWidth={1.8} />
              </button>
            )}
          </>
        ) : (
          <button
            className="icon-button"
            type="button"
            aria-label="移入回收站"
            onClick={onMoveToTrash}
            disabled={editorLocked || trashBusy}
          >
            <Trash2 size={18} strokeWidth={1.8} />
          </button>
        )}
        {!isMobileViewport && onCloseSplit && (
          <button
            className="icon-button close-split-button"
            type="button"
            aria-label="关闭分屏"
            onClick={onCloseSplit}
          >
            <X size={18} strokeWidth={1.8} />
          </button>
        )}
        {!isMobileViewport && onToggleSplit && !onCloseSplit && (
          <button
            className={`icon-button split-toggle ${isSplitActive ? "is-active" : ""}`}
            type="button"
            aria-label={isSplitActive ? "关闭分屏" : "分屏显示"}
            onClick={onToggleSplit}
            disabled={editorLocked}
          >
            <Columns2 size={18} strokeWidth={1.8} />
          </button>
        )}
      </div>
    </header>
  );
}
