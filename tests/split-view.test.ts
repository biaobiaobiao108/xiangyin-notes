import { describe, expect, test } from "bun:test";
import {
  clampSplitRatio,
  DEFAULT_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  MAX_SPLIT_RATIO,
} from "../app/workspace/split-resizer";

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

  test("filters candidate notes for split dialog excluding current and trashed notes", () => {
    const notes = [
      {
        id: "note-1",
        title: "当前主笔记",
        preview: "主笔记内容",
        deletedAt: null,
        notebookName: "工作",
      },
      {
        id: "note-2",
        title: "参考资料 A",
        preview: "架构图设计",
        deletedAt: null,
        notebookName: "设计",
      },
      {
        id: "note-3",
        title: "已删除笔记",
        preview: "垃圾箱笔记",
        deletedAt: 12345678,
        notebookName: "工作",
      },
      {
        id: "note-4",
        title: "会议纪要",
        preview: "周一早会记录",
        deletedAt: null,
        notebookName: "记录",
      },
    ];

    function filterSplitCandidates(list: typeof notes, currentPrimaryId: string, query: string) {
      const available = list.filter((n) => !n.deletedAt && n.id !== currentPrimaryId);
      const trimmed = query.trim().toLowerCase();
      if (!trimmed) return available;
      return available.filter((n) => {
        const titleMatch = (n.title || "").toLowerCase().includes(trimmed);
        const previewMatch = (n.preview || "").toLowerCase().includes(trimmed);
        const notebookMatch = (n.notebookName || "").toLowerCase().includes(trimmed);
        return titleMatch || previewMatch || notebookMatch;
      });
    }

    // Excludes note-1 (current) and note-3 (trashed)
    const allCandidates = filterSplitCandidates(notes, "note-1", "");
    expect(allCandidates.map((n) => n.id)).toEqual(["note-2", "note-4"]);

    // Search query matches preview or notebook
    const searchCandidates = filterSplitCandidates(notes, "note-1", "架构");
    expect(searchCandidates.map((n) => n.id)).toEqual(["note-2"]);
  });
});
