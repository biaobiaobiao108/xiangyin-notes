import { expect, test } from "bun:test";
import { createZipReadableStream, type ZipStreamEntry } from "../server/zip";

test("ZIP generation follows reader demand and stops after cancellation", async () => {
  let opened = 0;
  let closed = false;
  async function* entries(): AsyncGenerator<ZipStreamEntry> {
    try {
      for (let index = 0; index < 100; index += 1) {
        opened += 1;
        yield { name: `${index}.md`, stream: async function* () { yield new Uint8Array(1024); } };
      }
    } finally {
      closed = true;
    }
  }

  const stream = createZipReadableStream(entries());
  const reader = stream.getReader();
  await Promise.resolve();
  expect(opened).toBe(0);
  const first = await reader.read();
  expect(first.done).toBe(false);
  expect(opened).toBe(1);
  await reader.cancel();
  expect(closed).toBe(true);
  expect(opened).toBe(1);
});

test("cancelling a ZIP download closes its active attachment stream", async () => {
  let cancelled = false;
  async function* entries(): AsyncGenerator<ZipStreamEntry> {
    yield {
      name: "attachment.bin",
      stream: () => new ReadableStream<Uint8Array>({
        pull(controller) { controller.enqueue(new Uint8Array(1024)); },
        cancel() { cancelled = true; },
      }),
    };
  }

  const reader = createZipReadableStream(entries()).getReader();
  await reader.read();
  await reader.read();
  await reader.cancel();
  expect(cancelled).toBe(true);
});
