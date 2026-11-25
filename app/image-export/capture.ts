import { anySignal, createTimeoutSignal, waitForExport } from "./render";

export async function renderPageImage(page: HTMLElement, stage: HTMLElement, signal: AbortSignal) {
  signal.throwIfAborted();
  const { default: html2canvas } = await import("html2canvas");
  const captureSignal = anySignal([signal, createTimeoutSignal(20_000)]);
  captureSignal.throwIfAborted();
  const target = page.cloneNode(true) as HTMLElement;
  const body = document.body;
  stage.replaceChildren(target);
  let frame: Element | null = null;
  try {
    // html2canvas clones the document and WebKit waits for the clone's images.
    // Keep the stylesheets and the one export page, without the workspace DOM.
    const lastChild = body.lastElementChild;
    const capture = html2canvas(target, {
      scale: 2,
      backgroundColor: null,
      logging: false,
      imageTimeout: 15_000,
      ignoreElements: (element) => element.parentElement === body && element !== stage,
    }).then(async (canvas) => {
      try {
        captureSignal.throwIfAborted();
        return await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob(
            (result) => (result ? resolve(result) : reject(new Error("图片生成失败"))),
            "image/png",
          ),
        );
      } finally {
        canvas.width = 0;
        canvas.height = 0;
      }
    });
    const child = body.lastElementChild;
    if (child !== lastChild && child?.matches("iframe.html2canvas-container")) frame = child;
    return await waitForExport(capture, captureSignal);
  } catch (reason) {
    if (captureSignal.aborted && !signal.aborted) {
      throw new Error("生成图片超时，请重试");
    }
    throw reason;
  } finally {
    frame?.remove();
    target.remove();
  }
}
