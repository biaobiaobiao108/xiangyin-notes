import { describe, expect, test } from "bun:test";
import { shouldKeepSwipeActionsOpenAfterCancel, shouldOpenSwipeActions } from "../app/workspace/swipe-actions";

describe("mobile swipe actions", () => {
  test("uses the same fill-only selection feedback in the desktop sidebar", async () => {
    const css = await Bun.file("app/styles.css").text();
    expect(css).toMatch(/\.nav-item\.is-active\s*\{[^}]*background:\s*var\(--accent-soft\);[^}]*box-shadow:\s*none;/s);
    expect(css).toMatch(/\.notebook-row-wrap\.is-active\s*\{[^}]*background:\s*var\(--accent-soft\);[^}]*box-shadow:\s*none;/s);
    expect(css).toContain(".collapsed-notebook-item.is-active { background: var(--accent-soft); box-shadow: none; }");
  });

  test("opens after a decisive left drag but does not auto-run an action", () => {
    expect(shouldOpenSwipeActions(-58, 144, 0)).toBe(true);
    expect(shouldOpenSwipeActions(-56, 144, 0)).toBe(false);
    expect(shouldOpenSwipeActions(-12, 144, -0.36)).toBe(true);
  });

  test("a rightward release closes an open action tray", () => {
    expect(shouldOpenSwipeActions(-54, 144, 0.45)).toBe(false);
    expect(shouldOpenSwipeActions(0, 144, 0)).toBe(false);
  });

  test("keeps a decisively revealed tray open if Safari cancels the touch sequence", () => {
    expect(shouldKeepSwipeActionsOpenAfterCancel(-58, 144)).toBe(true);
    expect(shouldKeepSwipeActionsOpenAfterCancel(-56, 144)).toBe(false);
  });

  test("keeps vertical scrolling available and translates only the swipe foreground", async () => {
    const css = await Bun.file("app/styles.css").text();
    const source = await Bun.file("app/workspace/swipe-actions.ts").text();
    expect(css).toContain("touch-action: pan-y");
    expect(css).toContain(".is-swipe-open > .swipe-action-foreground");
    expect(source).toContain('foreground.addEventListener("touchmove", onTouchMove, { passive: false })');
    expect(source).toContain('if ("ontouchstart" in window) return;');
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

  test("highlights the opened notebook row, hides its separator, and keeps notebook actions icon-only", async () => {
    const mobileCss = await Bun.file("app/workspace/mobile-panels.css").text();
    const mobilePanels = await Bun.file("app/workspace/mobile-panels.tsx").text();
    expect(mobileCss).toContain(".mobile-notebook-swipe.is-swipe-open > .mobile-notebook-link--editable { background: var(--accent-soft)");
    expect(mobileCss).toContain(".mobile-home-group .mobile-notebook-row + .mobile-notebook-row::before { display: none; }");
    expect(mobilePanels).not.toContain("<span>编辑</span>");
    expect(mobilePanels).not.toContain("<span>删除</span>");
    expect(mobilePanels).toContain("aria-label={`编辑笔记本：${notebook.name}`}");
    expect(mobilePanels).toContain("aria-label={`删除笔记本：${notebook.name}`}");
  });

  test("removes sticky touch highlights and uses fill-only focus and swipe feedback", async () => {
    const mobileCss = await Bun.file("app/workspace/mobile-panels.css").text();
    const sharedCss = await Bun.file("app/styles.css").text();
    const customNotebookFeedback = mobileCss.slice(
      mobileCss.indexOf(".mobile-notebook-row .mobile-notebook-link--editable:hover"),
      mobileCss.indexOf(".mobile-notebook-row .swipe-action-button"),
    );
    expect(mobileCss).toContain("-webkit-tap-highlight-color: transparent");
    expect(customNotebookFeedback).not.toContain("surface-hover");
    expect(customNotebookFeedback).toContain("background: var(--surface)");
    expect(customNotebookFeedback).toContain(":focus-visible,");
    expect(customNotebookFeedback).toContain("background: var(--accent-soft)");
    expect(customNotebookFeedback).not.toContain("box-shadow");

    expect(sharedCss).toContain(".note-row-swipe.is-swipe-open > .note-row { background: var(--accent-soft); border-color: transparent; box-shadow: none; }");
    expect(sharedCss).toContain(".is-mobile-card-grid .note-card.is-swipe-open { border-color: transparent; box-shadow: var(--note-card-shadow); }");
    expect(sharedCss).toContain(".is-mobile-card-grid .note-card.is-swipe-open > .note-card-foreground { background: var(--accent-soft); }");
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
