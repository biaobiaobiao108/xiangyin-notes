/** Collect bounded ZIP bytes while allowing cancellation of the active reader. */
export async function collectExportArchive(stream: ReadableStream<Uint8Array>, signal: AbortSignal, maxBytes: number): Promise<Blob> {
  signal.throwIfAborted();
  const reader = stream.getReader();
  const cancel = () => { void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: ArrayBuffer[] = [];
  let bytes = 0;
  let completed = false;
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) { completed = true; break; }
      bytes += next.value.byteLength;
      if (bytes > maxBytes) throw new Error("图片总大小超过 128 MiB，请分篇导出或逐页下载");
      chunks.push(next.value.slice().buffer as ArrayBuffer);
    }
    return new Blob(chunks, { type: "application/zip" });
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!completed) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
