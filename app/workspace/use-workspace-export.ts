import { useCallback, useState, type RefObject } from "react";
import type { Note } from "../../shared/types";
import type { ImageExportSnapshot } from "../image-export/render";

type WorkspaceExportOptions = {
  selectedRef: RefObject<Note | null>;
  isNoteLoading: boolean;
  flushEditorDraftRef: RefObject<() => void>;
  flushPendingSaves: (mode: "now") => Promise<void>;
  hasUnsavedWork: () => boolean;
  notifyWarning: (message: string) => void;
  notifyError: (message: string) => void;
};

export function useWorkspaceExport({
  selectedRef,
  isNoteLoading,
  flushEditorDraftRef,
  flushPendingSaves,
  hasUnsavedWork,
  notifyWarning,
  notifyError,
}: WorkspaceExportOptions) {
  const [imageExportSnapshot, setImageExportSnapshot] = useState<ImageExportSnapshot | null>(null);

  const handleExportNote = useCallback(async () => {
    const note = selectedRef.current;
    if (!note || isNoteLoading) return;

    try {
      flushEditorDraftRef.current();
      await flushPendingSaves("now");
      if (hasUnsavedWork()) {
        notifyWarning("仍有内容未保存，请保存成功后再导出");
        return;
      }
      const a = document.createElement("a");
      a.href = `/api/notes/${encodeURIComponent(note.id)}/export`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      notifyError("导出失败，请检查网络后重试");
    }
  }, [
    flushEditorDraftRef,
    flushPendingSaves,
    hasUnsavedWork,
    isNoteLoading,
    notifyError,
    notifyWarning,
    selectedRef,
  ]);

  const handleExportLibrary = useCallback(async () => {
    try {
      flushEditorDraftRef.current();
      await flushPendingSaves("now");
      if (hasUnsavedWork()) {
        notifyWarning("仍有内容未保存，请保存成功后再导出");
        return;
      }
      const params = new URLSearchParams({
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      const exportUrl = `/api/export/library?${params}`;
      const response = await fetch(exportUrl, { method: "HEAD" });
      if (!response.ok) throw new Error(`Export check failed: ${response.status}`);
      const a = document.createElement("a");
      a.href = exportUrl;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      notifyError("整库导出失败，请检查网络、附件和服务端日志后重试");
    }
  }, [flushEditorDraftRef, flushPendingSaves, hasUnsavedWork, notifyError, notifyWarning]);

  const handleExportImage = useCallback(() => {
    flushEditorDraftRef.current();
    const note = selectedRef.current;
    if (!note || isNoteLoading) return;
    setImageExportSnapshot({ title: note.title, contentMarkdown: note.contentMarkdown });
  }, [flushEditorDraftRef, isNoteLoading, selectedRef]);
  const closeImageExport = useCallback(() => setImageExportSnapshot(null), []);

  return {
    imageExportSnapshot,
    handleExportNote,
    handleExportLibrary,
    handleExportImage,
    closeImageExport,
  };
}
