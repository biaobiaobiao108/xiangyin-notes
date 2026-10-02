import { Editor } from "@tiptap/core";
import { createReadOnlyExtensions } from "../editor/read-only-markdown";

export type ImageExportSnapshot = { title: string; contentMarkdown: string };

/** Reuse the editor schema, but serialize to static HTML without mounting another editor. */
export function createSnapshotEditor(markdown: string) {
  return new Editor({
    element: null,
    editable: false,
    extensions: createReadOnlyExtensions(),
    content: markdown,
    contentType: "markdown",
  });
}

export function renderNoteSnapshot(snapshot: ImageExportSnapshot): HTMLElement {
  const editor = createSnapshotEditor(snapshot.contentMarkdown);
  try {
    const source = document.createElement("div");
    source.className = "note-prose read-only-prose";
    source.innerHTML = editor.getHTML();
    const title = document.createElement("h1");
    title.className = "image-export-title";
    title.textContent = snapshot.title || "未命名笔记";
    source.prepend(title);
    source.querySelectorAll("[contenteditable], [tabindex]").forEach((node) => {
      node.removeAttribute("contenteditable"); node.removeAttribute("tabindex");
    });
    // Width hints stored in Markdown must not make a table wider than the export page.
    source.querySelectorAll("table, col, th, td").forEach((node) => {
      node.removeAttribute("style"); node.removeAttribute("width");
    });
    source.querySelectorAll("img").forEach((image) => {
      image.loading = "eager";
      const width = Number(image.getAttribute("width"));
      if (width > 0 && Number.isFinite(width)) image.style.width = `${width}px`;
    });
    return source;
  } finally { editor.destroy(); }
}

export class UnavailableImagesError extends Error {
  constructor(public count: number) { super(`${count} 张图片无法读取。可以重试，或用占位块继续导出。`); }
}

export function waitForExport<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function prepareImages(source: HTMLElement, signal: AbortSignal, allowPlaceholders: boolean): Promise<() => void> {
  const urls: string[] = [];
  let missing = 0;
  const release = () => { urls.forEach((url) => URL.revokeObjectURL(url)); };
  try {
    for (const image of source.querySelectorAll("img")) {
      signal.throwIfAborted();
      const timeout = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
      try {
        const url = new URL(image.getAttribute("src") || "", location.href);
        if (!["http:", "https:", "data:", "blob:"].includes(url.protocol)) throw new Error("unsupported-image");
        if (url.protocol === "data:" || url.protocol === "blob:") {
          // img-src permits these sources; connect-src deliberately does not.
          image.src = url.href;
          await waitForExport(image.decode(), timeout);
        } else if (url.origin === location.origin) {
          const response = await fetch(url.href, { signal: timeout, credentials: "include" });
          if (!response.ok) throw new Error("image-fetch-failed");
          const blob = await response.blob();
          if (!blob.type.startsWith("image/") || blob.size > 20 * 1024 * 1024) throw new Error("invalid-image");
          const localUrl = URL.createObjectURL(blob);
          urls.push(localUrl); image.src = localUrl;
          await waitForExport(image.decode(), timeout);
        } else {
          // Keep external image reads under img-src and avoid broadening connect-src.
          const remote = new Image();
          remote.crossOrigin = "anonymous";
          remote.src = url.href;
          try {
            await waitForExport(remote.decode(), timeout);
            if (remote.naturalWidth * remote.naturalHeight > 20_000_000) throw new Error("image-too-large");
            const ratio = Math.min(1, 1248 / remote.naturalWidth, 2800 / remote.naturalHeight);
            const canvas = document.createElement("canvas");
            canvas.width = Math.max(1, Math.round(remote.naturalWidth * ratio));
            canvas.height = Math.max(1, Math.round(remote.naturalHeight * ratio));
            try {
              const context = canvas.getContext("2d");
              if (!context) throw new Error("canvas-unavailable");
              context.drawImage(remote, 0, 0, canvas.width, canvas.height);
              const blob = await waitForExport(new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new Error("image-conversion-failed")), "image/png")), timeout);
              const localUrl = URL.createObjectURL(blob);
              urls.push(localUrl); image.src = localUrl;
              await waitForExport(image.decode(), timeout);
            } finally { canvas.width = 0; canvas.height = 0; }
          } finally { remote.src = ""; }
        }
      } catch {
        signal.throwIfAborted();
        missing++;
        const placeholder = document.createElement("p");
        placeholder.className = "image-export-placeholder";
        placeholder.textContent = `图片无法读取${image.alt ? `：${image.alt}` : ""}`;
        image.replaceWith(placeholder);
      }
    }
    signal.throwIfAborted();
    if (missing && !allowPlaceholders) throw new UnavailableImagesError(missing);
    return release;
  } catch (error) { release(); throw error; }
}
