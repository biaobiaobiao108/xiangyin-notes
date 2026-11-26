import { describe, expect, test } from "bun:test";
import {
  clampImagePan,
  clampImageZoom,
  imageClippedEdges,
  imageLightboxFit,
  imagePanBounds,
  imageZoomStep,
} from "../app/image-lightbox";

describe("Image lightbox zoom", () => {
  test("fits large content without upscaling small content", () => {
    const wide = imageLightboxFit(1000, 500, 800, 600);
    expect(wide.width).toBe(768);
    expect(wide.height).toBe(401);
    expect(wide.scale).toBeLessThan(1);

    const small = imageLightboxFit(200, 100, 800, 600);
    expect(small.width).toBe(234);
    expect(small.height).toBe(134);
    expect(small.scale).toBe(1);
  });

  test("steps in predictable quarters and clamps to the supported range", () => {
    expect(imageZoomStep(100, 1)).toBe(125);
    expect(imageZoomStep(100, -1)).toBe(75);
    expect(imageZoomStep(385, 1)).toBe(400);
    expect(imageZoomStep(30, -1)).toBe(25);
    expect(clampImageZoom(1000)).toBe(400);
    expect(clampImageZoom(1)).toBe(25);
  });

  test("calculates and clamps pan only when the scaled frame overflows", () => {
    const base = { width: 768, height: 401 };
    const stage = { width: 800, height: 600 };
    expect(imagePanBounds(base, stage, 100)).toEqual({ x: 0, y: 0 });

    const bounds = imagePanBounds(base, stage, 200);
    expect(bounds).toEqual({ x: 368, y: 101 });
    expect(clampImagePan({ x: 400, y: -200 }, bounds)).toEqual({ x: 368, y: -101 });
  });

  test("marks only the clipped edges as content is panned", () => {
    const base = { width: 768, height: 401 };
    const stage = { width: 800, height: 600 };
    expect(imageClippedEdges(base, stage, 100, { x: 0, y: 0 })).toEqual({
      left: false,
      right: false,
      top: false,
      bottom: false,
      visible: { left: 33, top: 116.5, width: 734, height: 367 },
    });
    expect(imageClippedEdges(base, stage, 200, { x: 0, y: 0 })).toEqual({
      left: true,
      right: true,
      top: true,
      bottom: true,
      visible: { left: 0, top: 0, width: 800, height: 600 },
    });
    expect(imageClippedEdges(base, stage, 200, { x: 368, y: 101 })).toEqual({
      left: false,
      right: true,
      top: false,
      bottom: true,
      visible: { left: 34, top: 34, width: 766, height: 566 },
    });
  });
});
