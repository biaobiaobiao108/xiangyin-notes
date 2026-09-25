function makeCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

const crcTable = makeCrcTable();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function updateCrc32(crc: number, bytes: Uint8Array) {
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 0xff];
  }
  return crc;
}

export type ZipEntry = {
  name: string;
  data: Uint8Array | string;
  mtime?: Date;
};

export type ZipStreamEntry = {
  name: string;
  mtime?: Date;
  stream: () => ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;
};

type ZipStreamRecord = {
  nameBytes: Uint8Array;
  crc: number;
  size: number;
  offset: number;
  dosTime: number;
  dosDate: number;
};

const ZIP32_MAX = 0xffffffff;

function dosDateTime(date: Date) {
  return {
    dosTime: ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff,
    dosDate: (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff,
  };
}

async function* readableStreamChunks(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        return;
      }
      if (value) yield value;
    }
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function* zipEntryChunks(entry: ZipStreamEntry) {
  const source = entry.stream();
  if (typeof (source as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === "function") {
    yield* source as AsyncIterable<Uint8Array>;
    return;
  }
  yield* readableStreamChunks(source as ReadableStream<Uint8Array>);
}

/**
 * Streams a ZIP archive using data descriptors so file bytes never need to be
 * retained while the central directory is being built. The archive remains
 * ZIP32-compatible; callers should enforce a total size below 4 GiB.
 */
export async function* createZipStream(entries: AsyncIterable<ZipStreamEntry>): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder();
  const records: ZipStreamRecord[] = [];
  const centralChunks: Uint8Array[] = [];
  let offset = 0;

  for await (const entry of entries) {
    if (records.length >= 0xffff) throw new Error("ZIP_ENTRY_LIMIT_EXCEEDED");
    const nameBytes = encoder.encode(entry.name.replaceAll("\\", "/"));
    if (nameBytes.length > 0xffff) throw new Error("ZIP_FILENAME_TOO_LONG");
    const { dosTime, dosDate } = dosDateTime(entry.mtime ?? new Date());
    const localOffset = offset;
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0808, true); // UTF-8 + data descriptor follows the file data
    localView.setUint16(8, 0, true);
    localView.setUint16(10, dosTime, true);
    localView.setUint16(12, dosDate, true);
    localView.setUint32(14, 0, true);
    localView.setUint32(18, 0, true);
    localView.setUint32(22, 0, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);
    yield localHeader;
    offset += localHeader.length;

    let crc = 0xffffffff;
    let size = 0;
    for await (const chunk of zipEntryChunks(entry)) {
      if (!(chunk instanceof Uint8Array)) throw new Error("ZIP_INVALID_CHUNK");
      size += chunk.byteLength;
      offset += chunk.byteLength;
      if (size > ZIP32_MAX || offset > ZIP32_MAX) throw new Error("ZIP32_SIZE_LIMIT_EXCEEDED");
      crc = updateCrc32(crc, chunk);
      yield chunk;
    }
    const descriptor = new Uint8Array(16);
    const descriptorView = new DataView(descriptor.buffer);
    descriptorView.setUint32(0, 0x08074b50, true);
    descriptorView.setUint32(4, (crc ^ 0xffffffff) >>> 0, true);
    descriptorView.setUint32(8, size, true);
    descriptorView.setUint32(12, size, true);
    yield descriptor;
    offset += descriptor.length;

    records.push({ nameBytes, crc: (crc ^ 0xffffffff) >>> 0, size, offset: localOffset, dosTime, dosDate });
  }

  const centralOffset = offset;
  for (const record of records) {
    const centralHeader = new Uint8Array(46 + record.nameBytes.length);
    const view = new DataView(centralHeader.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(8, 0x0808, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, record.dosTime, true);
    view.setUint16(14, record.dosDate, true);
    view.setUint32(16, record.crc, true);
    view.setUint32(20, record.size, true);
    view.setUint32(24, record.size, true);
    view.setUint16(28, record.nameBytes.length, true);
    view.setUint16(30, 0, true);
    view.setUint16(32, 0, true);
    view.setUint16(34, 0, true);
    view.setUint16(36, 0, true);
    view.setUint32(38, 0, true);
    view.setUint32(42, record.offset, true);
    centralHeader.set(record.nameBytes, 46);
    centralChunks.push(centralHeader);
    offset += centralHeader.length;
  }

  const centralSize = offset - centralOffset;
  if (centralOffset > ZIP32_MAX || centralSize > ZIP32_MAX) throw new Error("ZIP32_SIZE_LIMIT_EXCEEDED");
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(4, 0, true);
  eocdView.setUint16(6, 0, true);
  eocdView.setUint16(8, records.length, true);
  eocdView.setUint16(10, records.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, centralOffset, true);
  eocdView.setUint16(20, 0, true);

  for (const centralHeader of centralChunks) yield centralHeader;
  yield eocd;
}

export function createZipReadableStream(entries: AsyncIterable<ZipStreamEntry>) {
  const iterator = createZipStream(entries);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return(undefined);
    },
  }, { highWaterMark: 0 });
}

/**
 * Creates a standard ZIP archive (Store mode, UTF-8 filenames) in pure TypeScript.
 * Zero external npm dependencies.
 */
export function createZip(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const fileRecords: {
    nameBytes: Uint8Array;
    dataBytes: Uint8Array;
    crc: number;
    offset: number;
    dosTime: number;
    dosDate: number;
  }[] = [];

  let offset = 0;
  const localChunks: Uint8Array[] = [];

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name.replaceAll("\\", "/"));
    const dataBytes = typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data;
    const crc = crc32(dataBytes);
    const date = entry.mtime ?? new Date();

    const dosTime = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff;
    const dosDate = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(localHeader.buffer);

    view.setUint32(0, 0x04034b50, true); // Local file header signature
    view.setUint16(4, 20, true); // Version needed to extract (2.0)
    view.setUint16(6, 0x0800, true); // General purpose bit flag (bit 11 = UTF-8)
    view.setUint16(8, 0, true); // Compression method: 0 (Stored/Uncompressed)
    view.setUint16(10, dosTime, true);
    view.setUint16(12, dosDate, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, dataBytes.length, true); // Compressed size
    view.setUint32(22, dataBytes.length, true); // Uncompressed size
    view.setUint16(26, nameBytes.length, true);
    view.setUint16(28, 0, true); // Extra field length

    localHeader.set(nameBytes, 30);

    localChunks.push(localHeader, dataBytes);

    fileRecords.push({
      nameBytes,
      dataBytes,
      crc,
      offset,
      dosTime,
      dosDate,
    });

    offset += localHeader.length + dataBytes.length;
  }

  const centralOffset = offset;
  const centralChunks: Uint8Array[] = [];

  for (const rec of fileRecords) {
    const centralHeader = new Uint8Array(46 + rec.nameBytes.length);
    const view = new DataView(centralHeader.buffer);

    view.setUint32(0, 0x02014b50, true); // Central directory file header signature
    view.setUint16(4, 20, true); // Version made by
    view.setUint16(6, 20, true); // Version needed to extract
    view.setUint16(8, 0x0800, true); // General purpose bit flag (bit 11 = UTF-8)
    view.setUint16(10, 0, true); // Compression method: Store
    view.setUint16(12, rec.dosTime, true);
    view.setUint16(14, rec.dosDate, true);
    view.setUint32(16, rec.crc, true);
    view.setUint32(20, rec.dataBytes.length, true); // Compressed size
    view.setUint32(24, rec.dataBytes.length, true); // Uncompressed size
    view.setUint16(28, rec.nameBytes.length, true);
    view.setUint16(30, 0, true); // Extra field length
    view.setUint16(32, 0, true); // File comment length
    view.setUint16(34, 0, true); // Disk number where file starts
    view.setUint16(36, 0, true); // Internal file attributes
    view.setUint32(38, 0, true); // External file attributes
    view.setUint32(42, rec.offset, true); // Relative offset of local file header

    centralHeader.set(rec.nameBytes, 46);
    centralChunks.push(centralHeader);
    offset += centralHeader.length;
  }

  const centralSize = offset - centralOffset;

  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true); // End of central directory signature
  eocdView.setUint16(4, 0, true); // Number of this disk
  eocdView.setUint16(6, 0, true); // Disk where central directory starts
  eocdView.setUint16(8, fileRecords.length, true); // Number of central directory records on this disk
  eocdView.setUint16(10, fileRecords.length, true); // Total number of central directory records
  eocdView.setUint32(12, centralSize, true); // Size of central directory
  eocdView.setUint32(16, centralOffset, true); // Offset of start of central directory
  eocdView.setUint16(20, 0, true); // Comment length

  const totalLength = offset + eocd.length;
  const out = new Uint8Array(totalLength);
  let pos = 0;
  for (const chunk of [...localChunks, ...centralChunks, eocd]) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  return out;
}
