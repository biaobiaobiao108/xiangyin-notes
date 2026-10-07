import { describe, expect, test } from "bun:test";

describe("empty trash action", () => {
  test("uses a named icon-only button in list, card, and mobile headers", async () => {
    const [list, cards, mobileHeader] = await Promise.all([
      Bun.file("app/workspace/panels.tsx").text(),
      Bun.file("app/workspace/note-card-grid.tsx").text(),
      Bun.file("app/workspace/mobile-collection-header.tsx").text(),
    ]);

    expect(list).toContain('className="icon-button empty-trash-button" type="button" aria-label="清空回收站" onClick={onEmptyTrash}');
    expect(list).not.toContain('!isMobileViewport && "清空回收站"');
    expect(list).not.toContain('title="清空回收站"');
    expect(cards).toContain('className="icon-button empty-trash-button card-grid-empty-trash"');
    expect(cards).toContain('aria-label="清空回收站"');
    expect(cards).not.toContain('title="清空回收站"');
    expect(cards).not.toContain("清空回收站</button>");
    expect(mobileHeader).toContain('className="icon-button empty-trash-button" type="button" aria-label="清空回收站" onClick={onEmptyTrash}');
    expect(mobileHeader).not.toContain('title="清空回收站"');
  });

  test("uses a muted theme color and reserves cinnabar for hover and focus", async () => {
    const css = await Bun.file("app/styles.css").text();
    expect(css).toMatch(/\.empty-trash-button\s*\{[^}]*color:\s*var\(--muted\)/s);
    expect(css).toMatch(/\.empty-trash-button:hover:not\(:disabled\),\s*\.empty-trash-button:focus-visible\s*\{[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;[^}]*color:\s*var\(--danger\)/s);
    expect(css).not.toMatch(/\.empty-trash-button:hover:not\(:disabled\),\s*\.empty-trash-button:focus-visible\s*\{[^}]*border-color:\s*var\(--danger-border\)/s);
  });
});
