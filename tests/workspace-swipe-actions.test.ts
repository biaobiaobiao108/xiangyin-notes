import { describe, expect, test } from "bun:test";
import { shouldOpenSwipeActions } from "../app/workspace/swipe-actions";

describe("mobile swipe actions", () => {
  test("opens after a decisive left drag but does not auto-run an action", () => {
    expect(shouldOpenSwipeActions(-58, 144, 0)).toBe(true);
    expect(shouldOpenSwipeActions(-56, 144, 0)).toBe(false);
    expect(shouldOpenSwipeActions(-12, 144, -0.36)).toBe(true);
  });

  test("a rightward release closes an open action tray", () => {
    expect(shouldOpenSwipeActions(-54, 144, 0.45)).toBe(false);
    expect(shouldOpenSwipeActions(0, 144, 0)).toBe(false);
  });

  test("keeps vertical scrolling available and translates only the swipe foreground", async () => {
    const css = await Bun.file("app/styles.css").text();
    const source = await Bun.file("app/workspace/swipe-actions.ts").text();
    expect(css).toContain("touch-action: pan-y");
    expect(css).toContain(".is-swipe-open > .swipe-action-foreground");
    expect(source).toContain('event.pointerType !== "touch"');
    expect(source).toContain("HORIZONTAL_INTENT_RATIO");
  });

  test("keeps closed actions covered and renders round action icons", async () => {
    const css = await Bun.file("app/styles.css").text();
    const mobileCss = await Bun.file("app/workspace/mobile-panels.css").text();
    expect(css).toContain(".swipe-action-icon { display: grid; place-items: center; width: 42px; height: 42px; border-radius: 50%");
    expect(css).toContain(".note-row-swipe > .note-row { background: var(--surface); }");
    expect(mobileCss).toContain(".mobile-notebook-row .mobile-notebook-link--editable { background: var(--surface); }");
  });

  test("returns keyboard focus to the foreground item after Escape closes actions", async () => {
    const source = await Bun.file("app/workspace/swipe-actions.ts").text();
    expect(source).toContain('foreground?.querySelector<HTMLButtonElement>(".note-card-open")');
    expect(source).toContain("focusTarget?.focus();");
  });

  test("exposes notebook and note actions through named buttons", async () => {
    const mobilePanels = await Bun.file("app/workspace/mobile-panels.tsx").text();
    const noteList = await Bun.file("app/workspace/panels.tsx").text();
    const noteCards = await Bun.file("app/workspace/note-card-grid.tsx").text();
    expect(mobilePanels).toContain("编辑笔记本：${notebook.name}");
    expect(mobilePanels).toContain("删除笔记本：${notebook.name}");
    expect(noteList).toContain("恢复笔记：${note.title");
    expect(noteList).toContain("彻底删除笔记：${note.title");
    expect(noteCards).toContain("移入回收站：${displayTitle}");
  });
});
