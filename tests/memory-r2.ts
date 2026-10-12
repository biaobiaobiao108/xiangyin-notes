import type { R2BucketBinding, R2ObjectBinding } from "../server/core";

export class MemoryR2Bucket implements R2BucketBinding {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType?: string; uploaded: Date }>();

  async put(key: string, value: ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array>, options?: { httpMetadata?: { contentType?: string } }) {
    let bytes: Uint8Array;
    if (value instanceof ReadableStream) bytes = new Uint8Array(await new Response(value).arrayBuffer());
    else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
    else bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
    this.objects.set(key, { bytes, contentType: options?.httpMetadata?.contentType, uploaded: new Date() });
  }

  async get(key: string): Promise<R2ObjectBinding | null> {
    const object = this.objects.get(key);
    if (!object) return null;
    const bytes = object.bytes.slice();
    return {
      body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
      httpMetadata: { contentType: object.contentType },
      async arrayBuffer() { return bytes.slice().buffer; },
    };
  }

  async delete(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }

  async list(options: { prefix?: string; limit?: number; cursor?: string } = {}) {
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(options.prefix ?? "")).sort();
    const start = options.cursor ? Math.max(0, keys.findIndex((key) => key > options.cursor!)) : 0;
    const page = keys.slice(start, start + (options.limit ?? 1000));
    const truncated = start + page.length < keys.length;
    return {
      objects: page.map((key) => ({ key, uploaded: this.objects.get(key)!.uploaded })),
      truncated,
      ...(truncated ? { cursor: page.at(-1) } : {}),
    };
  }
}
