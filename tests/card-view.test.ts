import { describe, expect, test } from "bun:test";
import { sortNotes, type NoteSort } from "../app/workspace/helpers";
import { assignCardMasonryLanes, cardLaneConfig, positionCardMasonryLanes, visibleCardIndexes } from "../app/workspace/card-masonry";
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

  test("assigns variable-height cards to masonry lanes and virtualizes by measured positions", () => {
    const config = cardLaneConfig(700, 900, false);
    expect(config.laneCount).toBe(2);
    const assignments = assignCardMasonryLanes(sampleNotes, config, false);
    expect(assignments.flatMap((lane) => lane.map((card) => card.index)).sort((a, b) => a - b)).toEqual([0, 1, 2]);

    const baseline = positionCardMasonryLanes(assignments, new Map(), Math.round(config.laneWidth), config.gap);
    const firstLaneFirstNote = assignments.find((lane) => lane.some((card) => card.index === 0))?.[0];
    expect(firstLaneFirstNote).toBeDefined();
    const measured = new Map([[firstLaneFirstNote!.note.id, { widthKey: Math.round(config.laneWidth), height: firstLaneFirstNote!.estimatedHeight + 120 }]]);
    const refined = positionCardMasonryLanes(assignments, measured, Math.round(config.laneWidth), config.gap);

    const laneIndex = assignments.findIndex((lane) => lane.some((card) => card.index === firstLaneFirstNote!.index));
    const nextCardIndex = assignments[laneIndex][1]?.index;
    if (nextCardIndex !== undefined) {
      const before = baseline[laneIndex].cards.find((card) => card.index === nextCardIndex)!;
      const after = refined[laneIndex].cards.find((card) => card.index === nextCardIndex)!;
      expect(after.top - before.top).toBe(120);
    }

    const visible = visibleCardIndexes(refined, 0, 300);
    expect(visible.size).toBeGreaterThan(0);
    expect([...visible].every((index) => index >= 0 && index < sampleNotes.length)).toBe(true);
  });

  test("chooses responsive lane counts without CSS masonry support", () => {
    expect(cardLaneConfig(330, 350, true).laneCount).toBe(1);
    expect(cardLaneConfig(500, 520, true).laneCount).toBe(2);
    expect(cardLaneConfig(820, 800, true).laneCount).toBe(3);
    expect(cardLaneConfig(1000, 1200, false).laneCount).toBe(3);
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
    expect(cardRule).toMatch(/border:\s*1px solid var\(--border\)/);
    expect(cardRule).toMatch(/box-shadow:\s*var\(--note-card-shadow\)/);
    expect(cssContent).toContain("--note-card-shadow: light-dark(0 1px 4px");
    expect(cssContent).toContain("0 2px 8px rgba(192, 202, 245, 0.08)");
    expect(cssContent).toMatch(/\.card-masonry-slot\s*\{[^}]*position:\s*absolute/);
    expect(cssContent).not.toMatch(/\.note-list-item\s*\{[^}]*content-visibility/);
    expect(cardRule).not.toContain("transform");
    const focusCardRule = cssContent.match(/\.note-card:focus-visible\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(focusCardRule).toMatch(/outline:\s*none/);
    expect(focusCardRule).toMatch(/box-shadow:\s*var\(--note-card-hover-shadow\)/);
    expect(focusCardRule).not.toContain("border-color");
    expect(cssContent).toContain("@media (hover: hover) and (pointer: fine)");
    expect(cssContent).toMatch(/\.note-card:hover\s*\{[^}]*box-shadow:\s*var\(--note-card-hover-shadow\)/);
    expect(cssContent).not.toMatch(/\.note-card:hover\s*\{[^}]*border-color:/);
    expect(cssContent).toContain("--note-card-hover-shadow: light-dark(0 4px 12px rgba(32, 38, 33, 0.12), 0 8px 22px rgba(192, 202, 245, 0.18))");
    expect(cssContent).toMatch(/\.sidebar\s*\{[^}]*border-right:\s*1px solid var\(--border\)/);
    expect(cssContent).toMatch(/\.card-masonry-slot:hover > \.note-card\s*\{[^}]*scale:\s*1\.015;[^}]*z-index:\s*1;/);
    expect(cssContent).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.card-masonry-slot:hover > \.note-card\s*\{\s*scale:\s*1;/);
    expect(cssContent).not.toMatch(/\.note-card\.is-selected\s*\{/);
    expect(cssContent).not.toContain(".note-card.is-selected > .note-card-foreground");
    expect(cssContent).toMatch(/\.card-masonry\s*\{[^}]*position:\s*relative/);
    expect(cssContent).not.toMatch(/\.card-masonry\s*\{[^}]*columns:/);
    expect(cssContent).not.toContain("display: grid-lanes");
  });
});
