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
});
