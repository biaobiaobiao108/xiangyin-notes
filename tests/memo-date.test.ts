import { describe, expect, test } from "bun:test";
import {
  buildMonthCells,
  dayBounds,
  groupedByLocalDate,
  localDateKey,
  monthBounds,
  selectedDayCreateTime,
  timelineDateLabel,
} from "../app/memos/memo-date";

describe("memo date helpers", () => {
  test("builds local day and month bounds", () => {
    expect(dayBounds("2026-02-28")).toEqual({
      from: new Date(2026, 1, 28).getTime(),
      to: new Date(2026, 2, 1).getTime(),
    });
    expect(dayBounds("2026-02-30")).toBeNull();
    expect(monthBounds("2024-02")).toMatchObject({
      from: new Date(2024, 1, 1).getTime(),
      to: new Date(2024, 2, 1).getTime(),
    });
    expect(monthBounds("2026-13")).toBeNull();
  });

  test("builds a Monday-first six-week calendar grid", () => {
    const cells = buildMonthCells("2026-11");
    expect(cells).toHaveLength(42);
    expect(cells[0]?.date).toBe(localDateKey(new Date(2026, 9, 26)));
    expect(cells[41]?.date).toBe(localDateKey(new Date(2026, 11, 6)));
    expect(cells.filter((cell) => cell.inMonth)).toHaveLength(30);
  });

  test("labels nearby dates without changing the local calendar day", () => {
    const now = new Date(2026, 10, 13, 12, 0).getTime();
    expect(timelineDateLabel(localDateKey(now), now)).toBe("今天");
    expect(timelineDateLabel(localDateKey(now - 24 * 60 * 60 * 1000), now)).toBe("昨天");
    expect(timelineDateLabel("2025-12-31", now)).toContain("2025年");
  });

  test("keeps the current clock when creating a memo for another day", () => {
    const now = new Date(2026, 10, 13, 15, 42, 9, 123).getTime();
    expect(selectedDayCreateTime("2026-11-13", now)).toBe(now);

    const target = new Date(selectedDayCreateTime("2026-10-02", now));
    expect(localDateKey(target)).toBe("2026-10-02");
    expect([
      target.getHours(),
      target.getMinutes(),
      target.getSeconds(),
      target.getMilliseconds(),
    ]).toEqual([15, 42, 9, 123]);
  });

  test("groups descending memos by their local date", () => {
    const items = [
      { id: "today-late", createdAt: new Date(2026, 10, 13, 18).getTime() },
      { id: "today-early", createdAt: new Date(2026, 10, 13, 8).getTime() },
      { id: "yesterday", createdAt: new Date(2026, 10, 12, 23).getTime() },
    ];
    expect(groupedByLocalDate(items)).toEqual([
      { date: "2026-11-13", items: [items[0], items[1]] },
      { date: "2026-11-12", items: [items[2]] },
    ]);
  });
});
