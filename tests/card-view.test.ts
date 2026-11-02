import { describe, expect, test } from "bun:test";
import { sortNotes, type NoteSort } from "../app/workspace/helpers";
import {
  assignCardMasonryLanes,
  cardLaneConfig,
  estimateCardHeight,
  positionCardMasonryLanes,
  visibleCardIndexes,
} from "../app/workspace/card-masonry";
import type { NoteSummary } from "../shared/types";
import {
  applyNoteSelectionClick,
  isNoteSelectionModifierClick,
  resolveNoteClickAction,
} from "../app/workspace/note-list-selection";

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
    expect(
      assignments.flatMap((lane) => lane.map((card) => card.index)).sort((a, b) => a - b),
    ).toEqual([0, 1, 2]);

    const baseline = positionCardMasonryLanes(
      assignments,
      new Map(),
      Math.round(config.laneWidth),
      config.gap,
    );
    const firstLaneFirstNote = assignments.find((lane) =>
      lane.some((card) => card.index === 0),
    )?.[0];
    expect(firstLaneFirstNote).toBeDefined();
    const measured = new Map([
      [
        firstLaneFirstNote!.note.id,
        {
          widthKey: Math.round(config.laneWidth),
          height: firstLaneFirstNote!.estimatedHeight + 120,
        },
      ],
    ]);
    const refined = positionCardMasonryLanes(
      assignments,
      measured,
      Math.round(config.laneWidth),
      config.gap,
    );

    const laneIndex = assignments.findIndex((lane) =>
      lane.some((card) => card.index === firstLaneFirstNote!.index),
    );
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

  test("estimates immutable note snapshots against their current text and lane configuration", () => {
    const config = cardLaneConfig(700, 900, false);
    const original = sampleNotes[0];
    const originalAssignment = assignCardMasonryLanes([original], config, false)
      .flat()
      .find((assignment) => assignment.note.id === original.id)!;
    expect(originalAssignment.estimatedHeight).toBe(
      estimateCardHeight(original, config.laneWidth, false),
    );

    const changedSnapshot = { ...original, title: original.title.repeat(8) };
    const changedAssignment = assignCardMasonryLanes([changedSnapshot], config, false)
      .flat()
      .find((assignment) => assignment.note.id === original.id)!;
    expect(changedAssignment.estimatedHeight).toBe(
      estimateCardHeight(changedSnapshot, config.laneWidth, false),
    );
    expect(changedAssignment.estimatedHeight).toBeGreaterThan(originalAssignment.estimatedHeight);

    const mobileConfig = cardLaneConfig(350, 350, true);
    const mobileAssignment = assignCardMasonryLanes([original], mobileConfig, true).flat()[0];
    expect(mobileAssignment.estimatedHeight).toBe(
      estimateCardHeight(original, mobileConfig.laneWidth, true),
    );
  });

  test("preserves multiline and Unicode card heights while resizing in both layouts", () => {
    const note: NoteSummary = {
      ...sampleNotes[0],
      title: "中文 title 😀\r\n第二行\n",
      preview: "短段落。\r\n\n" + "中A😀 ".repeat(30),
    };
    // 固定原有布局结果，覆盖 CRLF、空行及中英文和表情混排。
    const cases: Array<[number, number, number]> = [
      [100, 412, 293],
      [180, 340, 293],
      [280, 292, 271],
      [420, 268, 249],
    ];
    for (const [width, desktopHeight, mobileHeight] of [...cases, ...cases.slice().reverse()]) {
      expect(estimateCardHeight(note, width, false)).toBe(desktopHeight);
      expect(estimateCardHeight(note, width, true)).toBe(mobileHeight);
    }
  });

  test("refreshes cached height when text, cover or layout changes at the same width", () => {
    const note: NoteSummary = {
      ...sampleNotes[0],
      title: "中文 title 😀\r\n第二行\n",
      preview: "短段落。\r\n\n" + "中A😀 ".repeat(30),
    };
    expect(estimateCardHeight(note, 180, false)).toBe(340);
    note.title = "新标题".repeat(40);
    note.preview = "";
    expect(estimateCardHeight(note, 180, false)).toBe(196);
    note.thumbnail = sampleNotes[1]!.thumbnail;
    expect(estimateCardHeight(note, 180, false)).toBe(336);
    expect(estimateCardHeight(note, 180, true)).toBe(299);
    note.title = "";
    note.thumbnail = null;
    expect(estimateCardHeight(note, 180, false)).toBe(148);
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

  test("plain card clicks toggle selection while multi-select is active", () => {
    expect(resolveNoteClickAction({}, { hasSelectionActive: false })).toEqual({ action: "open" });
    expect(resolveNoteClickAction({}, { hasSelectionActive: true })).toEqual({
      action: "toggle",
      modifiers: { ctrlKey: true },
    });
    expect(resolveNoteClickAction({ shiftKey: true }, { hasSelectionActive: false })).toEqual({
      action: "toggle",
      modifiers: { shiftKey: true },
    });
    // 移动端没有修饰键，点按始终打开笔记。
    expect(
      resolveNoteClickAction(
        { ctrlKey: true },
        { hasSelectionActive: true, isMobileViewport: true },
      ),
    ).toEqual({ action: "open" });
  });

  test("shift-click is a selection modifier and starts a range when no anchor exists", () => {
    expect(isNoteSelectionModifierClick({ shiftKey: true })).toBe(true);

    const state = applyNoteSelectionClick(
      { ids: new Set(), anchorId: null },
      sampleNotes.map((note) => note.id),
      {
        id: "note-2",
        shiftKey: true,
      },
    );

    expect([...state.ids]).toEqual(["note-2"]);
    expect(state.anchorId).toBe("note-2");
  });

  test("card thumbnail and snippet extraction", () => {
    const withThumb = sampleNotes.find((n) => n.thumbnail);
    expect(withThumb?.thumbnail?.id).toBe("thumb-1");

    const withoutThumb = sampleNotes.find((n) => !n.thumbnail);
    expect(withoutThumb?.preview).toContain("文人笔墨");
  });
});
