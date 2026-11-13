import { describe, expect, test } from "bun:test";
import {
  includePinnedMemo,
  memoDayRowId,
  memoRowId,
  memoRowOffsets,
  memoUsesPageScroller,
  shouldVirtualizeMemoList,
} from "../app/memos/use-virtual-memo-list";
import { flattenMemoGroups } from "../app/memos/use-virtual-memo-list";
import type { Memo } from "../shared/types";

function memo(id: string, createdAt: number): Memo {
  return {
    id,
    contentMarkdown: id,
    createdAt,
    updatedAt: createdAt,
    version: 1,
    tags: [],
  };
}

describe("virtual memo timeline rows", () => {
  test("uses the page scroller at the responsive layout breakpoint", () => {
    expect(memoUsesPageScroller(1320)).toBe(true);
    expect(memoUsesPageScroller(1321)).toBe(false);
  });

  test("keeps the timeline rendering mode stable while a virtualized memo is edited", () => {
    expect(shouldVirtualizeMemoList(30, true)).toBe(true);
    expect(shouldVirtualizeMemoList(1, true, true)).toBe(true);
    expect(shouldVirtualizeMemoList(1, true)).toBe(false);
    expect(shouldVirtualizeMemoList(30, true, false)).toBe(false);
    expect(shouldVirtualizeMemoList(30, false, true)).toBe(false);
  });

  test("keeps an edited memo visible after a page refresh removes it from the loaded page", () => {
    const edited = memo("edited", 2);
    const newest = memo("newest", 3);

    expect(includePinnedMemo([newest], edited)).toEqual([newest, edited]);
    expect(includePinnedMemo([edited, newest], edited)).toEqual([edited, newest]);
    expect(includePinnedMemo([newest], null)).toEqual([newest]);
  });

  test("omits empty groups and keeps the day heading before its memos", () => {
    const first = memo("memo-1", 2);
    const second = memo("memo-2", 1);
    const rows = flattenMemoGroups([
      { date: "2026-11-14", items: [first, second] },
      { date: "2026-11-13", items: [] },
      { date: "2026-11-12", items: [memo("memo-3", 0)] },
    ]);

    expect(rows.map((row) => row.id)).toEqual([
      memoDayRowId("2026-11-14"),
      memoRowId("memo-1"),
      memoRowId("memo-2"),
      memoDayRowId("2026-11-12"),
      memoRowId("memo-3"),
    ]);
    expect(rows[0]).toMatchObject({ kind: "day", first: true });
    expect(rows[3]).toMatchObject({ kind: "day", first: false });
  });

  test("uses measured heights without changing row order", () => {
    const rows = flattenMemoGroups([
      { date: "2026-11-14", items: [memo("memo-1", 2), memo("memo-2", 1)] },
    ]);
    const heights = new Map([
      [rows[0]!.id, 28],
      [rows[1]!.id, 140],
      [rows[2]!.id, 180],
    ]);

    expect(memoRowOffsets(rows, heights)).toEqual([0, 28, 168, 348]);
  });
});
