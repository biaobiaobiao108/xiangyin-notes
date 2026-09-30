import { describe, expect, test } from "bun:test";
import { inspectImage } from "../server/images";

// A complete 1 × 1 lossy VP8 WebP, including the three-byte frame tag.
const lossyWebp = Uint8Array.from(Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64"));

describe("WebP image inspection", () => {
  test("recognizes a regular lossy WebP", () => {
    expect(inspectImage(lossyWebp)).toEqual({ mimeType: "image/webp", width: 1, height: 1 });
  });

  test("excludes VP8 scaling bits from the dimensions", () => {
    const bytes = lossyWebp.slice();
    bytes[26] = 0x40;
    bytes[27] = 0xc1;
    bytes[28] = 0xf0;
    bytes[29] = 0x80;
    expect(inspectImage(bytes)).toEqual({ mimeType: "image/webp", width: 320, height: 240 });
  });

  test("rejects truncated data and invalid frame signatures", () => {
    expect(inspectImage(lossyWebp.slice(0, 29))).toBeNull();
    const bytes = lossyWebp.slice();
    bytes[23] = 0;
    expect(inspectImage(bytes)).toBeNull();
  });

  test("rejects zero and excessive dimensions", () => {
    const bytes = lossyWebp.slice();
    bytes[26] = 0;
    expect(inspectImage(bytes)).toBeNull();
    bytes.set([0xff, 0x3f, 0xff, 0x3f], 26);
    expect(inspectImage(bytes)).toBeNull();
  });
});
