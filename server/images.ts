const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_IMAGE_PIXELS = 40_000_000;

export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const IMAGE_ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export type ImageInspection = {
  mimeType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  width: number;
  height: number;
};

function ascii(bytes: Uint8Array, start: number, length: number) {
  return new TextDecoder().decode(bytes.slice(start, start + length));
}

function littleEndian16(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function littleEndian24(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function bigEndian32(bytes: Uint8Array, offset: number) {
  return bytes[offset] * 0x1000000 + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
}

function validDimensions(width: number, height: number) {
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width * height <= MAX_IMAGE_PIXELS;
}

function inspectPng(bytes: Uint8Array): ImageInspection | null {
  if (bytes.length < 24 || !PNG_SIGNATURE.every((value, index) => bytes[index] === value)) return null;
  const width = bigEndian32(bytes, 16);
  const height = bigEndian32(bytes, 20);
  return validDimensions(width, height) ? { mimeType: "image/png", width, height } : null;
}

function inspectGif(bytes: Uint8Array): ImageInspection | null {
  if (bytes.length < 10 || !["GIF87a", "GIF89a"].includes(ascii(bytes, 0, 6))) return null;
  const width = littleEndian16(bytes, 6);
  const height = littleEndian16(bytes, 8);
  return validDimensions(width, height) ? { mimeType: "image/gif", width, height } : null;
}

function inspectJpeg(bytes: Uint8Array): ImageInspection | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (!marker || marker === 0xd8 || marker === 0xd9) continue;
    if (marker === 0xda) break;
    if (offset + 2 > bytes.length) return null;
    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isSof && segmentLength >= 7) {
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      return validDimensions(width, height) ? { mimeType: "image/jpeg", width, height } : null;
    }
    offset += segmentLength;
  }
  return null;
}

function inspectWebp(bytes: Uint8Array): ImageInspection | null {
  if (bytes.length < 16 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") return null;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = ascii(bytes, offset, 4);
    const size = littleEndian32(bytes, offset + 4);
    const data = offset + 8;
    if (data + size > bytes.length) return null;
    if (type === "VP8X" && size >= 10) {
      const width = 1 + littleEndian24(bytes, data + 4);
      const height = 1 + littleEndian24(bytes, data + 7);
      return validDimensions(width, height) ? { mimeType: "image/webp", width, height } : null;
    }
    if (type === "VP8 " && size >= 14 && bytes[data + 6] === 0x9d && bytes[data + 7] === 0x01 && bytes[data + 8] === 0x2a) {
      const width = littleEndian16(bytes, data + 10) & 0x3fff;
      const height = littleEndian16(bytes, data + 12) & 0x3fff;
      return validDimensions(width, height) ? { mimeType: "image/webp", width, height } : null;
    }
    if (type === "VP8L" && size >= 5 && bytes[data] === 0x2f) {
      const width = 1 + (bytes[data + 1] | ((bytes[data + 2] & 0x3f) << 8));
      const height = 1 + ((bytes[data + 2] >> 6) | (bytes[data + 3] << 2) | ((bytes[data + 4] & 0x0f) << 10));
      return validDimensions(width, height) ? { mimeType: "image/webp", width, height } : null;
    }
    offset = data + size + (size % 2);
  }
  return null;
}

function littleEndian32(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] * 0x1000000);
}

export function inspectImage(bytes: Uint8Array): ImageInspection | null {
  return inspectPng(bytes) ?? inspectGif(bytes) ?? inspectJpeg(bytes) ?? inspectWebp(bytes);
}

export function extensionForMimeType(mimeType: ImageInspection["mimeType"]) {
  return mimeType === "image/jpeg" ? ".jpg" : mimeType === "image/png" ? ".png" : mimeType === "image/webp" ? ".webp" : ".gif";
}
