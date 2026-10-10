import { describe, expect, test } from "bun:test";
import { isExternalImageSource, parseImageSource, serializeImageSource } from "../app/image-markdown";

describe("image markdown helpers", () => {
  test("round-trips display dimensions while preserving other URL parts", () => {
    const source = "/api/assets/image.png?download=1#preview";
    const serialized = serializeImageSource(source, 480, 320);
    expect(serialized).toBe("/api/assets/image.png?download=1&w=480&h=320#preview");
    expect(parseImageSource(serialized)).toEqual({ src: source, width: 480, height: 320 });
  });

  test("identifies remote image URLs while keeping uploaded asset paths local", () => {
    expect(isExternalImageSource("https://images.example/photo.png")).toBe(true);
    expect(isExternalImageSource("https:/images.example/photo.png")).toBe(true);
    expect(isExternalImageSource("//images.example/photo.png")).toBe(true);
    expect(isExternalImageSource("/api/assets/photo.png")).toBe(false);
    expect(isExternalImageSource("blob:https://app.example/image-id")).toBe(false);
  });

});
