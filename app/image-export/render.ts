import { Editor } from "@tiptap/core";
import { createReadOnlyExtensions, prepareMarkdownForReadOnly } from "../editor/read-only-markdown";
import { findLongTextRuns } from "../../shared/long-text-wrap";
import {
  diagramErrorMessage,
  diagramImage,
  measureDiagram,
  renderDiagram,
} from "../mermaid/render";
import { isMermaidLanguage } from "../mermaid/protocol";

export type ImageExportSnapshot = { title: string; contentMarkdown: string };

/** Reuse the editor schema, but serialize to static HTML without mounting another editor. */
export function createSnapshotEditor(markdown: string) {
  return new Editor({
    element: null,
    editable: false,
    extensions: createReadOnlyExtensions(),
    content: prepareMarkdownForReadOnly(markdown),
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
      node.removeAttribute("contenteditable");
      node.removeAttribute("tabindex");
    });
    // Width hints stored in Markdown must not make a table wider than the export page.
    source.querySelectorAll("table, col, th, td").forEach((node) => {
      node.removeAttribute("style");
      node.removeAttribute("width");
    });
    source.querySelectorAll("img").forEach((image) => {
      image.loading = "eager";
      const width = Number(image.getAttribute("width"));
      if (width > 0 && Number.isFinite(width)) image.style.width = `${width}px`;
    });
    appendAnnotationNotes(source);
    addLongTextBreaks(source);
    return source;
  } finally {
    editor.destroy();
  }
}

function addLongTextBreaks(source: HTMLElement) {
  const walker = document.createTreeWalker(source, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if ((node as Text).length >= 28) textNodes.push(node as Text);
  }
  for (const node of textNodes) {
    const text = node.data;
    const inlineCode = node.parentElement?.matches("code") && !node.parentElement.closest("pre");
    const runs = findLongTextRuns(text, inlineCode);
    let cursor = 0;
    let content: DocumentFragment | undefined;
    for (const run of runs) {
      content ??= document.createDocumentFragment();
      content.append(text.slice(cursor, run.index));
      const span = document.createElement("span");
      span.className = "long-text-run";
      span.textContent = run[0];
      content.append(span);
      cursor = run.index + run[0].length;
    }
    if (!content) continue;
    content.append(text.slice(cursor));
    node.replaceWith(content);
  }
}

function appendAnnotationNotes(source: HTMLElement) {
  const annotations = source.querySelectorAll<HTMLElement>("[data-annotation-id][data-note]");
  const notes: Array<{ id: string; note: string; first: HTMLElement }> = [];
  const seen = new Set<string>();
  for (const annotation of annotations) {
    const id = annotation.dataset.annotationId ?? "";
    const note = annotation.dataset.note?.trim() ?? "";
    if (!id || !note || seen.has(id)) continue;
    seen.add(id);
    notes.push({ id, note, first: annotation });
  }
  if (!notes.length) return;

  notes.forEach(({ first }, index) => {
    const reference = document.createElement("sup");
    reference.className = "image-export-annotation-ref";
    reference.textContent = String(index + 1);
    reference.setAttribute("aria-hidden", "true");
    first.insertAdjacentElement("afterend", reference);
  });

  const section = document.createElement("section");
  section.className = "image-export-annotations";
  const heading = document.createElement("h2");
  heading.textContent = "批注";
  const list = document.createElement("ol");
  for (const { note } of notes) {
    const item = document.createElement("li");
    item.textContent = note;
    list.append(item);
  }
  section.append(heading, list);
  source.append(section);
}

export class UnavailableImagesError extends Error {
  constructor(public count: number) {
    super(`${count} 张图片无法读取。可以重试，或用占位块继续导出。`);
  }
}

export function waitForExport<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function createTimeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException("The operation timed out.", "TimeoutError"));
  }, ms);
  controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  return controller.signal;
}

export function anySignal(signals: readonly AbortSignal[]): AbortSignal {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function") {
    return AbortSignal.any(signals as AbortSignal[]);
  }
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

async function imageToPng(
  image: HTMLImageElement,
  width: number,
  height: number,
  signal: AbortSignal,
) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  try {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("canvas-unavailable");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await waitForExport(
      new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (result) => (result ? resolve(result) : reject(new Error("image-conversion-failed"))),
          "image/png",
        ),
      ),
      signal,
    );
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

async function prepareDiagrams(source: HTMLElement, signal: AbortSignal, urls: string[]) {
  for (const code of source.querySelectorAll<HTMLElement>("pre > code")) {
    const language = [...code.classList].find((name) => name.startsWith("language-"));
    if (!isMermaidLanguage(language?.slice("language-".length))) continue;

    signal.throwIfAborted();
    const pre = code.parentElement!;
    const markdown = code.textContent ?? "";
    let svgUrl: string | undefined;
    try {
      const container = pre.parentElement!;
      const layout = measureDiagram(container);
      const result = await renderDiagram({ ...layout, source: markdown }, signal);
      const themed = diagramImage(result, container);
      svgUrl = themed.url;
      const svg = new Image();
      svg.src = svgUrl;
      const timeout = anySignal([signal, createTimeoutSignal(5_000)]);
      await waitForExport(svg.decode(), timeout);

      // Give pagination the scaled dimensions and pass only a raster image to the page renderer.
      const scale = Math.min(1, layout.width / result.width, 1400 / result.height);
      const width = Math.max(1, Math.floor(result.width * scale));
      const height = Math.max(1, Math.floor(result.height * scale));
      const png = await imageToPng(svg, width * 2, height * 2, timeout);
      const image = new Image(width, height);
      image.className = "image-export-diagram";
      image.alt = themed.alt;
      image.style.width = `${width}px`;
      image.src = URL.createObjectURL(png);
      urls.push(image.src);
      await waitForExport(image.decode(), timeout);
      pre.replaceWith(image);
    } catch (reason) {
      signal.throwIfAborted();
      const description = document.createElement("span");
      description.className = "image-export-diagram-error";
      description.textContent = `图表无法渲染 · ${diagramErrorMessage(reason)}\n`;
      pre.prepend(description);
    } finally {
      if (svgUrl) URL.revokeObjectURL(svgUrl);
    }
  }
}

export async function prepareImages(
  source: HTMLElement,
  signal: AbortSignal,
  allowPlaceholders: boolean,
): Promise<() => void> {
  const urls: string[] = [];
  let missing = 0;
  const release = () => {
    urls.forEach((url) => URL.revokeObjectURL(url));
  };
  try {
    await prepareDiagrams(source, signal, urls);
    for (const image of source.querySelectorAll<HTMLImageElement>(
      "img:not(.image-export-diagram)",
    )) {
      signal.throwIfAborted();
      const timeout = anySignal([signal, createTimeoutSignal(15_000)]);
      try {
        const url = new URL(image.getAttribute("src") || "", location.href);
        if (!["http:", "https:", "data:", "blob:"].includes(url.protocol))
          throw new Error("unsupported-image");
        if (url.protocol === "data:" || url.protocol === "blob:") {
          // img-src permits these sources; connect-src deliberately does not.
          image.src = url.href;
          await waitForExport(image.decode(), timeout);
        } else if (url.origin === location.origin) {
          const response = await fetch(url.href, { signal: timeout, credentials: "include" });
          if (!response.ok) throw new Error("image-fetch-failed");
          const blob = await response.blob();
          if (!blob.type.startsWith("image/") || blob.size > 20 * 1024 * 1024)
            throw new Error("invalid-image");
          const localUrl = URL.createObjectURL(blob);
          urls.push(localUrl);
          image.src = localUrl;
          await waitForExport(image.decode(), timeout);
        } else {
          // Keep external image reads under img-src and avoid broadening connect-src.
          const remote = new Image();
          remote.crossOrigin = "anonymous";
          remote.src = url.href;
          try {
            await waitForExport(remote.decode(), timeout);
            if (remote.naturalWidth * remote.naturalHeight > 20_000_000)
              throw new Error("image-too-large");
            const ratio = Math.min(1, 1248 / remote.naturalWidth, 2800 / remote.naturalHeight);
            const blob = await imageToPng(
              remote,
              remote.naturalWidth * ratio,
              remote.naturalHeight * ratio,
              timeout,
            );
            const localUrl = URL.createObjectURL(blob);
            urls.push(localUrl);
            image.src = localUrl;
            await waitForExport(image.decode(), timeout);
          } finally {
            remote.src = "";
          }
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
  } catch (error) {
    release();
    throw error;
  }
}
