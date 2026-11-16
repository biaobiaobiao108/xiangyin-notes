import { describe, expect, test } from "bun:test";
import {
  invalidateMemoListRequest,
  mergeMemoPagePreservingLoadedItems,
  memoConflictCurrent,
  reconcileMemoListRefresh,
} from "../app/memos/memo-workspace";
import type { Memo } from "../shared/types";
import { ApiError } from "../app/api";

function memo(id: string, createdAt: number, contentMarkdown = id): Memo {
  return { id, createdAt, updatedAt: createdAt, contentMarkdown, tags: [], version: 1 };
}

describe("memo list request invalidation", () => {
  test("extracts the server version only from a valid memo conflict", () => {
    const latest = memo("one", 4, "saved content");
    expect(
      memoConflictCurrent(
        new ApiError(409, "VERSION_CONFLICT", "冲突", { error: { current: latest } }),
      ),
    ).toEqual(latest);
    expect(
      memoConflictCurrent(
        new ApiError(409, "VERSION_CONFLICT", "冲突", { error: { current: { id: "one" } } }),
      ),
    ).toBeNull();
    expect(
      memoConflictCurrent(new ApiError(500, "OTHER", "错误", { error: { current: latest } })),
    ).toBeNull();
  });
  test("aborts pending list requests and advances the request version", () => {
    const controller = new AbortController();
    const requestRef = { current: 4 };
    const abortRef = { current: controller as AbortController | null };
    const requestId = requestRef.current;

    invalidateMemoListRequest(requestRef, abortRef);

    expect(controller.signal.aborted).toBe(true);
    expect(abortRef.current).toBeNull();
    expect(requestRef.current).toBe(5);
    expect(requestRef.current).not.toBe(requestId);
  });

  test("merges a refreshed first page into loaded pages and uses refreshed rows for duplicates", () => {
    const refreshed = memo("new", 4);
    const olderLoaded = memo("older", 2);
    const refreshedDuplicate = memo("same", 3, "latest content");

    expect(
      mergeMemoPagePreservingLoadedItems(
        [olderLoaded, memo("same", 3, "stale content")],
        [refreshed, refreshedDuplicate],
      ),
    ).toEqual([refreshed, refreshedDuplicate, olderLoaded]);
  });

  test("keeps a null cursor when all previously loaded pages should remain loaded", () => {
    const allLoaded = [memo("older", 2), memo("oldest", 1)];
    const firstPage = [memo("new", 3)];

    expect(reconcileMemoListRefresh(allLoaded, firstPage, null, "fresh-cursor", true)).toEqual({
      memos: [firstPage[0], ...allLoaded],
      nextCursor: null,
    });
  });
});
