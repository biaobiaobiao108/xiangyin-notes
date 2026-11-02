import { describe, expect, test } from "bun:test";
import {
  collapsingGroupRange,
  partitionVirtualGroupRows,
  stickyGroupOffset,
} from "../app/workspace/group-layout";

test("computes the space removed by a collapsing group without its header", () => {
  const rows = [
    { kind: "group" },
    { kind: "task" },
    { kind: "task" },
    { kind: "group" },
    { kind: "task" },
  ];
  const offsets = [0, 0, 42, 92, 126, 168];
  expect(collapsingGroupRange(rows, offsets, 0)).toEqual({ end: 3, height: 92 });
  expect(collapsingGroupRange(rows, offsets, 3)).toEqual({ end: 5, height: 42 });
  expect(collapsingGroupRange(rows, offsets, undefined)).toBeNull();
});

test("partitions virtual rows into one group clip and relative following rows", () => {
  const visibleRows = [
    { index: 2, top: 70, id: "before" },
    { index: 3, top: 100, id: "header" },
    { index: 4, top: 134, id: "group-a" },
    { index: 5, top: 176, id: "group-b" },
    { index: 8, top: 268, id: "after-a" },
    { index: 9, top: 310, id: "after-b" },
  ];

  const result = partitionVirtualGroupRows(visibleRows, 3, 7, 100, 260);

  expect(result.before.map(({ id }) => id)).toEqual(["before"]);
  expect(result.group.map(({ id, localTop }) => [id, localTop])).toEqual([
    ["group-a", 34],
    ["group-b", 76],
  ]);
  expect(result.after.map(({ id, localTop }) => [id, localTop])).toEqual([
    ["after-a", 8],
    ["after-b", 50],
  ]);

  const partitionedIds = [...result.before, ...result.group, ...result.after].map(({ id }) => id);
  expect(partitionedIds).toEqual(["before", "group-a", "group-b", "after-a", "after-b"]);
  expect(new Set(partitionedIds).size).toBe(partitionedIds.length);
});

describe("virtual sticky group transition", () => {
  test("pushes the current header out as the next group reaches it", () => {
    expect(stickyGroupOffset(undefined, 100, 34)).toBe(0);
    expect(stickyGroupOffset(200, 166, 34)).toBe(0);
    expect(stickyGroupOffset(200, 183, 34)).toBe(-17);
    expect(stickyGroupOffset(200, 200, 34)).toBe(-34);
    expect(stickyGroupOffset(200, 210, 34)).toBe(-34);
  });
});
