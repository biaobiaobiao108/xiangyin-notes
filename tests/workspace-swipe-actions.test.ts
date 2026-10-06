import { describe, expect, test } from "bun:test";
import { shouldKeepSwipeActionsOpenAfterCancel, shouldOpenSwipeActions } from "../app/workspace/swipe-actions";

describe("desktop note list separators", () => {
  test("uses an inset soft divider between note rows", async () => {
    const css = await Bun.file("app/styles.css").text();
    const separator = css.match(/\.note-list-items > li:has\(\.note-row\) \+ li:has\(\.note-row\)::before\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(separator).toContain("inset-inline: 22px");
    expect(separator).toContain("height: 1px");
    expect(separator).toContain("background: var(--line)");
  });

  test("contains row margins so highlight spacing stays even around dividers", async () => {
    const css = await Bun.file("app/styles.css").text();
    expect(css).toMatch(/\.note-row-swipe\s*\{\s*display:\s*flow-root;\s*\}/);
  });

  test("hides both separators around the selected or active row on desktop", async () => {
    const css = await Bun.file("app/styles.css").text();
    const desktopRules = css.slice(css.indexOf("@media (min-width: 901px)"));
    expect(desktopRules).toMatch(/li:has\(\.note-row\.is-selected\)::before/);
    expect(desktopRules).toMatch(/li:has\(\.note-row\.is-selected\) \+ li:has\(\.note-row\)::before/);
    expect(desktopRules).toMatch(/li:has\(\.note-row\.is-active\)::before/);
    expect(desktopRules).toMatch(/li:has\(\.note-row\.is-active\) \+ li:has\(\.note-row\)::before/);
    expect(desktopRules).toMatch(/\{ display: none; \}/);
  });
});

describe("mobile swipe actions", () => {
  test("does not keep the opened note highlighted in mobile lists", async () => {
    const css = await Bun.file("app/styles.css").text();
    const panels = await Bun.file("app/workspace/panels.tsx").text();
    const workspace = await Bun.file("app/workspace.tsx").text();
    expect(panels).toContain("isActive={selectedId === note.id && !isMobileViewport}");
    expect(workspace).toContain("if (!isMobileViewport) updateNoteSelection(nextSelection);");
    expect(css).not.toContain("--surface-card-swipe:");
  });

  test("mobile cards open on tap and expose no swipe actions", async () => {
    const source = await Bun.file("app/workspace/note-card-grid.tsx").text();
    const css = await Bun.file("app/styles.css").text();
    expect(source).toContain("onClick={handleCardClick}");
    expect(source).toContain("aria-label={`打开笔记：${displayTitle}`}");
    expect(source).not.toContain("useSwipeActionGesture");
    expect(source).not.toContain("swipe-action-buttons");
    expect(source).not.toContain("onNoteSwipeAction");
    expect(css).not.toMatch(/\.is-mobile-card-grid[^{}]*\.is-swipe-open/);
  });

  test("uses a raised white surface for selected items in the desktop sidebar", async () => {
    const css = await Bun.file("app/styles.css").text();
    expect(css).toMatch(/\.nav-item\.is-active\s*\{[^}]*background:\s*var\(--surface\);[^}]*color:\s*var\(--ink\);[^}]*box-shadow:\s*var\(--shadow-xs\);/s);
    expect(css).toMatch(/\.nav-item\.is-active svg\s*\{\s*color:\s*var\(--accent\);\s*\}/);
    expect(css).toMatch(/\.notebook-row-wrap\.is-active\s*\{[^}]*background:\s*var\(--surface\);[^}]*color:\s*var\(--ink\);[^}]*box-shadow:\s*var\(--shadow-xs\);/s);
    expect(css).toContain(".collapsed-notebook-item.is-active { background: var(--surface); box-shadow: var(--shadow-xs); }");
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
    expect(mobileCss).toContain(".mobile-home-group .mobile-notebook-row + .mobile-notebook-row::before { display: block; z-index: 2; }");
    expect(mobileCss).toContain(".mobile-home-group .mobile-notebook-row:has(.is-swipe-open)::before,");
    expect(mobileCss).toContain(".mobile-home-group .mobile-notebook-row:has(.is-swipe-open) + .mobile-notebook-row::before { display: none; }");
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
    expect(sharedCss).not.toContain(".is-mobile-card-grid .note-card.is-swipe-open");
    expect(sharedCss).toContain(".note-list-items > li:has(.note-row) + li:has(.note-row)::before {");
    expect(sharedCss).toMatch(/\.note-list-items > li:has\(\.note-row\) \+ li:has\(\.note-row\)::before\s*\{[^}]*z-index:\s*2;/s);
    expect(sharedCss).toContain(".note-list-items > li:has(.note-row) + li:has(.note-row):has(.is-swipe-open)::before,");
    expect(sharedCss).toContain(".note-list-items > li:has(.note-row):has(.is-swipe-open) + li:has(.note-row)::before { display: none; }");
  });

  test("returns keyboard focus to the foreground item after Escape closes actions", async () => {
    const source = await Bun.file("app/workspace/swipe-actions.ts").text();
    expect(source).toContain("foregroundRef.current?.matches(\"button\")");
    expect(source).toContain("foregroundRef.current.focus();");
  });

  test("exposes notebook and note actions through named buttons", async () => {
    const mobilePanels = await Bun.file("app/workspace/mobile-panels.tsx").text();
    const noteList = await Bun.file("app/workspace/panels.tsx").text();
    const noteCards = await Bun.file("app/workspace/note-card-grid.tsx").text();
    expect(mobilePanels).toContain("编辑笔记本：${notebook.name}");
    expect(mobilePanels).toContain("删除笔记本：${notebook.name}");
    expect(noteList).toContain("恢复笔记：${note.title");
    expect(noteList).toContain("彻底删除笔记：${note.title");
    expect(noteList).not.toContain("<span>恢复</span>");
    expect(noteList).not.toContain("<span>彻底删除</span>");
    expect(noteList).not.toContain("<span>移入回收站</span>");
    expect(noteCards).not.toContain("移入回收站：${displayTitle}");
    expect(noteCards).not.toContain("<span>恢复</span>");
    expect(noteCards).not.toContain("<span>彻底删除</span>");
    expect(noteCards).not.toContain("<span>移入回收站</span>");
  });
});
