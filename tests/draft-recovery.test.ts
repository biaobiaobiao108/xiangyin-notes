import { describe, expect, test } from "bun:test";
import { parseDraftRecovery, serializeDraftRecovery } from "../app/workspace/draft-recovery";
import type { NoteDraft } from "../app/workspace/helpers";

const draft: NoteDraft = {
  id: "note-1",
  version: 3,
  title: "恢复草稿",
  contentMarkdown: "正文",
  notebookId: "inbox-1",
  isFavorite: true,
  deletedAt: null,
};

describe("draft recovery serialization", () => {
  test("round-trips a valid draft and rejects another note id", () => {
    const serialized = serializeDraftRecovery(draft);
    expect(serialized).toBeString();
    expect(parseDraftRecovery(serialized!, draft.id)).toEqual(draft);
    expect(parseDraftRecovery(serialized!, "another-note")).toBeNull();
  });

  test("rejects malformed or oversized drafts", () => {
    expect(parseDraftRecovery("not-json", draft.id)).toBeNull();
    expect(parseDraftRecovery(JSON.stringify({ ...draft, version: 0 }), draft.id)).toBeNull();
    expect(serializeDraftRecovery({ ...draft, contentMarkdown: "字".repeat(2_000_000) })).toBeNull();
  });
});
