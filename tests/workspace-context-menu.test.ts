import { describe, expect, test } from "bun:test";

describe("note context menu selection", () => {
  test("offers a selection toggle for note targets shared by list and card views", async () => {
    const source = await Bun.file("app/workspace.tsx").text();
    expect(source).toContain('target.closest<HTMLElement>("[data-note-id]")?.dataset.noteId');
    expect(source).toContain('selectedNoteIds.has(targetNote.id) ? "从多选中移除" : "加入多选"');
    expect(source).toContain("handleToggleCardSelection(targetNote.id, { ctrlKey: true })");
  });

  test("selection toggle preserves bulk actions without opening the note", async () => {
    const source = await Bun.file("app/workspace.tsx").text();
    const selectionHandler = source.slice(source.indexOf("const handleToggleCardSelection"), source.indexOf("const handleCardGridScrollPositionChange"));
    expect(selectionHandler).toContain("updateNoteSelection(nextSelection)");
    expect(selectionHandler).not.toContain("selectNote(");
    expect(source).toContain("selectedNoteIds.has(targetNote.id) && selectedNoteIds.size > 1");
    expect(source).toContain('`${view === "trash" ? "彻底删除" : "移入回收站"}所选 ${selectedNoteIds.size} 篇笔记`');
  });

  test("shows a subdued selection mark in list rows and cards", async () => {
    const list = await Bun.file("app/workspace/panels.tsx").text();
    const cards = await Bun.file("app/workspace/note-card-grid.tsx").text();
    const css = await Bun.file("app/styles.css").text();
    expect(list).toContain('isSelected && <span className="note-selection-mark"');
    expect(cards).toContain('isSelected && <span className="note-selection-mark"');
    expect(css).toMatch(/\.note-selection-mark\s*\{[^}]*width:\s*22px;[^}]*height:\s*22px;[^}]*border-radius:\s*50%;[^}]*background:\s*var\(--accent-soft\);[^}]*box-shadow:\s*var\(--shadow-2xs\)/s);
    expect(css).toContain(".note-row.is-active {");
    expect(css).not.toContain(".note-row.is-selected, .note-row.is-active");
    expect(css).not.toContain(".note-card.is-selected {");
  });

  test("offers bulk restore only for a selected trashed note in a multi-selection", async () => {
    const source = await Bun.file("app/workspace.tsx").text();
    expect(source).toContain('if (selectedNoteIds.has(targetNote.id) && selectedNoteIds.size > 1) items.push({ label: `恢复所选 ${selectedNoteIds.size} 篇笔记`');
    expect(source).toContain("disabled: busy, onSelect: restoreSelectedNotes");
    expect(source).toContain("api.restoreNotes(entries)");
  });
});
