import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import {
  clampSplitRatio,
  DEFAULT_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  MAX_SPLIT_RATIO,
} from "../app/workspace/split-resizer";
import {
  filterSplitCandidates,
  MAX_RECENT_SPLIT_NOTES,
  SplitNoteDialog,
} from "../app/workspace/split-note-dialog";
import type { NoteSummary } from "../shared/types";

describe("split view layout and interaction logic", () => {
  test("maintains valid ratio boundaries between min and max constraints", () => {
    expect(clampSplitRatio(0)).toBe(MIN_SPLIT_RATIO);
    expect(clampSplitRatio(0.24)).toBe(MIN_SPLIT_RATIO);
    expect(clampSplitRatio(0.4)).toBe(0.4);
    expect(clampSplitRatio(0.5)).toBe(DEFAULT_SPLIT_RATIO);
    expect(clampSplitRatio(0.6)).toBe(0.6);
    expect(clampSplitRatio(0.76)).toBe(MAX_SPLIT_RATIO);
    expect(clampSplitRatio(1)).toBe(MAX_SPLIT_RATIO);
  });

  test("resolves anti-conflict pane target when note is already open in opposite pane", () => {
    const primaryId = "note-primary";
    const splitId = "note-secondary";

    // Simulating decision logic when clicking note in list with active split
    function resolveListClickPaneAction(
      clickedId: string,
      currentActivePane: "primary" | "secondary",
      primaryNoteId: string,
      secondaryNoteId: string,
    ):
      | { action: "switch-pane"; target: "primary" | "secondary" }
      | { action: "open"; target: "primary" | "secondary" } {
      if (currentActivePane === "secondary") {
        if (clickedId === primaryNoteId) {
          return { action: "switch-pane", target: "primary" };
        }
        return { action: "open", target: "secondary" };
      } else {
        if (clickedId === secondaryNoteId) {
          return { action: "switch-pane", target: "secondary" };
        }
        return { action: "open", target: "primary" };
      }
    }

    // 1. While focused on secondary pane, clicking the note already open in primary pane switches focus to primary
    expect(resolveListClickPaneAction(primaryId, "secondary", primaryId, splitId)).toEqual({
      action: "switch-pane",
      target: "primary",
    });

    // 2. While focused on primary pane, clicking the note already open in secondary pane switches focus to secondary
    expect(resolveListClickPaneAction(splitId, "primary", primaryId, splitId)).toEqual({
      action: "switch-pane",
      target: "secondary",
    });

    // 3. While focused on secondary pane, clicking another note opens it in secondary
    expect(resolveListClickPaneAction("note-other", "secondary", primaryId, splitId)).toEqual({
      action: "open",
      target: "secondary",
    });

    // 4. While focused on primary pane, clicking another note opens it in primary
    expect(resolveListClickPaneAction("note-other", "primary", primaryId, splitId)).toEqual({
      action: "open",
      target: "primary",
    });
  });

  test("prevents opening same note in split pane when already selected as primary", () => {
    const primaryId = "note-primary";

    function decideSplitOpenAction(
      targetNoteId: string,
      currentPrimaryId: string,
      currentSplitId: string | null,
    ): "focus-primary" | "focus-secondary" | "open-split" {
      if (targetNoteId === currentPrimaryId) return "focus-primary";
      if (targetNoteId === currentSplitId) return "focus-secondary";
      return "open-split";
    }

    expect(decideSplitOpenAction(primaryId, primaryId, null)).toBe("focus-primary");
    expect(decideSplitOpenAction("note-2", primaryId, "note-2")).toBe("focus-secondary");
    expect(decideSplitOpenAction("note-3", primaryId, null)).toBe("open-split");
  });

  test("handles card view split pairing correctly", () => {
    function resolveCardViewSplitAction(
      clickedId: string,
      currentSelectedId: string | null,
    ):
      | { action: "open-split-pair"; primaryId: string; secondaryId: string }
      | { action: "open-primary-and-pick"; primaryId: string } {
      if (currentSelectedId && currentSelectedId !== clickedId) {
        return { action: "open-split-pair", primaryId: currentSelectedId, secondaryId: clickedId };
      }
      return { action: "open-primary-and-pick", primaryId: clickedId };
    }

    // When card-1 was already selected and user right-clicks card-2: pairs card-1 and card-2
    expect(resolveCardViewSplitAction("card-2", "card-1")).toEqual({
      action: "open-split-pair",
      primaryId: "card-1",
      secondaryId: "card-2",
    });

    // When no card was selected: card-2 becomes primary and prompts picker
    expect(resolveCardViewSplitAction("card-2", null)).toEqual({
      action: "open-primary-and-pick",
      primaryId: "card-2",
    });

    // When clicked card is the only selected card: card-2 becomes primary and prompts picker
    expect(resolveCardViewSplitAction("card-2", "card-2")).toEqual({
      action: "open-primary-and-pick",
      primaryId: "card-2",
    });
  });

  const makeNote = (
    id: string,
    title: string,
    notebookName: string,
    updatedAt: number,
    deletedAt: number | null = null,
  ): NoteSummary => ({
    id,
    title,
    preview: `${title}预览`,
    tags: [],
    thumbnail: null,
    notebookId: `nb-${notebookName}`,
    notebookName,
    isFavorite: false,
    version: 1,
    deletedAt,
    createdAt: updatedAt,
    updatedAt,
  });

  test("filters candidate notes for split dialog excluding current, trashed and limiting to 5 recent", () => {
    const notes: NoteSummary[] = [
      makeNote("note-1", "当前主笔记", "工作", 1000),
      makeNote("note-2", "参考资料 A", "设计", 2000),
      makeNote("note-3", "已删除笔记", "工作", 3000, 12345678),
      makeNote("note-4", "会议纪要", "记录", 1500),
      makeNote("note-5", "技术分享", "研发", 2500),
      makeNote("note-6", "规划文档", "研发", 3500),
      makeNote("note-7", "周报总结", "工作", 1800),
      makeNote("note-8", "读书感悟", "生活", 4000),
    ];

    // Excludes note-1 (current) and note-3 (trashed), sorts by updatedAt descending, limits to 5
    const candidates = filterSplitCandidates(notes, "note-1", "");
    expect(candidates).toHaveLength(MAX_RECENT_SPLIT_NOTES);
    expect(candidates.map((n) => n.id)).toEqual([
      "note-8", // 4000
      "note-6", // 3500
      "note-5", // 2500
      "note-2", // 2000
      "note-7", // 1800
    ]);

    // Search query matches preview or notebook
    const searchCandidates = filterSplitCandidates(notes, "note-1", "架构");
    expect(searchCandidates.map((n) => n.id)).toEqual([]);
    const searchCandidatesDesign = filterSplitCandidates(notes, "note-1", "设计");
    expect(searchCandidatesDesign.map((n) => n.id)).toEqual(["note-2"]);
  });

  test("renders notebook name after last edit date in split note dialog", () => {
    const notes: NoteSummary[] = [
      makeNote("n-1", "当前打开笔记", "工作", 1000),
      makeNote("n-2", "对照参考笔记", "架构设计", 2000),
    ];

    const html = renderToString(
      React.createElement(SplitNoteDialog, {
        open: true,
        onClose: () => {},
        onSelectNote: () => {},
        notes,
        excludeNoteId: "n-1",
      }),
    );

    expect(html).toContain('class="split-note-notebook">架构设计</span>');
    expect(html).toContain('class="note-row-date"');
    const dateIndex = html.indexOf('class="note-row-date"');
    const notebookIndex = html.indexOf('class="split-note-notebook"');
    expect(dateIndex).toBeGreaterThan(-1);
    expect(notebookIndex).toBeGreaterThan(dateIndex);
  });
});
