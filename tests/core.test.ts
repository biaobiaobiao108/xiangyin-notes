import { describe, expect, test } from "bun:test";
import { buildFtsQuery, constantTimeEqual, createOpaqueToken, derivePassword, formatPreview, hashPassword } from "../server/index";

describe("security helpers", () => {
  test("creates URL-safe opaque tokens", () => {
    const token = createOpaqueToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBeGreaterThan(40);
  });

  test("hashes and verifies passwords with a unique salt", async () => {
    const first = await hashPassword("a long passphrase for testing");
    const second = await hashPassword("a long passphrase for testing");
    expect(first.salt).not.toBe(second.salt);
    expect(await derivePassword("a long passphrase for testing", first.salt)).toBe(first.hash);
    expect(await derivePassword("wrong passphrase", first.salt)).not.toBe(first.hash);
    expect(constantTimeEqual(first.hash, first.hash)).toBe(true);
    expect(constantTimeEqual(first.hash, second.hash)).toBe(false);
  });
});

describe("markdown and search helpers", () => {
  test("removes markdown syntax from note previews", () => {
    expect(formatPreview("# Heading\n\nA **quiet** note with `code`.")) .toBe("Heading A quiet note with code.");
  });

  test("keeps preview work bounded for long markdown bodies", () => {
    expect(formatPreview(`${"x".repeat(1_000_000)} tail`)).toBe("x".repeat(180));
    expect(formatPreview(`before\n\n\`\`\`ts\n${"code ".repeat(100_000)}\n\`\`\`\nafter`)).toBe("before after");
  });

  test("quotes search terms for FTS", () => {
    expect(buildFtsQuery("quiet thinking")).toBe('"quiet" AND "thinking"');
  });
});
