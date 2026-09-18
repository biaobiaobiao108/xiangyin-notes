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

export type ZipEntry = {
  name: string;
  data: Uint8Array | string;
  mtime?: Date;
};

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
