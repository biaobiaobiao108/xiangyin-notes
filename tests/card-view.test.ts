import { describe, expect, test } from "bun:test";
import { sortNotes, type NoteSort } from "../app/workspace/helpers";
import type { NoteSummary } from "../shared/types";
import { applyNoteSelectionClick, isNoteSelectionModifierClick } from "../app/workspace/note-list-selection";

describe("card view & layout", () => {
  const sampleNotes: NoteSummary[] = [
    {
      id: "note-1",
      title: "关于文人笔记的思考",
      preview: "这篇笔记讨论的是文人笔墨的内敛与留白...",
      notebookId: "nb-1",
      notebookName: "随笔",
      isFavorite: false,
      deletedAt: null,
      version: 1,
      createdAt: 1000,
      updatedAt: 3000,
      tags: ["思考", "写作"],
      thumbnail: null,
    },
    {
      id: "note-2",
      title: "象映设计规范",
      preview: "暖白画布与松柏军绿的视觉调色板...",
      notebookId: "nb-1",
      notebookName: "随笔",
      isFavorite: true,
      deletedAt: null,
      version: 2,
      createdAt: 2000,
      updatedAt: 5000,
      tags: ["设计"],
      thumbnail: {
        id: "thumb-1",
        url: "/api/assets/thumb-1",
        originalName: "preview.png",
        mimeType: "image/png",
        byteSize: 1024,
        width: 400,
        height: 300,
        createdAt: 2000,
      },
    },
    {
      id: "note-3",
      title: "每日代办事项",
      preview: "1. 完善卡片视图 2. 编写测试",
      notebookId: "nb-2",
      notebookName: "工作",
      isFavorite: false,
      deletedAt: null,
      version: 1,
      createdAt: 500,
      updatedAt: 1500,
      tags: [],
      thumbnail: null,
    },
  ];

  test("sorts notes correctly for card grid display", () => {
    // Sort by updated time (descending)
    const sortedByUpdated = sortNotes(sampleNotes, "updated");
    expect(sortedByUpdated.map((n) => n.id)).toEqual(["note-2", "note-1", "note-3"]);

    // Sort by created time (descending)
    const sortedByCreated = sortNotes(sampleNotes, "created");
    expect(sortedByCreated.map((n) => n.id)).toEqual(["note-2", "note-1", "note-3"]);

    // Sort by title (alphabetical zh-CN)
    const sortedByTitle = sortNotes(sampleNotes, "title");
    expect(sortedByTitle.map((n) => n.title)).toEqual([
      "关于文人笔记的思考",
      "每日代办事项",
      "象映设计规范",
    ]);
  });

  test("card selection with modifier keys supports multi-select", () => {
    const noteIds = sampleNotes.map((n) => n.id);
    // Click note-1 with Cmd/Ctrl
    const state1 = applyNoteSelectionClick({ ids: new Set(), anchorId: null }, noteIds, {
      id: "note-1",
      metaKey: true,
    });
    expect([...state1.ids]).toEqual(["note-1"]);

    // Toggle note-2 with Cmd/Ctrl
    const state2 = applyNoteSelectionClick(state1, noteIds, {
      id: "note-2",
      metaKey: true,
    });
    expect(state2.ids.has("note-1")).toBe(true);
    expect(state2.ids.has("note-2")).toBe(true);
    expect(state2.ids.size).toBe(2);

    // Deselect note-1 with Cmd/Ctrl
    const state3 = applyNoteSelectionClick(state2, noteIds, {
      id: "note-1",
      ctrlKey: true,
    });
    expect([...state3.ids]).toEqual(["note-2"]);
  });

  test("shift-click is a selection modifier and starts a range when no anchor exists", () => {
    expect(isNoteSelectionModifierClick({ shiftKey: true })).toBe(true);

    const state = applyNoteSelectionClick({ ids: new Set(), anchorId: null }, sampleNotes.map((note) => note.id), {
      id: "note-2",
      shiftKey: true,
    });

    expect([...state.ids]).toEqual(["note-2"]);
    expect(state.anchorId).toBe("note-2");
  });

  test("card thumbnail and snippet extraction", () => {
    const withThumb = sampleNotes.find((n) => n.thumbnail);
    expect(withThumb?.thumbnail?.id).toBe("thumb-1");

    const withoutThumb = sampleNotes.find((n) => !n.thumbnail);
    expect(withoutThumb?.preview).toContain("文人笔墨");
  });

  test("Safari card layout avoids fragmented shadows and keeps card content painted", async () => {
    const cssContent = await Bun.file("app/styles.css").text();
    expect(cssContent).toContain(".note-card {");
    const cardRule = cssContent.match(/(?:^|\n)\.note-card\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(cardRule).not.toMatch(/content-visibility|contain-intrinsic-size/);
    expect(cardRule).toMatch(/box-shadow:\s*0 1px 4px/);
    expect(cardRule).toMatch(/-webkit-column-break-inside:\s*avoid/);
    expect(cssContent).not.toMatch(/\.note-list-item\s*\{[^}]*content-visibility/);
    expect(cardRule).not.toContain("transform");
    expect(cssContent).toContain("@media (hover: hover) and (pointer: fine)");
    expect(cssContent).toMatch(/\.note-card:hover\s*\{[^}]*box-shadow:\s*0 1px 5px/);
    expect(cssContent).toMatch(/\.note-card\.is-selected\s*\{[^}]*box-shadow:.*0 1px 5px/);
    expect(cssContent).toMatch(/\.card-masonry\s*\{[^}]*columns:\s*3\s+280px/);
    const gridLanesRule = cssContent.match(/@supports \(display: grid-lanes\)\s*\{\s*\.card-masonry\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(gridLanesRule).toMatch(/display:\s*grid-lanes/);
    expect(gridLanesRule).toMatch(/grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
    expect(gridLanesRule).toMatch(/columns:\s*unset/);
    expect(cssContent).toMatch(/\.card-masonry > \.note-card\s*\{\s*margin-block-end:\s*0;/);
    const responsiveCardGridRule = cssContent.slice(cssContent.lastIndexOf("@media (max-width: 900px)"));
    expect(responsiveCardGridRule).toMatch(/\.card-masonry\s*\{[^}]*columns:\s*1\s*[;}]/);
    expect(responsiveCardGridRule).toMatch(/\.card-masonry\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });
});
