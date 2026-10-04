import { describe, expect, test } from "bun:test";
import { createUuid } from "../app/uuid";

describe("client UUID generation", () => {
  test("uses the native implementation when available", () => {
    const id = "e1364cf7-d04d-4f83-a0e2-8ee1e96675a5";
    expect(createUuid({ randomUUID: () => id })).toBe(id);
  });

  test("generates a valid v4 UUID from getRandomValues on local HTTP origins", () => {
    const id = createUuid({ getRandomValues: (bytes) => { bytes.fill(0xff); return bytes; } });
    expect(id).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  });

  test("falls back if neither Web Crypto UUID method is available", () => {
    expect(createUuid({})).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  });
});
