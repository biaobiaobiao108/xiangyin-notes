import { describe, expect, test } from "bun:test";
import {
  isExternalImageSource,
  parseImageSource,
  serializeImageSource,
} from "../app/image-markdown";

describe("image markdown helpers", () => {
  test("round-trips display dimensions while preserving other URL parts", () => {
    const source = "/api/assets/image.png?download=1#preview";
    const serialized = serializeImageSource(source, 480, 320);
    expect(serialized).toBe("/api/assets/image.png?download=1&w=480&h=320#preview");
    expect(parseImageSource(serialized)).toEqual({ src: source, width: 480, height: 320 });
  });

  test("preserves raw encoding in local query parameters when extracting display dimensions", () => {
    const source = "/api/image.png?download=a%2Fb&w=480&h=320&token=x+y";
    expect(parseImageSource(source)).toEqual({
      src: "/api/image.png?download=a%2Fb&token=x+y",
      width: 480,
      height: 320,
    });
  });

  test("preserves external image URLs and query strings byte-for-byte", () => {
    const source =
      "https://images.example/photo.png?signature=a%2Fb&w=original&h=auto&x=1+2#preview";
    expect(parseImageSource(source)).toEqual({ src: source, width: null, height: null });
    expect(serializeImageSource(source, 480, 320)).toBe(source);
  });

  test("preserves nonnumeric size parameters and encoding in local source queries", () => {
    const source = "/api/image.png?download=a%2Fb&w=original&h=auto&token=x+y";
    expect(parseImageSource(source)).toEqual({ src: source, width: null, height: null });
    expect(parseImageSource("/api/image.png?w=480&h=auto")).toEqual({
      src: "/api/image.png?w=480&h=auto",
      width: null,
      height: null,
    });
  });

  test("identifies remote image URLs while keeping uploaded asset paths local", () => {
    expect(isExternalImageSource("https://images.example/photo.png")).toBe(true);
    expect(isExternalImageSource("https:/images.example/photo.png")).toBe(true);
    expect(isExternalImageSource("//images.example/photo.png")).toBe(true);
    expect(isExternalImageSource("/api/assets/photo.png")).toBe(false);
    expect(isExternalImageSource("blob:https://app.example/image-id")).toBe(false);
  });
});
