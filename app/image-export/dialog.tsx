import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Download, ImageDown, X } from "lucide-react";
import { FloatingScrollbar } from "../floating-scrollbar";
import { createZipReadableStream, type ZipStreamEntry } from "../../shared/zip";
import { IMAGE_PAGE_WIDTH, paginateNote } from "./pagination";
import {
  anySignal,
  createTimeoutSignal,
  prepareImages,
  renderNoteSnapshot,
  UnavailableImagesError,
  waitForExport,
  type ImageExportSnapshot,
} from "./render";
import { renderPageImage } from "./capture";
import { imageExportFilename } from "./filename";
import { collectExportArchive } from "./stream";
import "./image-export.css";

const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
export function ImageExportDialog({
  snapshot,
  onClose,
}: {
  snapshot: ImageExportSnapshot;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLElement[]>([]);
  const controllerRef = useRef<AbortController | null>(null);
  const releaseImagesRef = useRef<(() => void) | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [pageIndex, setPageIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("正在排版……");
  const [error, setError] = useState("");
  const [missingImages, setMissingImages] = useState(false);

  const showPage = useCallback((index: number) => {
    const page = pagesRef.current[index];
    if (!page) return;
    previewRef.current?.replaceChildren(page);
    setPageIndex(index);
    setStatus(`第 ${index + 1} / ${pagesRef.current.length} 页`);
    scrollRef.current?.scrollTo({ top: 0 });
  }, []);

  const renderPage = (index: number, signal: AbortSignal) => {
    const page = pagesRef.current[index];
    const stage = stageRef.current;
    if (!page || !stage) throw new Error("页面尚未就绪");
    return renderPageImage(page, stage, signal);
  };

  const prepare = useCallback(
    async (allowPlaceholders = false) => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      const { signal } = controller;
      setBusy(true);
      setError("");
      setMissingImages(false);
      setStatus("正在排版……");
      setPageCount(0);
      previewRef.current?.replaceChildren();
      releaseImagesRef.current?.();
      releaseImagesRef.current = null;
      pagesRef.current = [];
      const stage = stageRef.current;
      if (!stage) return;
      // Mermaid images are rasterized during preparation. Keep the preview and all captures in that theme.
      const colorScheme = getComputedStyle(document.documentElement).colorScheme;
      stage.style.colorScheme = colorScheme;
      if (previewRef.current) previewRef.current.style.colorScheme = colorScheme;
      stage.replaceChildren();
      try {
        await waitForExport(document.fonts.ready, anySignal([signal, createTimeoutSignal(15_000)]));
        signal.throwIfAborted();
        const source = renderNoteSnapshot(snapshot);
        const sourcePage = document.createElement("article");
        sourcePage.className = "image-export-page";
        sourcePage.append(source);
        stage.append(sourcePage);
        releaseImagesRef.current = await prepareImages(source, signal, allowPlaceholders);
        pagesRef.current = await paginateNote(source, stage, signal);
        stage.replaceChildren();
        setPageCount(pagesRef.current.length);
        showPage(0);
      } catch (reason) {
        if (signal.aborted) return;
        setMissingImages(reason instanceof UnavailableImagesError);
        setError(reason instanceof Error ? reason.message : "图片导出失败，请重试");
        setStatus("生成失败");
        pagesRef.current = [];
        stage.replaceChildren();
        releaseImagesRef.current?.();
        releaseImagesRef.current = null;
        setPageCount(0);
      } finally {
        if (controllerRef.current === controller) setBusy(false);
      }
    },
    [showPage, snapshot],
  );

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    const preview = previewRef.current;
    const observer = new ResizeObserver(([entry]) => {
      if (preview && entry) {
        preview.style.setProperty(
          "--preview-scale",
          String(Math.min(1, entry.contentRect.width / IMAGE_PAGE_WIDTH)),
        );
      }
    });
    if (scrollRef.current) observer.observe(scrollRef.current);
    void prepare();
    return () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
      releaseImagesRef.current?.();
      observer.disconnect();
      preview?.replaceChildren();
      pagesRef.current = [];
      if (dialog.open) dialog.close();
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [prepare]);

  const download = (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    // Modal dialogs make the rest of the document inert.
    dialogRef.current?.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };
  const run = async (operation: (signal: AbortSignal) => Promise<void>) => {
    if (busy) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setBusy(true);
    setError("");
    try {
      await operation(controller.signal);
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(reason instanceof Error ? reason.message : "导出失败，请重试");
    } finally {
      if (controllerRef.current === controller) {
        setBusy(false);
        setStatus(`第 ${pageIndex + 1} / ${pagesRef.current.length} 页`);
      }
    }
  };
  const downloadAll = () =>
    run(async (signal) => {
      let total = 0;
      async function* entries(): AsyncGenerator<ZipStreamEntry> {
        for (let index = 0; index < pagesRef.current.length; index++) {
          signal.throwIfAborted();
          setStatus(`正在生成 ${index + 1} / ${pagesRef.current.length} 页……`);
          const blob = await renderPage(index, signal);
          total += blob.size;
          if (total > MAX_ARCHIVE_BYTES)
            throw new Error("图片总大小超过 128 MiB，请分篇导出或逐页下载");
          yield { name: imageExportFilename(snapshot.title, index), stream: () => blob.stream() };
        }
      }
      const stream = createZipReadableStream(entries());
      const blob = await collectExportArchive(stream, signal, MAX_ARCHIVE_BYTES);
      signal.throwIfAborted();
      download(blob, imageExportFilename(snapshot.title).replace(/\.png$/u, ".zip"));
    });

  return (
    <dialog
      ref={dialogRef}
      className="image-export-dialog"
      aria-labelledby="image-export-heading"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
            event.preventDefault();
        }
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const rect = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom
          )
            onClose();
        }
      }}
    >
      <header className="image-export-heading">
        <div>
          <h2 id="image-export-heading">
            <ImageDown size={20} />
            导出图片
          </h2>
          <p>文人笔记 · PNG · 长篇自动分页</p>
        </div>
        <button className="icon-button" type="button" aria-label="关闭图片导出" onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      <div className="image-export-preview-shell">
        <div
          ref={scrollRef}
          id="image-export-scroll"
          className="image-export-preview"
          aria-busy={busy}
        >
          <div
            role={pageCount ? "img" : undefined}
            aria-label={pageCount ? `${snapshot.title}，第 ${pageIndex + 1} 页导出预览` : undefined}
          >
            <div ref={previewRef} className="image-export-preview-page" inert />
          </div>
          {!pageCount && (
            <p className="image-export-message" role="status">
              {status}
            </p>
          )}
        </div>
        <FloatingScrollbar
          scrollTargetRef={scrollRef}
          contentRef={previewRef}
          controlsId="image-export-scroll"
          ariaLabel="图片预览滚动条"
          placement="right"
        />
      </div>
      {error && (
        <div className="image-export-error" role="alert">
          <p>{error}</p>
          <button
            className="secondary-button"
            type="button"
            disabled={busy}
            onClick={() => void prepare()}
          >
            重试
          </button>
          {missingImages && (
            <button
              className="secondary-button"
              type="button"
              disabled={busy}
              onClick={() => void prepare(true)}
            >
              用占位块继续
            </button>
          )}
        </div>
      )}
      <footer className="image-export-actions">
        <div className="image-export-pagination">
          <button
            className="icon-button"
            type="button"
            aria-label="上一页预览"
            disabled={busy || pageIndex === 0 || !pageCount}
            onClick={() => showPage(pageIndex - 1)}
          >
            <ChevronLeft size={18} />
          </button>
          <span role="status" aria-live="polite">
            {status}
          </span>
          <button
            className="icon-button"
            type="button"
            aria-label="下一页预览"
            disabled={busy || pageIndex >= pageCount - 1}
            onClick={() => showPage(pageIndex + 1)}
          >
            <ChevronRight size={18} />
          </button>
        </div>
        <div className="image-export-downloads">
          {busy && (
            <button className="secondary-button" type="button" onClick={onClose}>
              取消
            </button>
          )}
          <button
            className={pageCount > 1 ? "secondary-button" : "primary-button"}
            type="button"
            disabled={busy || !pageCount}
            onClick={() =>
              void run(async (signal) => {
                setStatus(`正在生成第 ${pageIndex + 1} 页……`);
                download(
                  await renderPage(pageIndex, signal),
                  imageExportFilename(snapshot.title, pageCount > 1 ? pageIndex : undefined),
                );
              })
            }
          >
            <Download size={16} />
            {pageCount > 1 ? "下载当前页" : "下载 PNG"}
          </button>
          {pageCount > 1 && (
            <button
              className="primary-button"
              type="button"
              disabled={busy}
              onClick={() => void downloadAll()}
            >
              <Download size={16} />
              打包下载 ZIP
            </button>
          )}
        </div>
      </footer>
      {createPortal(
        <div ref={stageRef} className="image-export-stage" aria-hidden="true" inert />,
        document.body,
      )}
    </dialog>
  );
}
