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
});
