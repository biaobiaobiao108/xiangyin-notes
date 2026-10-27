import { describe, expect, it } from "bun:test";
import { getInitialLetter, getTimelineGroupTitle, groupNotes } from "../app/workspace/helpers";
import type { NoteSummary } from "../shared/types";

function createMockSummary(partial: Partial<NoteSummary>): NoteSummary {
  return {
    id: partial.id || "note-1",
    title: partial.title ?? "测试笔记",
    notebookId: partial.notebookId || "nb-1",
    notebookName: partial.notebookName || "默认",
    createdAt: partial.createdAt ?? Math.floor(Date.now() / 1000),
    updatedAt: partial.updatedAt ?? Math.floor(Date.now() / 1000),
    preview: partial.preview ?? "预览正文",
    isFavorite: partial.isFavorite ?? false,
    thumbnail: partial.thumbnail ?? null,
    tags: partial.tags ?? [],
    version: partial.version ?? 1,
    deletedAt: partial.deletedAt ?? null,
  };
}

describe("时间轴分组与标题分组算法", () => {
  it("正确识别拼音首字母与大写英文字母", () => {
    expect(getInitialLetter("A")).toBe("A");
    expect(getInitialLetter("b")).toBe("B");
    expect(getInitialLetter("周")).toBe("Z");
    expect(getInitialLetter("孙")).toBe("S");
    expect(getInitialLetter("大")).toBe("D");
    expect(getInitialLetter("测")).toBe("C");
    expect(getInitialLetter("1")).toBe("#");
    expect(getInitialLetter("【")).toBe("#");
  });

  it("正确划分时间段", () => {
    // 假设当前时间是 2026-10-30 15:00:00 (周五)
    const fixedNowMs = new Date("2026-10-30T15:00:00+08:00").getTime();
    const fixedNowSeconds = Math.floor(fixedNowMs / 1000);

    // 刚刚/今天
    expect(getTimelineGroupTitle(fixedNowSeconds, fixedNowMs)).toBe("今天");
    // 昨天 (周四 2026-10-29)
    const yesterdaySeconds = fixedNowSeconds - 86400;
    expect(getTimelineGroupTitle(yesterdaySeconds, fixedNowMs)).toBe("昨天");
    // 本周一 (2026-10-26，比昨天更早但在本周内)
    const mondaySeconds = Math.floor(new Date("2026-10-26T10:00:00+08:00").getTime() / 1000);
    expect(getTimelineGroupTitle(mondaySeconds, fixedNowMs)).toBe("本周内");
    // 本月中旬 (2026-10-15，上周但在本月内)
    const earlierThisMonthSeconds = Math.floor(
      new Date("2026-10-15T10:00:00+08:00").getTime() / 1000,
    );
    expect(getTimelineGroupTitle(earlierThisMonthSeconds, fixedNowMs)).toBe("本月内");
    // 上月 (2026-09-15)
    const lastMonthSeconds = Math.floor(new Date("2026-09-15T10:00:00+08:00").getTime() / 1000);
    expect(getTimelineGroupTitle(lastMonthSeconds, fixedNowMs)).toBe("更早");
  });

  it("对笔记列表按时间分组并统计数量", () => {
    const fixedNowMs = new Date("2026-10-27T15:00:00+08:00").getTime();
    const fixedNowSec = Math.floor(fixedNowMs / 1000);

    const notes = [
      createMockSummary({ id: "1", title: "今天写的1", updatedAt: fixedNowSec }),
      createMockSummary({ id: "2", title: "今天写的2", updatedAt: fixedNowSec - 3600 }),
      createMockSummary({ id: "3", title: "昨天写的", updatedAt: fixedNowSec - 86400 }),
      createMockSummary({
        id: "4",
        title: "更早写的",
        updatedAt: Math.floor(new Date("2026-08-01").getTime() / 1000),
      }),
    ];

    const groups = groupNotes(notes, "updated", fixedNowMs);
    expect(groups.length).toBe(3);
    expect(groups[0]?.title).toBe("今天");
    expect(groups[0]?.count).toBe(2);
    expect(groups[1]?.title).toBe("昨天");
    expect(groups[1]?.count).toBe(1);
    expect(groups[2]?.title).toBe("更早");
    expect(groups[2]?.count).toBe(1);
  });

  it("对笔记列表按标题首字母分组", () => {
    const notes = [
      createMockSummary({ id: "1", title: "Apple" }),
      createMockSummary({ id: "2", title: "Banana" }),
      createMockSummary({ id: "3", title: "周文强" }),
      createMockSummary({ id: "4", title: "张三" }),
    ];

    const groups = groupNotes(notes, "title");
    expect(groups.map((g) => g.title)).toEqual(["A", "B", "Z"]);
    expect(groups.find((g) => g.title === "Z")?.count).toBe(2);
  });
});
