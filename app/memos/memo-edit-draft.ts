export type MemoEditDraft = {
  markdown: string;
  version: number;
  conflict?: boolean;
};

export function memoEditDraftKey(memoId: string) {
  return `xiangying:memo-edit:${memoId}`;
}

export function readMemoEditDraft(memoId: string): MemoEditDraft | null {
  try {
    const value = JSON.parse(localStorage.getItem(memoEditDraftKey(memoId)) ?? "null");
    if (
      !value ||
      typeof value.markdown !== "string" ||
      !Number.isSafeInteger(value.version) ||
      (value.conflict !== undefined && typeof value.conflict !== "boolean")
    )
      return null;
    return {
      markdown: value.markdown,
      version: value.version,
      ...(value.conflict ? { conflict: true } : {}),
    };
  } catch {
    return null;
  }
}

export function writeMemoEditDraft(memoId: string, draft: MemoEditDraft | null) {
  const key = memoEditDraftKey(memoId);
  try {
    if (!draft) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(draft));
  } catch {
    if (draft?.conflict)
      throw new Error("本地存储不可用，无法保留冲突草稿；请先复制草稿内容再继续");
  }
}

export function hasMemoEditDraft(memoId: string) {
  try {
    const value = localStorage.getItem(memoEditDraftKey(memoId));
    return value !== null && value !== "";
  } catch {
    throw new Error("本地存储不可用，无法确认随记草稿状态");
  }
}
