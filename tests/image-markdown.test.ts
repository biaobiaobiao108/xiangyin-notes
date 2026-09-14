import { describe, expect, test } from "bun:test";
import { firstImageSource, localImageId, parseImageSource, replaceLocalImageReferences, serializeImageSource } from "../app/image-markdown";

describe("image markdown helpers", () => {
  test("round-trips display dimensions while preserving other URL parts", () => {
    const source = "/api/assets/image.png?download=1#preview";
    const serialized = serializeImageSource(source, 480, 320);
    expect(serialized).toBe("/api/assets/image.png?download=1&w=480&h=320#preview");
    expect(parseImageSource(serialized)).toEqual({ src: source, width: 480, height: 320 });
  });

  test("extracts the first image and rewrites offline references without losing dimensions", () => {
    const markdown = "正文\n\n![本地图](offline-image://11111111-1111-4111-8111-111111111111?w=640&h=360)\n\n![第二张](/api/assets/22222222-2222-4222-8222-222222222222)";
    const first = firstImageSource(markdown);
    expect(first).toBe("offline-image://11111111-1111-4111-8111-111111111111?w=640&h=360");
    expect(localImageId(first!)).toBe("11111111-1111-4111-8111-111111111111");
    const replaced = replaceLocalImageReferences(markdown, new Map([["11111111-1111-4111-8111-111111111111", "/api/assets/33333333-3333-4333-8333-333333333333"]]));
    expect(replaced).toContain("/api/assets/33333333-3333-4333-8333-333333333333?w=640&h=360");
    expect(replaced).not.toContain("offline-image://");
  });
});
